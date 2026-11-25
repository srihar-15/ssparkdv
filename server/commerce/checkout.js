import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getCommerceDb, verifyCommerceActor, requireCommercePermission } from './firebase.js';
import { CommerceError, razorpayRequest, shiprocketRate, verifyCheckoutSignature } from './provider.js';
import { readJson, requireSameOrigin } from './http.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN = /^\d{6}$/;
const QUOTE_LIFETIME = 10 * 60 * 1000;
const RESERVATION_LIFETIME = 20 * 60 * 1000;

const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const nowIso = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');

function safeAddress(value) {
  if (!value || typeof value !== 'object') throw new CommerceError(400, 'Enter your delivery address.');
  const address = Object.fromEntries(['name', 'email', 'mobile', 'line1', 'line2', 'city', 'state', 'pincode'].map(key => [key, String(value[key] ?? '').trim()]));
  const digits = address.mobile.replace(/\D/g, '');
  address.mobile = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;
  if (!address.name || address.name.length > 100 || !EMAIL.test(address.email) || address.email.length > 254 ||
      !/^[6-9]\d{9}$/.test(address.mobile) || !address.line1 || address.line1.length > 200 ||
      address.line2.length > 200 || !address.city || address.city.length > 100 ||
      !address.state || address.state.length > 100 || !PIN.test(address.pincode)) {
    throw new CommerceError(400, 'Complete your name, email, mobile number and Indian delivery address.');
  }
  return address;
}

function safeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new CommerceError(400, 'Add a product to your cart.');
  const seen = new Set();
  return items.map(item => {
    const slug = typeof item?.slug === 'string' ? item.slug.trim() : '';
    const qty = item?.qty;
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) || !integer(qty, 1, 99) || seen.has(slug)) {
      throw new CommerceError(400, 'Some cart items are invalid. Refresh your cart and try again.');
    }
    seen.add(slug);
    return { slug, qty };
  });
}

function shippingWeight(items) {
  return items.reduce((sum, item) => sum + item.weightGrams * item.qty, 0);
}

function packageDimensions(items) {
  return { length: Math.max(...items.map(item => Number(item.dimensionsCm.length))),
    width: Math.max(...items.map(item => Number(item.dimensionsCm.width))),
    height: items.reduce((sum, item) => sum + Number(item.dimensionsCm.height) * item.qty, 0) };
}

function promotionTerms(promotion) {
  return JSON.stringify([promotion?.active, promotion?.kind, promotion?.value,
    promotion?.maxUses, promotion?.startAt, promotion?.endAt, promotion?.eligibleSkus]);
}

export function discountFor(promotion, items, at) {
  if (!promotion) return 0;
  if (!promotion.active || (promotion.startAt && promotion.startAt > at) ||
      (promotion.endAt && promotion.endAt <= at) ||
      !['percent', 'fixed'].includes(promotion.kind) || !integer(promotion.value, 1) ||
      !integer(promotion.maxUses ?? 0) ||
      (promotion.maxUses > 0 && (promotion.usedCount ?? 0) + (promotion.reserved ?? 0) >= promotion.maxUses)) {
    throw new CommerceError(400, 'This promotion is unavailable.');
  }
  if (promotion.kind === 'percent' && promotion.value > 10000) throw new CommerceError(503, 'Promotion configuration is invalid.');
  const allowed = Array.isArray(promotion.eligibleSkus) ? promotion.eligibleSkus : [];
  const eligible = allowed.length ? items.filter(item => allowed.includes(item.sku)) : items;
  const subtotalPaise = eligible.reduce((sum, item) => sum + item.linePaise, 0);
  if (!subtotalPaise) throw new CommerceError(400, 'This promotion does not apply to your cart.');
  return Math.min(promotion.kind === 'percent' ? Math.round(subtotalPaise * promotion.value / 10000) : promotion.value, subtotalPaise);
}

export function taxLines(items, discountPaise, originState, deliveryState, allowedSkus = []) {
  const eligible = allowedSkus.length ? items.filter(item => allowedSkus.includes(item.sku)) : items;
  const subtotal = eligible.reduce((sum, item) => sum + item.linePaise, 0);
  const allocations = new Map(items.map(item => [item.sku, 0]));
  if (discountPaise > 0 && subtotal > 0) {
    const shares = eligible.map((item, index) => {
      const scaled = BigInt(discountPaise) * BigInt(item.linePaise);
      const floor = Number(scaled / BigInt(subtotal));
      allocations.set(item.sku, floor);
      return { sku: item.sku, index, fraction: scaled % BigInt(subtotal) };
    });
    let remainder = discountPaise - [...allocations.values()].reduce((sum, value) => sum + value, 0);
    shares.sort((a, b) => a.fraction === b.fraction ? a.index - b.index : a.fraction > b.fraction ? -1 : 1);
    for (let index = 0; index < remainder; index++) allocations.set(shares[index].sku, allocations.get(shares[index].sku) + 1);
  }
  let taxPaise = 0;
  const intraState = originState.trim().toLowerCase() === deliveryState.trim().toLowerCase();
  const taxed = items.map(item => {
    const allocated = allocations.get(item.sku) ?? 0;
    const taxablePaise = item.linePaise - allocated;
    const itemTax = Math.round(taxablePaise * item.gstRateBps / 10000);
    taxPaise += itemTax;
    return { ...item, discountPaise: allocated, taxablePaise, gstPaise: itemTax,
      cgstPaise: intraState ? Math.floor(itemTax / 2) : 0,
      sgstPaise: intraState ? itemTax - Math.floor(itemTax / 2) : 0,
      igstPaise: intraState ? 0 : itemTax };
  });
  return { items: taxed, taxPaise, intraState };
}

export async function quoteOrder(env, body, actor = null) {
  const db = getCommerceDb(env);
  const requested = safeItems(body.items);
  const address = safeAddress(body.address);
  const settingsDoc = await db.collection('settings').doc('commerce').get();
  const settings = settingsDoc.data();
  if (!settings?.gstin || !settings?.originState || !PIN.test(settings.pickupPincode ?? '') ||
      !settings.shiprocketPickupLocation) {
    throw new CommerceError(503, 'Checkout settings are incomplete. Please contact our team.');
  }
  const refs = requested.map(item => db.collection('publishedProducts').doc(item.slug));
  const docs = await db.getAll(...refs);
  const items = [];
  for (let index = 0; index < requested.length; index++) {
    const product = docs[index].data();
    const qty = requested[index].qty;
    if (!product || product.status !== 'published' || product.purchaseMode !== 'online' ||
        !product.sku || !integer(product.pricePaise, 1) || !integer(product.gstRateBps, 0, 10000) ||
        !product.hsn || !integer(product.weightGrams, 1) || !product.dimensionsCm ||
        ['length', 'width', 'height'].some(key => !Number.isFinite(Number(product.dimensionsCm[key])) || Number(product.dimensionsCm[key]) <= 0.5)) {
      throw new CommerceError(409, 'A product is unavailable for online purchase. Refresh your cart.');
    }
    const stock = (await db.collection('inventory').doc(product.sku).get()).data();
    if (!stock || !integer(stock.onHand) || !integer(stock.reserved) || stock.onHand - stock.reserved < qty) {
      throw new CommerceError(409, `${product.name} is out of stock or the quantity changed.`);
    }
    items.push({ slug: requested[index].slug, sku: product.sku, name: product.name, variant: product.variant ?? null,
      qty, pricePaise: product.pricePaise, price: product.pricePaise / 100, img: product.img ?? '',
      photo: product.shareImage ?? product.img ?? '', hsn: product.hsn, gstRateBps: product.gstRateBps,
      weightGrams: product.weightGrams, dimensionsCm: product.dimensionsCm,
      linePaise: product.pricePaise * qty, catalogVersion: product.version ?? 1 });
  }
  const subtotalPaise = items.reduce((sum, item) => sum + item.linePaise, 0);
  const promoCode = typeof body.promoCode === 'string' ? body.promoCode.trim().toUpperCase() : '';
  if (promoCode && !/^[A-Z0-9_-]{3,32}$/.test(promoCode)) throw new CommerceError(400, 'Invalid promotion code.');
  const promotion = promoCode ? (await db.collection('promotions').doc(promoCode).get()).data() : null;
  if (promoCode && !promotion) throw new CommerceError(400, 'This promotion is unavailable.');
  const discountPaise = discountFor(promotion, items, nowIso());
  const taxed = taxLines(items, discountPaise, settings.originState, address.state, promotion?.eligibleSkus ?? []);
  const dimensions = packageDimensions(items);
  const rate = await shiprocketRate(env, { pickupPincode: settings.pickupPincode, deliveryPincode: address.pincode,
    weightGrams: shippingWeight(items), dimensionsCm: dimensions,
    declaredValuePaise: subtotalPaise - discountPaise + taxed.taxPaise });
  const shippingPaise = rate.shippingPaise + (settings.shippingMarkupPaise ?? 0);
  if (!integer(shippingPaise) || !integer(settings.shippingGstRateBps ?? 0, 0, 10000)) throw new CommerceError(503, 'Shipping tax configuration is invalid.');
  const shippingTaxPaise = Math.round(shippingPaise * (settings.shippingGstRateBps ?? 0) / 10000);
  const shippingCgstPaise = taxed.intraState ? Math.floor(shippingTaxPaise / 2) : 0;
  const shippingSgstPaise = taxed.intraState ? shippingTaxPaise - shippingCgstPaise : 0;
  const quote = {
    id: randomUUID(), customerUid: actor?.uid ?? null, address, items: taxed.items, promoCode: promoCode || null,
    promoTermsHash: promotion ? hash(promotionTerms(promotion)) : null,
    subtotalPaise, discountPaise, taxPaise: taxed.taxPaise, shippingPaise, shippingTaxPaise,
    shippingCgstPaise, shippingSgstPaise, shippingIgstPaise: taxed.intraState ? 0 : shippingTaxPaise,
    totalPaise: subtotalPaise - discountPaise + taxed.taxPaise + shippingPaise + shippingTaxPaise,
    carrier: rate.carrier, courierId: rate.courierId, estimatedDays: rate.estimatedDays,
    packageDimensionsCm: dimensions,
    pickupPincode: settings.pickupPincode, pickupAddress: settings.pickupAddress ?? null,
    shiprocketPickupLocation: settings.shiprocketPickupLocation,
    originState: settings.originState, gstin: settings.gstin, settingsVersion: settings.updatedAt ?? null,
    createdAt: nowIso(), expiresAt: new Date(Date.now() + QUOTE_LIFETIME).toISOString(),
  };
  await db.collection('quotes').doc(quote.id).set(quote);
  const { pickupAddress, shiprocketPickupLocation, settingsVersion, promoTermsHash, customerUid, ...publicQuote } = quote;
  return publicQuote;
}

function guestToken(req, res, deployed) {
  const name = 'sparkdv_guest_session';
  const fromCookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const token = /^[a-f0-9]{64}$/.test(fromCookie ?? '') ? fromCookie : randomBytes(32).toString('hex');
  if (token !== fromCookie) res.setHeader('Set-Cookie', `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${deployed ? '; Secure' : ''}`);
  return token;
}

export async function ensureProviderOrder(env, order, request = razorpayRequest) {
  async function findProviderOrder() {
    const result = await request(env, `orders?receipt=${encodeURIComponent(order.id)}&count=100`);
    return result.items?.find(item => item.receipt === order.id) ?? null;
  }
  let provider = await findProviderOrder();
  if (!provider) {
    try { provider = await request(env, 'orders', 'POST', {
      amount: order.totalPaise, currency: 'INR', receipt: order.id, notes: { sparkdv_order_id: order.id },
    }); }
    catch (error) {
      provider = await findProviderOrder().catch(() => null);
      if (!provider) throw error;
    }
  }
  if (provider.amount !== order.totalPaise || provider.currency !== 'INR') {
    throw new CommerceError(409, 'Payment amount changed. Contact support with your order reference.');
  }
  return provider;
}

export async function createPaymentOrder(env, body, actor, req, res, deployed) {
  const db = getCommerceDb(env);
  const quoteId = body.quoteId;
  const id = body.id || randomUUID();
  if (!UUID.test(id) || !UUID.test(quoteId ?? '')) throw new CommerceError(400, 'Invalid checkout reference.');
  const token = actor ? null : guestToken(req, res, deployed);
  const orderRef = db.collection('orders').doc(id);
  const quoteRef = db.collection('quotes').doc(quoteId);
  let order = await db.runTransaction(async tx => {
    const existing = await tx.get(orderRef);
    if (existing.exists) {
      if (existing.data().quoteId !== quoteId) throw new CommerceError(409, 'This checkout reference belongs to another order.');
      if (!orderAccess(req, existing.data(), actor)) throw new CommerceError(404, 'Order not found.');
      if (existing.data().status === 'cancelled' || existing.data().paymentStatus === 'expired' ||
          (existing.data().paymentStatus === 'pending' && existing.data().reservationExpiresAt <= nowIso())) {
        throw new CommerceError(409, 'This payment attempt expired or was cancelled. Start a new checkout.');
      }
      return existing.data();
    }
    const snapshot = await tx.get(quoteRef);
    const quote = snapshot.data();
    if (!quote || quote.expiresAt <= nowIso() || quote.consumedBy ||
        (quote.customerUid && quote.customerUid !== actor?.uid)) {
      throw new CommerceError(409, 'This quote expired. Refresh delivery rates and try again.');
    }
    const inventory = [];
    const catalog = [];
    for (const item of quote.items) {
      const ref = db.collection('inventory').doc(item.sku);
      inventory.push({ item, ref, snap: await tx.get(ref) });
      catalog.push({ item, snap: await tx.get(db.collection('publishedProducts').doc(item.slug)) });
    }
    const settingsSnap = await tx.get(db.collection('settings').doc('commerce'));
    if (!settingsSnap.exists || (settingsSnap.data().updatedAt ?? null) !== quote.settingsVersion) {
      throw new CommerceError(409, 'Checkout settings changed. Refresh your delivery quote.');
    }
    for (const { item, snap } of catalog) {
      const product = snap.data();
      if (!product || product.status !== 'published' || product.purchaseMode !== 'online' ||
          product.sku !== item.sku || product.version !== item.catalogVersion ||
          product.pricePaise !== item.pricePaise || product.gstRateBps !== item.gstRateBps) {
        throw new CommerceError(409, `${item.name} changed. Refresh your delivery quote.`);
      }
    }
    const promoRef = quote.promoCode ? db.collection('promotions').doc(quote.promoCode) : null;
    const promoSnap = promoRef ? await tx.get(promoRef) : null;
    if (promoRef && (!promoSnap?.exists || hash(promotionTerms(promoSnap.data())) !== quote.promoTermsHash ||
        promoSnap.data().active !== true || (promoSnap.data().endAt && promoSnap.data().endAt <= nowIso()) ||
        (promoSnap.data().maxUses > 0 && (promoSnap.data().usedCount ?? 0) + (promoSnap.data().reserved ?? 0) >= promoSnap.data().maxUses))) {
      throw new CommerceError(409, 'This promotion reached its limit. Refresh your quote.');
    }
    for (const { item, ref, snap } of inventory) {
      const stock = snap.data();
      if (!stock || stock.onHand - stock.reserved < item.qty) throw new CommerceError(409, `${item.name} is no longer available in that quantity.`);
      tx.update(ref, { reserved: stock.reserved + item.qty, updatedAt: nowIso() });
    }
    if (promoRef) tx.update(promoRef, { reserved: (promoSnap.data().reserved ?? 0) + 1 });
    const created = {
      ...quote, id, quoteId, customerUid: actor?.uid ?? null, guestTokenHash: token ? hash(token) : null,
      status: 'placed', payment_status: 'pending', paymentStatus: 'pending', reservationState: 'reserved',
      subtotal: quote.subtotalPaise / 100, created_at: nowIso(), createdAt: nowIso(),
      reservationExpiresAt: new Date(Date.now() + RESERVATION_LIFETIME).toISOString(),
      events: [{ seq: 1, status: 'placed', created_at: nowIso(), carrier: null, tracking_number: null, tracking_url: null }],
      payment_events: [],
    };
    tx.create(orderRef, created);
    tx.update(quoteRef, { consumedBy: id });
    return created;
  });
  try {
    const { enqueueReservationExpiry } = await import('./fulfillment.js');
    await enqueueReservationExpiry(env, id, order.reservationExpiresAt);
  } catch (error) {
    console.error('Reservation expiry enqueue failed:', error.code ?? error.name);
  }
  const paymentRef = db.collection('payments').doc(id);
  let payment = (await paymentRef.get()).data();
  if (!payment?.razorpayOrderId) {
    // Razorpay treats receipt as unique. Read it first so a provider success
    // followed by a Firestore write failure is recovered on retry.
    const provider = await ensureProviderOrder(env, order);
    await paymentRef.create({ orderId: id, razorpayOrderId: provider.id, amountPaise: order.totalPaise,
      currency: 'INR', status: 'pending', createdAt: nowIso() }).catch(async error => {
      if (error.code !== 6 && error.code !== 'already-exists') throw error;
    });
    payment = (await paymentRef.get()).data();
  }
  return { order: publicOrder(order), payment: { key: env.RAZORPAY_KEY_ID, order_id: payment.razorpayOrderId,
    amount: payment.amountPaise, currency: 'INR', paid: payment.status === 'paid',
    test: env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') ?? false } };
}

export function publicOrder(order, staff = false) {
  const { guestTokenHash, pickupAddress, shiprocketPickupLocation, promoTermsHash, settingsVersion, ...safe } = order;
  if (!staff) delete safe.customerUid;
  return { ...safe, customer: { name: order.address?.name, email: order.address?.email, mobile: order.address?.mobile },
    items: order.items?.map(item => ({ ...item, price: item.pricePaise / 100 })) ?? [] };
}

export function orderAccess(req, order, actor) {
  if (actor?.uid && actor.uid === order.customerUid) return true;
  const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('sparkdv_guest_session='))?.slice('sparkdv_guest_session='.length);
  if (!/^[a-f0-9]{64}$/.test(cookie ?? '') || !/^[a-f0-9]{64}$/.test(order.guestTokenHash ?? '')) return false;
  return timingSafeEqual(Buffer.from(hash(cookie), 'hex'), Buffer.from(order.guestTokenHash, 'hex'));
}

export async function readCommerceBody(req, limit = 32768) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new CommerceError(413, 'Request is too large.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CommerceError(400, 'Invalid JSON request.'); }
}

export async function applyProviderPayment(env, paymentEntity, eventId, source = 'provider') {
  if (!/^pay_[a-zA-Z0-9]+$/.test(paymentEntity?.id ?? '') ||
      !/^order_[a-zA-Z0-9]+$/.test(paymentEntity?.order_id ?? '') ||
      !integer(paymentEntity.amount, 1) || paymentEntity.currency !== 'INR') {
    throw new CommerceError(400, 'Payment does not match an order.');
  }
  const db = getCommerceDb(env);
  const matches = await db.collection('payments').where('razorpayOrderId', '==', paymentEntity.order_id).limit(1).get();
  if (matches.empty) throw new CommerceError(503, 'Payment mapping is not available yet.');
  const paymentRef = matches.docs[0].ref;
  const orderRef = db.collection('orders').doc(matches.docs[0].id);
  const eventRef = db.collection('providerEvents').doc(eventId);
  const result = await db.runTransaction(async tx => {
    const [paymentSnap, orderSnap, eventSnap] = await Promise.all([tx.get(paymentRef), tx.get(orderRef), tx.get(eventRef)]);
    if (eventSnap.exists) {
      const current = orderSnap.data();
      return { order: current, changed: false, retryFulfillment: current?.paymentStatus === 'paid' &&
        ['queued', 'queue_failed'].includes(current.fulfillmentStatus) };
    }
    const payment = paymentSnap.data();
    const order = orderSnap.data();
    if (!order || !payment || payment.razorpayOrderId !== paymentEntity.order_id ||
        payment.amountPaise !== paymentEntity.amount || order.totalPaise !== payment.amountPaise) {
      throw new CommerceError(400, 'Payment amount or order reference does not match.');
    }
    const captured = paymentEntity.status === 'captured';
    const inventory = [];
    let promotion;
    if (captured && payment.status !== 'paid') {
      for (const item of order.items) {
        const ref = db.collection('inventory').doc(item.sku);
        inventory.push({ item, ref, snap: await tx.get(ref) });
      }
      if (order.promoCode) {
        const ref = db.collection('promotions').doc(order.promoCode);
        promotion = { ref, snap: await tx.get(ref) };
      }
    }
    const recordedAt = nowIso();
    const event = { event_id: eventId, payment_id: paymentEntity.id, kind: `payment.${paymentEntity.status}`,
      source, occurred_at: Number.isFinite(paymentEntity.created_at) ? new Date(paymentEntity.created_at * 1000).toISOString() : recordedAt };
    tx.create(eventRef, { ...event, orderId: order.id, receivedAt: recordedAt });
    const history = [...(order.payment_events ?? []), event].slice(-100);
    if (!captured || payment.status === 'paid') {
      tx.update(orderRef, { payment_events: history });
      return { order, changed: false, retryFulfillment: payment.status === 'paid' &&
        ['queued', 'queue_failed'].includes(order.fulfillmentStatus) };
    }
    const reservationActive = order.reservationState === 'reserved' || !order.reservationState;
    let stockReady = order.status !== 'cancelled';
    if (order.promoCode && (!promotion?.snap.exists || (!reservationActive &&
        promotion.snap.data().maxUses > 0 &&
        (promotion.snap.data().usedCount ?? 0) + (promotion.snap.data().reserved ?? 0) >= promotion.snap.data().maxUses))) {
      stockReady = false;
    }
    for (const { item, snap } of inventory) {
      const stock = snap.data();
      if (!stock || (reservationActive ? stock.reserved < item.qty || stock.onHand < item.qty : stock.onHand - stock.reserved < item.qty)) {
        stockReady = false;
      }
    }
    if (stockReady) {
      for (const { item, ref, snap } of inventory) {
        const stock = snap.data();
        tx.update(ref, { onHand: stock.onHand - item.qty,
          reserved: reservationActive ? stock.reserved - item.qty : stock.reserved, updatedAt: recordedAt });
        tx.create(db.collection('inventoryMovements').doc(), { sku: item.sku, orderId: order.id,
          delta: -item.qty, kind: 'sale', at: recordedAt });
      }
      if (promotion?.snap.exists) {
        const promo = promotion.snap.data();
        tx.update(promotion.ref, { reserved: Math.max(0, (promo.reserved ?? 0) - (reservationActive ? 1 : 0)),
          usedCount: (promo.usedCount ?? 0) + 1 });
      }
    } else if (reservationActive) {
      for (const { item, ref, snap } of inventory) if (snap.exists) {
        tx.update(ref, { reserved: Math.max(0, (snap.data().reserved ?? 0) - item.qty), updatedAt: recordedAt });
      }
      if (promotion?.snap.exists) tx.update(promotion.ref, {
        reserved: Math.max(0, (promotion.snap.data().reserved ?? 0) - 1),
      });
    }
    const nextStatus = order.status === 'cancelled' ? 'cancelled' : stockReady ? 'confirmed' : 'placed';
    const fulfillmentStatus = order.status === 'cancelled' ? 'payment_exception' : stockReady ? 'queued' : 'stock_exception';
    const events = stockReady ? [...(order.events ?? []), { seq: (order.events?.length ?? 0) + 1,
      status: 'confirmed', created_at: recordedAt, carrier: null, tracking_number: null, tracking_url: null }] : order.events;
    tx.update(paymentRef, { status: 'paid', paymentId: paymentEntity.id, paidAt: recordedAt });
    tx.update(orderRef, { payment_status: 'paid', paymentStatus: 'paid', paidAt: recordedAt,
      paymentId: paymentEntity.id, reservationState: stockReady ? 'consumed' : 'released',
      fulfillmentStatus, status: nextStatus,
      payment_events: history, events });
    return { order: { ...order, payment_status: 'paid', status: nextStatus, fulfillmentStatus }, changed: true, stockReady };
  });
  if ((result.changed && result.stockReady) || result.retryFulfillment) {
    const { enqueueFulfillment } = await import('./fulfillment.js');
    try { await enqueueFulfillment(env, result.order.id); }
    catch (error) {
      console.error('Fulfillment enqueue failed:', error.code ?? error.name);
      await orderRef.update({ fulfillmentStatus: 'queue_failed' });
      if (source === 'webhook') throw new CommerceError(503, 'Fulfillment task queue is unavailable.');
    }
  }
  return result;
}

export async function applyProviderRefund(env, refundEntity, eventId) {
  if (!UUID.test(refundEntity?.receipt ?? '') || !/^rfnd_[a-zA-Z0-9]+$/.test(refundEntity?.id ?? '') ||
      !/^pay_[a-zA-Z0-9]+$/.test(refundEntity?.payment_id ?? '') ||
      !integer(refundEntity.amount, 1) || !['pending', 'processed', 'failed'].includes(refundEntity.status)) {
    throw new CommerceError(400, 'Refund event is invalid.');
  }
  const db = getCommerceDb(env);
  const refundRef = db.collection('refunds').doc(refundEntity.receipt);
  const eventRef = db.collection('providerEvents').doc(eventId);
  await db.runTransaction(async tx => {
    const [refundSnap, eventSnap] = await Promise.all([tx.get(refundRef), tx.get(eventRef)]);
    if (eventSnap.exists) return;
    const refund = refundSnap.data();
    if (!refund) throw new CommerceError(503, 'Refund mapping is not available yet.');
    if (refund.paymentId !== refundEntity.payment_id || refund.amountPaise !== refundEntity.amount ||
        (refund.refundId && refund.refundId !== refundEntity.id)) throw new CommerceError(400, 'Refund event does not match request.');
    const paymentRef = db.collection('payments').doc(refund.orderId);
    const payment = (await tx.get(paymentRef)).data();
    if (!payment || payment.paymentId !== refundEntity.payment_id) throw new CommerceError(400, 'Refund payment is not mapped.');
    tx.create(eventRef, { provider: 'razorpay', kind: `refund.${refundEntity.status}`,
      refundId: refundEntity.id, orderId: refund.orderId, at: nowIso() });
    const status = ['processed', 'failed'].includes(refund.status) ? refund.status : refundEntity.status;
    tx.update(refundRef, { refundId: refundEntity.id, status, updatedAt: nowIso() });
    if (payment.refundId === refundEntity.id) tx.update(paymentRef, { refundStatus: status });
  });
}

export async function releaseExpiredReservations(env, max = 100) {
  const db = getCommerceDb(env);
  const expired = await db.collection('orders').where('paymentStatus', '==', 'pending')
    .where('reservationExpiresAt', '<=', nowIso()).limit(max).get();
  let released = 0;
  for (const doc of expired.docs) {
    if (await releaseOrderReservation(env, doc.id)) released++;
  }
  return released;
}

export async function releaseOrderReservation(env, id) {
  if (!UUID.test(id ?? '')) throw new CommerceError(400, 'Invalid order reference.');
  const db = getCommerceDb(env);
  const orderRef = db.collection('orders').doc(id);
  return db.runTransaction(async tx => {
      const orderSnap = await tx.get(orderRef);
      const order = orderSnap.data();
      if (!order || order.paymentStatus !== 'pending' || order.reservationState === 'released' ||
          order.reservationExpiresAt > nowIso()) return false;
      const stocks = [];
      for (const item of order.items) stocks.push({ item, ref: db.collection('inventory').doc(item.sku),
        snap: await tx.get(db.collection('inventory').doc(item.sku)) });
      const promoRef = order.promoCode ? db.collection('promotions').doc(order.promoCode) : null;
      const promo = promoRef ? await tx.get(promoRef) : null;
      for (const { item, ref, snap } of stocks) if (snap.exists) {
        tx.update(ref, { reserved: Math.max(0, (snap.data().reserved ?? 0) - item.qty), updatedAt: nowIso() });
      }
      if (promo?.exists) tx.update(promoRef, { reserved: Math.max(0, (promo.data().reserved ?? 0) - 1) });
      tx.update(orderRef, { reservationState: 'released', paymentStatus: 'expired', payment_status: 'unpaid' });
      return true;
  }
  );
}

async function readOrder(env, req, actor, id, staff = false) {
  if (!UUID.test(id ?? '')) throw new CommerceError(404, 'Order not found.');
  const snap = await getCommerceDb(env).collection('orders').doc(id).get();
  if (!snap.exists) throw new CommerceError(404, 'Order not found.');
  const order = snap.data();
  if (!staff && !orderAccess(req, order, actor)) throw new CommerceError(404, 'Order not found.');
  const visible = publicOrder(order, staff);
  if (staff) {
    const refunds = await getCommerceDb(env).collection('refunds').where('orderId', '==', id).limit(100).get();
    visible.refunds = refunds.docs.map(doc => ({ id: doc.id, amountPaise: doc.data().amountPaise,
      status: doc.data().status, refundId: doc.data().refundId ?? null,
      reason: doc.data().reason, requestedAt: doc.data().requestedAt }))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }
  return visible;
}

export function createOrdersHandler(env = process.env, deployed = false) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new CommerceError(405, 'Method not allowed.');
      if (req.method === 'POST') requireSameOrigin(req);
      const actor = await verifyCommerceActor(req, env);
      const params = new URL(req.url, 'http://local').searchParams;
      if (req.method === 'GET') {
        const staff = params.get('staff') === '1';
        if (staff) await requireCommercePermission(req, 'orders.read', env);
        if (params.has('id')) return send(200, { order: await readOrder(env, req, actor, params.get('id'), staff) });
        if (!staff && !actor) throw new CommerceError(401, 'Sign in to view your orders.');
        const page = Number(params.get('page') || 1);
        if (!integer(page, 1, 100)) throw new CommerceError(400, 'Invalid page.');
        let query = getCommerceDb(env).collection('orders');
        if (!staff) query = query.where('customerUid', '==', actor.uid);
        const result = await query.orderBy('createdAt', 'desc').limit(21).offset((page - 1) * 20).get();
        return send(200, { orders: result.docs.slice(0, 20).map(doc => publicOrder(doc.data(), staff)), hasMore: result.size > 20, pushKey: null });
      }
      const body = await readJson(req, 32768);
      if (body.action === 'quote') return send(200, { quote: await quoteOrder(env, body, actor) });
      if (body.action === 'start-payment') return send(200, await createPaymentOrder(env, body, actor, req, res, deployed));
      if (body.action === 'verify-payment') {
        const order = await readOrder(env, req, actor, body.id);
        const saved = (await getCommerceDb(env).collection('payments').doc(body.id).get()).data();
        if (!saved || !verifyCheckoutSignature(env, saved.razorpayOrderId, body.razorpay_payment_id, body.razorpay_signature) ||
            saved.razorpayOrderId !== body.razorpay_order_id) throw new CommerceError(400, 'Payment confirmation could not be verified.');
        const remote = await razorpayRequest(env, `payments/${body.razorpay_payment_id}`);
        if (remote.status !== 'captured') throw new CommerceError(409, 'Payment is processing. Check this order shortly.');
        await applyProviderPayment(env, remote, `verify:${remote.id}:${remote.status}`, 'provider-api');
        return send(200, { order: await readOrder(env, req, actor, order.id) });
      }
      if (body.action === 'payment-attempt') return send(200, { recorded: true });
      if (body.action === 'checkpoint') {
        await requireCommercePermission(req, 'orders.manage', env);
        if (!UUID.test(body.id ?? '')) throw new CommerceError(400, 'Invalid order reference.');
        const ref = getCommerceDb(env).collection('orders').doc(body.id ?? 'invalid');
        const updated = await getCommerceDb(env).runTransaction(async tx => {
          const snap = await tx.get(ref);
          const current = snap.data();
          if (!current) throw new CommerceError(404, 'Order not found.');
          if (current.status !== body.expected) throw new CommerceError(409, 'Order changed. Refresh before updating it.');
          const next = { placed: 'confirmed', confirmed: 'dispatched', dispatched: 'out_for_delivery', out_for_delivery: 'delivered' };
          if (body.status !== 'cancelled' && next[current.status] !== body.status) throw new CommerceError(400, 'Invalid checkpoint.');
          if (body.status === 'cancelled' && ['dispatched', 'out_for_delivery', 'delivered', 'cancelled'].includes(current.status)) {
            throw new CommerceError(409, 'This order cannot be cancelled at its current shipping stage.');
          }
          if (body.status !== 'cancelled' && current.paymentStatus !== 'paid') throw new CommerceError(409, 'Payment is not confirmed.');
          if (body.status === 'cancelled' && current.paymentStatus === 'paid') {
            const payment = (await tx.get(getCommerceDb(env).collection('payments').doc(body.id))).data();
            if (!['pending', 'processed'].includes(payment?.refundStatus) || payment.refundAmountPaise !== current.totalPaise) {
              throw new CommerceError(409, 'A full refund must be requested before cancelling a paid order.');
            }
            if (!['queued', 'queue_failed'].includes(current.fulfillmentStatus)) {
              throw new CommerceError(409, 'The shipment has entered booking. Contact the courier before cancelling.');
            }
          }
          const release = [];
          let promo;
          if (body.status === 'cancelled' && current.paymentStatus === 'pending' && current.reservationState === 'reserved') {
            for (const item of current.items) {
              const stockRef = getCommerceDb(env).collection('inventory').doc(item.sku);
              release.push({ item, ref: stockRef, snap: await tx.get(stockRef) });
            }
            if (current.promoCode) {
              const promoRef = getCommerceDb(env).collection('promotions').doc(current.promoCode);
              promo = { ref: promoRef, snap: await tx.get(promoRef) };
            }
          }
          const carrier = String(body.carrier ?? '').trim().slice(0, 100) || null;
          const trackingNumber = String(body.trackingNumber ?? '').trim().slice(0, 100) || null;
          const trackingUrl = String(body.trackingUrl ?? '').trim();
          if (trackingUrl && (!/^https:\/\//i.test(trackingUrl) || trackingUrl.length > 500)) {
            throw new CommerceError(400, 'Tracking URL must be an HTTPS link.');
          }
          const event = { seq: (current.events?.length ?? 0) + 1, status: body.status, created_at: nowIso(),
            carrier, tracking_number: trackingNumber, tracking_url: trackingUrl || null };
          for (const { item, ref: stockRef, snap: stockSnap } of release) if (stockSnap.exists) {
            tx.update(stockRef, { reserved: Math.max(0, (stockSnap.data().reserved ?? 0) - item.qty), updatedAt: nowIso() });
          }
          if (promo?.snap.exists) tx.update(promo.ref, { reserved: Math.max(0, (promo.snap.data().reserved ?? 0) - 1) });
          const patch = { status: body.status, events: [...(current.events ?? []), event],
            ...(release.length ? { paymentStatus: 'cancelled', payment_status: 'unpaid', reservationState: 'released' } : {}) };
          tx.update(ref, patch);
          return { ...current, ...patch };
        });
        if (['dispatched', 'out_for_delivery', 'delivered'].includes(updated.status)) {
          const { notifyCustomer } = await import('./fulfillment.js');
          try { await notifyCustomer(env, updated, updated.status); }
          catch (error) { console.warn('Order checkpoint email failed:', error.message); }
        }
        return send(200, { order: publicOrder(updated, true) });
      }
      if (body.action === 'refund') {
        await requireCommercePermission(req, 'refunds.manage', env);
        const id = body.id;
        const requestId = body.requestId;
        if (!UUID.test(id ?? '') || !UUID.test(requestId ?? '')) throw new CommerceError(400, 'Invalid refund reference.');
        const db = getCommerceDb(env);
        const paymentRef = db.collection('payments').doc(id);
        const payment = (await paymentRef.get()).data();
        if (!payment?.paymentId || payment.status !== 'paid') throw new CommerceError(409, 'There is no captured payment to refund.');
        const amount = body.amountPaise ?? payment.amountPaise;
        if (!integer(amount, 1, payment.amountPaise)) throw new CommerceError(400, 'Invalid refund amount.');
        const reason = String(body.reason ?? '').trim().slice(0, 200);
        if (!reason) throw new CommerceError(400, 'Enter a refund reason.');
        const refundRef = db.collection('refunds').doc(requestId);
        await db.runTransaction(async tx => {
          const existing = await tx.get(refundRef);
          if (existing.exists) {
            if (existing.data().orderId !== id || existing.data().amountPaise !== amount) {
              throw new CommerceError(409, 'Refund reference was already used.');
            }
          } else tx.create(refundRef, { orderId: id, paymentId: payment.paymentId, amountPaise: amount,
            reason, receipt: requestId, status: 'requested', requestedAt: nowIso() });
        });
        const saved = (await refundRef.get()).data();
        if (saved.refundId) return send(200, { refund: { id: saved.refundId, status: saved.status } });
        async function findProviderRefund() {
          const result = await razorpayRequest(env, `payments/${payment.paymentId}/refunds?count=100`);
          return result.items?.find(item => item.receipt === requestId) ?? null;
        }
        let refund = await findProviderRefund();
        if (!refund) {
          try { refund = await razorpayRequest(env, `payments/${payment.paymentId}/refund`, 'POST', {
            amount, receipt: requestId, notes: { sparkdv_order_id: id, reason },
          }); }
          catch (error) {
            refund = await findProviderRefund().catch(() => null);
            if (!refund) throw error;
          }
        }
        const finalStatus = await db.runTransaction(async tx => {
          const [refundSnap, paymentSnap] = await Promise.all([tx.get(refundRef), tx.get(paymentRef)]);
          const currentRefund = refundSnap.data();
          if (currentRefund.refundId && currentRefund.refundId !== refund.id) {
            throw new CommerceError(409, 'Refund reference does not match the provider.');
          }
          const status = ['processed', 'failed'].includes(currentRefund.status)
            ? currentRefund.status : refund.status ?? 'pending';
          tx.update(refundRef, { refundId: refund.id, status, submittedAt: nowIso() });
          if (!paymentSnap.data().refundId || paymentSnap.data().refundId === refund.id || amount === payment.amountPaise) {
            tx.update(paymentRef, { refundStatus: status, refundId: refund.id,
              refundAmountPaise: amount, refundRequestedAt: nowIso() });
          }
          return status;
        });
        return send(200, { refund: { id: refund.id, status: finalStatus } });
      }
      throw new CommerceError(400, 'Unknown order action.');
    } catch (error) {
      if (error.status) return send(error.status, { error: error.message });
      console.error('Commerce order error:', error.code ?? error.name, error.message);
      return send(503, { error: 'Checkout is unavailable. Please try again shortly.' });
    }
  };
}
