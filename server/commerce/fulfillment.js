import { createHash, timingSafeEqual } from 'node:crypto';
import { getCommerceDb } from './firebase.js';
import { CommerceError, shiprocketRequest } from './provider.js';
import { readCommerceBody, releaseExpiredReservations } from './checkout.js';

const nowIso = () => new Date().toISOString();

export async function enqueueFulfillment(env, orderId) {
  if (!env.COMMERCE_WORKER_URL || !env.COMMERCE_TASKS_QUEUE || !env.COMMERCE_TASKS_SERVICE_ACCOUNT || !env.GOOGLE_CLOUD_PROJECT) {
    throw new CommerceError(503, 'Fulfillment task queue is not configured.');
  }
  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const client = new CloudTasksClient();
  const region = env.COMMERCE_TASKS_REGION || 'asia-south1';
  const parent = client.queuePath(env.GOOGLE_CLOUD_PROJECT, region, env.COMMERCE_TASKS_QUEUE);
  const workerUrl = `${env.COMMERCE_WORKER_URL.replace(/\/$/, '')}/internal/fulfillment`;
  const task = {
    name: `${parent}/tasks/fulfill-${orderId}`,
    httpRequest: {
      httpMethod: 'POST',
      url: workerUrl,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ action: 'fulfill', orderId })).toString('base64'),
      oidcToken: { serviceAccountEmail: env.COMMERCE_TASKS_SERVICE_ACCOUNT, audience: workerUrl },
    },
  };
  try { await client.createTask({ parent, task }); }
  catch (error) { if (error.code !== 6) throw error; }
}

export async function enqueueReservationExpiry(env, orderId, expiresAt) {
  if (!env.COMMERCE_WORKER_URL || !env.COMMERCE_TASKS_QUEUE || !env.COMMERCE_TASKS_SERVICE_ACCOUNT || !env.GOOGLE_CLOUD_PROJECT) {
    throw new CommerceError(503, 'Reservation task queue is not configured.');
  }
  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const client = new CloudTasksClient();
  const parent = client.queuePath(env.GOOGLE_CLOUD_PROJECT, env.COMMERCE_TASKS_REGION || 'asia-south1', env.COMMERCE_TASKS_QUEUE);
  const workerUrl = `${env.COMMERCE_WORKER_URL.replace(/\/$/, '')}/internal/fulfillment`;
  const task = {
    name: `${parent}/tasks/expire-${orderId}`,
    scheduleTime: { seconds: Math.ceil(Date.parse(expiresAt) / 1000) },
    httpRequest: {
      httpMethod: 'POST', url: workerUrl, headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ action: 'expire-reservation', orderId })).toString('base64'),
      oidcToken: { serviceAccountEmail: env.COMMERCE_TASKS_SERVICE_ACCOUNT, audience: workerUrl },
    },
  };
  try { await client.createTask({ parent, task }); }
  catch (error) { if (error.code !== 6) throw error; }
}

export async function requeueFulfillment(env, max = 100) {
  const db = getCommerceDb(env);
  const pending = await db.collection('orders').where('fulfillmentStatus', 'in', ['queued', 'queue_failed']).limit(max).get();
  let queued = 0;
  for (const doc of pending.docs) {
    if (doc.data().paymentStatus !== 'paid' || doc.data().status === 'cancelled') continue;
    await enqueueFulfillment(env, doc.id);
    queued++;
  }
  return queued;
}

async function verifyWorkerRequest(env, req) {
  const expected = `${env.COMMERCE_WORKER_URL?.replace(/\/$/, '')}/internal/fulfillment`;
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!expected || !env.COMMERCE_TASKS_SERVICE_ACCOUNT || !token) {
    throw new CommerceError(401, 'Worker authentication required.');
  }
  const { OAuth2Client } = await import('google-auth-library');
  let ticket;
  try { ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience: expected }); }
  catch { throw new CommerceError(401, 'Invalid worker token.'); }
  const identity = ticket.getPayload();
  if (!identity?.email_verified || identity.email !== env.COMMERCE_TASKS_SERVICE_ACCOUNT ||
      !['https://accounts.google.com', 'accounts.google.com'].includes(identity.iss)) {
    throw new CommerceError(403, 'Worker identity is not allowed.');
  }
}

export async function notifyCustomer(env, order, status) {
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_FROM || !order.address?.email) return;
  const message = {
    booked: `Your SPARK-DV order ${order.id} is booked with ${order.carrier}. Track it at ${order.trackingUrl}.`,
    dispatched: `Your SPARK-DV order ${order.id} has shipped. ${order.trackingUrl ?? ''}`,
    out_for_delivery: `Your SPARK-DV order ${order.id} is out for delivery. ${order.trackingUrl ?? ''}`,
    delivered: `Your SPARK-DV order ${order.id} was delivered.`,
  }[status];
  if (!message) return;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      'Idempotency-Key': `sparkdv-commerce/${order.id}/${status}` },
    body: JSON.stringify({ from: env.ORDER_EMAIL_FROM, to: [order.address.email],
      subject: `SPARK-DV order ${order.id}: ${status.replaceAll('_', ' ')}`, text: message }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new CommerceError(502, 'Order email could not be sent.');
}

export async function fulfillPaidOrder(env, orderId) {
  if (!/^[a-f0-9-]{36}$/i.test(orderId ?? '')) throw new CommerceError(400, 'Invalid order reference.');
  const db = getCommerceDb(env);
  const orderRef = db.collection('orders').doc(orderId);
  const shipmentRef = db.collection('shipments').doc(orderId);
  const order = await db.runTransaction(async tx => {
    const [orderSnap, shipmentSnap] = await Promise.all([tx.get(orderRef), tx.get(shipmentRef)]);
    const current = orderSnap.data();
    if (!current || current.paymentStatus !== 'paid') throw new CommerceError(409, 'Order is not paid.');
    if (current.status === 'cancelled') return null;
    if (current.fulfillmentStatus === 'stock_exception') throw new CommerceError(409, 'Stock exception requires review.');
    if (shipmentSnap.exists && ['booked', 'in_transit', 'dispatched', 'out_for_delivery', 'delivered', 'shipping_exception'].includes(shipmentSnap.data().status)) return null;
    const lease = shipmentSnap.data()?.leaseUntil;
    if (lease && lease > nowIso()) throw new CommerceError(503, 'Shipment booking is already in progress.');
    tx.set(shipmentRef, { orderId, leaseUntil: new Date(Date.now() + 120000).toISOString(),
      status: shipmentSnap.data()?.status ?? 'booking', updatedAt: nowIso() }, { merge: true });
    tx.update(orderRef, { fulfillmentStatus: 'booking' });
    return current;
  });
  if (!order) {
    const booked = (await shipmentRef.get()).data();
    if (booked?.status === 'booked') await orderRef.update({ fulfillmentStatus: 'booked',
      trackingNumber: booked.awb, trackingUrl: booked.trackingUrl });
    return booked;
  }
  const shortReference = `SDV-${orderId.replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const { address, items } = order;
  if (!order.shiprocketPickupLocation) {
    throw new CommerceError(503, 'Shiprocket pickup location is not configured.');
  }
  const createBody = {
    order_id: shortReference,
    order_date: order.createdAt.replace('T', ' ').slice(0, 19),
    pickup_location: order.shiprocketPickupLocation,
    billing_customer_name: address.name,
    billing_last_name: '',
    billing_address: address.line1,
    billing_address_2: address.line2,
    billing_city: address.city,
    billing_pincode: address.pincode,
    billing_state: address.state,
    billing_country: 'India',
    billing_email: address.email,
    billing_phone: address.mobile,
    shipping_is_billing: true,
    order_items: items.map(item => ({ name: item.name, sku: item.sku, units: item.qty,
      selling_price: (item.taxablePaise + item.gstPaise) / item.qty / 100,
      hsn: item.hsn })),
    payment_method: 'Prepaid',
    sub_total: (order.totalPaise - order.shippingPaise - order.shippingTaxPaise) / 100,
    length: order.packageDimensionsCm.length,
    breadth: order.packageDimensionsCm.width,
    height: order.packageDimensionsCm.height,
    weight: Math.max(0.1, Math.ceil(items.reduce((sum, item) => sum + item.weightGrams * item.qty, 0) / 100) / 10),
    shipping_charges: (order.shippingPaise + order.shippingTaxPaise) / 100,
  };
  // Search by our stable channel order ID before creation. A previous task may
  // have succeeded at Shiprocket just before its response was lost.
  async function findExisting() {
    const result = await shiprocketRequest(env, `orders?search=${encodeURIComponent(shortReference)}&per_page=20`);
    const matches = Array.isArray(result.data) ? result.data : result.data?.data ?? [];
    return matches.find(row => row.channel_order_id === shortReference || row.order_id === shortReference) ?? null;
  }
  let shipment = (await shipmentRef.get()).data();
  let shipmentId = shipment.shipmentId;
  let shiprocketOrderId = shipment.shiprocketOrderId;
  if (!shipmentId) {
    let existing = await findExisting();
    if (!existing) {
      try {
        const created = await shiprocketRequest(env, 'orders/create/adhoc', 'POST', createBody);
        shipmentId = created.shipment_id;
        shiprocketOrderId = created.order_id;
      } catch (error) {
        existing = await findExisting().catch(() => null);
        if (!existing) {
          await orderRef.update({ fulfillmentStatus: 'booking_retry', fulfillmentErrorAt: nowIso() });
          throw error;
        }
      }
    }
    if (existing) {
      shipmentId = existing.shipment_id ?? existing.shipments?.[0]?.id;
      shiprocketOrderId = existing.id ?? existing.order_id;
    }
    if (!shipmentId) throw new CommerceError(502, 'Shipping provider returned no shipment ID.');
    await shipmentRef.set({ externalReference: shortReference, shiprocketOrderId,
      shipmentId, carrier: order.carrier, courierId: order.courierId, status: 'created', createdAt: nowIso() }, { merge: true });
    shipment = (await shipmentRef.get()).data();
  }
  let trackingNumber = shipment.awb;
  async function remoteShipment() {
    const result = await shiprocketRequest(env, `shipments/${shipmentId}`);
    return result.data?.data ?? result.data ?? result;
  }
  if (!trackingNumber) {
    let remote = await remoteShipment();
    trackingNumber = remote.awb_code ?? remote.awb ?? null;
    if (!trackingNumber) {
      try {
        const awb = await shiprocketRequest(env, 'courier/assign/awb', 'POST', { shipment_id: shipmentId, courier_id: order.courierId });
        trackingNumber = awb.response?.data?.awb_code ?? awb.awb_code ?? null;
      } catch (error) {
        remote = await remoteShipment().catch(() => null);
        trackingNumber = remote?.awb_code ?? remote?.awb ?? null;
        if (!trackingNumber) throw error;
      }
    }
  }
  if (!trackingNumber) throw new CommerceError(502, 'Shipping provider did not assign a tracking number.');
  await shipmentRef.set({ awb: trackingNumber, status: 'awb_assigned' }, { merge: true });
  if (!shipment.pickupRequested) {
    let scheduledAt = (await remoteShipment()).pickup_scheduled_date ?? null;
    if (!scheduledAt) {
      try {
        const pickup = await shiprocketRequest(env, 'courier/generate/pickup', 'POST', { shipment_id: [shipmentId] });
        if (pickup.pickup_status !== 1) throw new CommerceError(502, 'Shipping pickup could not be scheduled.');
        scheduledAt = pickup.response?.pickup_scheduled_date ?? nowIso();
      } catch (error) {
        scheduledAt = (await remoteShipment().catch(() => null))?.pickup_scheduled_date ?? null;
        if (!scheduledAt) throw error;
      }
    }
    await shipmentRef.set({ pickupRequested: true, pickupScheduledAt: scheduledAt }, { merge: true });
  }
  let labelUrl = shipment.labelUrl;
  if (!labelUrl) {
    const label = await shiprocketRequest(env, 'courier/generate/label', 'POST', { shipment_id: [shipmentId] });
    if (label.label_created !== 1 || !label.label_url) throw new CommerceError(502, 'Shipping label could not be generated.');
    labelUrl = label.label_url;
    await shipmentRef.set({ labelUrl }, { merge: true });
  }
  let manifestUrl = shipment.manifestUrl;
  if (!manifestUrl) {
    const manifest = await shiprocketRequest(env, 'manifests/generate', 'POST', { shipment_id: [shipmentId] });
    if (manifest.status !== 1 || !manifest.manifest_url) throw new CommerceError(502, 'Shipping manifest could not be generated.');
    manifestUrl = manifest.manifest_url;
    await shipmentRef.set({ manifestUrl }, { merge: true });
  }
  const trackingUrl = `https://shiprocket.co/tracking/${encodeURIComponent(trackingNumber)}`;
  const booked = { orderId, externalReference: shortReference, shiprocketOrderId,
    shipmentId, carrier: order.carrier, courierId: order.courierId, awb: trackingNumber,
    labelUrl, manifestUrl, pickupRequested: true, trackingUrl, status: 'booked', bookedAt: nowIso(), leaseUntil: null };
  await shipmentRef.set(booked, { merge: true });
  await orderRef.update({ fulfillmentStatus: 'booked', trackingNumber, trackingUrl });
  try { await notifyCustomer(env, { ...order, trackingNumber, trackingUrl }, 'booked'); }
  catch (error) { console.warn('Order notification failed:', error.message); }
  return booked;
}

export function createFulfillmentWorker(env = process.env) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      if (req.method !== 'POST') throw new CommerceError(405, 'Use POST.');
      await verifyWorkerRequest(env, req);
      const body = await readCommerceBody(req, 8192);
      if (body.action === 'fulfill') {
        const shipment = await fulfillPaidOrder(env, body.orderId);
        return send(200, { shipment });
      }
      if (body.action === 'expire-reservation') {
        const { releaseOrderReservation } = await import('./checkout.js');
        return send(200, { released: await releaseOrderReservation(env, body.orderId) });
      }
      if (body.action === 'expire-reservations') {
        return send(200, { released: await releaseExpiredReservations(env) });
      }
      if (body.action === 'requeue-fulfillment') {
        return send(200, { queued: await requeueFulfillment(env) });
      }
      throw new CommerceError(400, 'Unknown worker action.');
    } catch (error) {
      if (error.status && error.status < 500) return send(error.status, { error: error.message });
      console.error('Fulfillment worker error:', error.code ?? error.name, error.message);
      return send(503, { error: 'Fulfillment will retry.' });
    }
  };
}

function safeEqualString(a, b) {
  if (!a || !b) return false;
  const one = Buffer.from(a);
  const two = Buffer.from(b);
  return one.length === two.length && timingSafeEqual(one, two);
}

export function createShiprocketWebhook(env = process.env) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      if (req.method !== 'POST') throw new CommerceError(405, 'Use POST.');
      if (!env.SHIPROCKET_WEBHOOK_TOKEN || !safeEqualString(req.headers['x-api-key'], env.SHIPROCKET_WEBHOOK_TOKEN)) {
        throw new CommerceError(401, 'Invalid webhook token.');
      }
      const body = await readCommerceBody(req, 262144);
      const awb = String(body.awb ?? '').trim();
      if (!awb || awb.length > 100) throw new CommerceError(400, 'Missing tracking number.');
      const db = getCommerceDb(env);
      const shipments = await db.collection('shipments').where('awb', '==', awb).limit(1).get();
      if (shipments.empty) throw new CommerceError(503, 'Shipment mapping is not available yet.');
      const shipmentRef = shipments.docs[0].ref;
      const orderRef = db.collection('orders').doc(shipments.docs[0].id);
      const rawStatus = String(body.current_status ?? body.shipment_status ?? '').trim().toUpperCase();
      const next = /RTO|CANCEL|UNDELIVERED|PARTIAL|LOST|DAMAGED|DESTROYED|EXCEPTION/.test(rawStatus) ? 'shipping_exception'
        : rawStatus === 'DELIVERED' ? 'delivered'
        : rawStatus.includes('OUT FOR DELIVERY') ? 'out_for_delivery'
        : /PICKED|TRANSIT|SHIPPED|HANDOVER/.test(rawStatus) ? 'dispatched' : null;
      const id = `shiprocket:${createHash('sha256').update(JSON.stringify([awb, rawStatus, body.current_timestamp])).digest('hex')}`;
      const eventRef = db.collection('providerEvents').doc(id);
      const updated = await db.runTransaction(async tx => {
        const [event, orderSnap, shipmentSnap] = await Promise.all([tx.get(eventRef), tx.get(orderRef), tx.get(shipmentRef)]);
        if (event.exists) return null;
        const order = orderSnap.data();
        if (!order) throw new CommerceError(503, 'Order mapping is not available yet.');
        tx.create(eventRef, { orderId: order.id, provider: 'shiprocket', status: rawStatus, at: nowIso() });
        const rank = { placed: 0, confirmed: 1, dispatched: 2, out_for_delivery: 3, delivered: 4 };
        const previousShipment = shipmentSnap.data()?.status;
        const shipmentStatus = next === 'shipping_exception' ? next
          : next && rank[next] >= (rank[previousShipment] ?? -1) ? next : previousShipment ?? 'in_transit';
        tx.update(shipmentRef, { status: shipmentStatus, providerStatus: rawStatus,
          lastTrackingAt: body.current_timestamp ?? nowIso() });
        if (next && order.status !== 'cancelled' && rank[next] > (rank[order.status] ?? -1)) {
          const entry = { seq: (order.events?.length ?? 0) + 1, status: next, created_at: nowIso(),
            carrier: shipmentSnap.data()?.carrier ?? 'Shiprocket', tracking_number: awb,
            tracking_url: shipmentSnap.data()?.trackingUrl ?? null };
          tx.update(orderRef, { status: next, events: [...(order.events ?? []), entry] });
          return { ...order, carrier: entry.carrier, trackingUrl: entry.tracking_url, status: next };
        }
        if (next === 'shipping_exception') tx.update(orderRef, { fulfillmentStatus: 'exception' });
        return null;
      });
      if (updated) try { await notifyCustomer(env, updated, updated.status); }
      catch (error) { console.warn('Tracking notification failed:', error.message); }
      return send(200, { received: true });
    } catch (error) {
      if (error.status) return send(error.status, { error: error.message });
      console.error('Shipping webhook error:', error.code ?? error.name, error.message);
      return send(503, { error: 'Webhook processing failed; retry later.' });
    }
  };
}
