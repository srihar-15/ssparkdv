import { randomUUID } from 'node:crypto';
import { getCommerceDb, requireCommercePermission } from './firebase.js';
import { CommerceError, methodAllowed, readJson, requireSameOrigin, sendCommerceError, sendJson } from './http.js';
import { uploadAdminMedia } from './media.js';

const roles = new Set(['owner', 'catalog', 'fulfillment', 'support', 'finance']);
const productFields = new Set(['slug', 'sku', 'name', 'family', 'familySlug', 'category', 'eyebrow', 'img', 'shareImage', 'desc',
  'tags', 'features', 'variant', 'price', 'pricePaise', 'compare', 'launch', 'professional', 'coming', 'purchaseMode',
  'hsn', 'gstRateBps', 'weightGrams', 'dimensionsCm', 'sortOrder', 'seo', 'media', 'active']);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skuPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const pagePattern = /^[a-z0-9][a-z0-9-]{0,79}$/;

function auditData(actor, action, resource, id, detail = {}, at = new Date().toISOString()) {
  return { actorUid: actor.uid, action, resource, id, detail, at };
}

function productDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommerceError(400, 'Product data is required.');
  if (!slugPattern.test(input.slug || '') || input.slug.length > 80) throw new CommerceError(400, 'Use a valid product slug.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160) throw new CommerceError(400, 'Enter a product name.');
  const item = Object.fromEntries(Object.entries(input).filter(([key]) => productFields.has(key)));
  item.slug = input.slug;
  item.name = input.name.trim();
  if (item.price != null && (!Number.isFinite(item.price) || item.price < 0 || Math.round(item.price * 100) > 2_000_000_000))
    throw new CommerceError(400, 'Enter a valid product price.');
  if (item.pricePaise != null && (!Number.isSafeInteger(item.pricePaise) || item.pricePaise < 0 || item.pricePaise > 2_000_000_000))
    throw new CommerceError(400, 'Enter a valid price in paise.');
  if (item.pricePaise == null && item.price != null) item.pricePaise = Math.round(item.price * 100);
  if (item.pricePaise != null) item.price = item.pricePaise / 100;
  if (item.sku && !skuPattern.test(item.sku)) throw new CommerceError(400, 'Use a valid SKU.');
  if (item.tags && (!Array.isArray(item.tags) || item.tags.length > 20 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 100)))
    throw new CommerceError(400, 'Use valid product tags.');
  if (item.features && (!Array.isArray(item.features) || item.features.length > 30 || item.features.some(feature => typeof feature !== 'string' || feature.length > 400)))
    throw new CommerceError(400, 'Use valid product features.');
  if (JSON.stringify(item).length > 64_000) throw new CommerceError(413, 'Product data is too large.');
  return item;
}

function publishableProduct(input) {
  const item = productDraft(input);
  if (!item.category || typeof item.category !== 'string' || item.category.length > 100) throw new CommerceError(400, 'Product category is required.');
  if (!item.img || typeof item.img !== 'string' || item.img.length > 1024 || !/^(?:\/[A-Za-z0-9/_?=.&%-]+|[A-Za-z0-9._-]+)$/.test(item.img))
    throw new CommerceError(400, 'Upload or select a valid product image.');
  if (!item.sku) item.sku = item.slug;
  if (!skuPattern.test(item.sku)) throw new CommerceError(400, 'Use a valid SKU.');
  item.purchaseMode ||= item.coming ? 'coming' : item.pricePaise == null ? 'enquiry' : 'online';
  if (!['online', 'enquiry', 'coming'].includes(item.purchaseMode)) throw new CommerceError(400, 'Invalid purchase mode.');
  item.coming = item.purchaseMode === 'coming';
  if (item.purchaseMode === 'online') {
    if (!Number.isSafeInteger(item.pricePaise) || item.pricePaise <= 0) throw new CommerceError(400, 'Online products need a positive price.');
    if (!/^[0-9]{4,8}$/.test(item.hsn || '')) throw new CommerceError(400, 'Online products need an approved HSN code.');
    if (!Number.isInteger(item.gstRateBps) || item.gstRateBps < 0 || item.gstRateBps > 10000)
      throw new CommerceError(400, 'Online products need an approved GST rate.');
    if (!Number.isInteger(item.weightGrams) || item.weightGrams <= 0) throw new CommerceError(400, 'Online products need a shipping weight.');
    const dimensions = item.dimensionsCm;
    if (!dimensions || ['length', 'width', 'height'].some(key => !Number.isFinite(dimensions[key]) || dimensions[key] <= 0))
      throw new CommerceError(400, 'Online products need package dimensions.');
  }
  return item;
}

function contentDraft(input, id) {
  if (!pagePattern.test(id || '')) throw new CommerceError(400, 'Invalid page key.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommerceError(400, 'Page data is required.');
  if (input.sections && (!Array.isArray(input.sections) || input.sections.length > 40)) throw new CommerceError(400, 'Use up to 40 page sections.');
  if (JSON.stringify(input).length > 120_000) throw new CommerceError(413, 'Page data is too large.');
  const page = { ...input, key: id };
  for (const field of ['id', 'status', 'version', 'publishedAt', 'publishedBy', 'updatedAt', 'updatedBy', 'hasDraft', 'publishedVersion'])
    delete page[field];
  return page;
}

function promotion(input) {
  const code = String(input?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new CommerceError(400, 'Use a valid promotion code.');
  if (!['percent', 'fixed'].includes(input.kind)) throw new CommerceError(400, 'Promotion kind must be percent or fixed.');
  if (!Number.isSafeInteger(input.value) || input.value <= 0 || (input.kind === 'percent' && input.value > 10000))
    throw new CommerceError(400, 'Enter a valid promotion value in basis points or paise.');
  if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 0) throw new CommerceError(400, 'Set a non-negative usage limit.');
  const eligibleSkus = input.eligibleSkus || [];
  if (!Array.isArray(eligibleSkus) || eligibleSkus.some(sku => !skuPattern.test(sku))) throw new CommerceError(400, 'Invalid eligible SKU list.');
  const startAt = Date.parse(input.startAt);
  const endAt = Date.parse(input.endAt);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw new CommerceError(400, 'Set a valid promotion period.');
  return { code, kind: input.kind, value: input.value, maxUses: input.maxUses, eligibleSkus,
    startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(), active: input.active === true };
}

function commerceSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommerceError(400, 'Store settings are required.');
  const settings = {};
  if (input.originState !== undefined) {
    if (typeof input.originState !== 'string' || !/^[A-Za-z][A-Za-z .-]{1,59}$/.test(input.originState)) throw new CommerceError(400, 'Set the pickup state name.');
    settings.originState = input.originState.trim();
  }
  if (input.pickupPincode !== undefined) {
    if (!/^\d{6}$/.test(String(input.pickupPincode))) throw new CommerceError(400, 'Set a six-digit pickup PIN code.');
    settings.pickupPincode = String(input.pickupPincode);
  }
  if (input.gstin !== undefined) {
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(String(input.gstin).toUpperCase())) throw new CommerceError(400, 'Set a valid GSTIN.');
    settings.gstin = String(input.gstin).toUpperCase();
  }
  if (input.shippingGstRateBps !== undefined) {
    if (!Number.isInteger(input.shippingGstRateBps) || input.shippingGstRateBps < 0 || input.shippingGstRateBps > 10000)
      throw new CommerceError(400, 'Set the approved shipping GST rate.');
    settings.shippingGstRateBps = input.shippingGstRateBps;
  }
  if (input.shippingMarkupPaise !== undefined) {
    if (!Number.isSafeInteger(input.shippingMarkupPaise) || input.shippingMarkupPaise < 0 || input.shippingMarkupPaise > 2_000_000)
      throw new CommerceError(400, 'Set a valid shipping markup in paise.');
    settings.shippingMarkupPaise = input.shippingMarkupPaise;
  }
  if (input.pickupAddress !== undefined) {
    if (!input.pickupAddress || typeof input.pickupAddress !== 'object' || JSON.stringify(input.pickupAddress).length > 3000)
      throw new CommerceError(400, 'Set a valid pickup address.');
    settings.pickupAddress = input.pickupAddress;
  }
  if (input.shiprocketPickupLocation !== undefined) {
    if (typeof input.shiprocketPickupLocation !== 'string' || input.shiprocketPickupLocation.length > 100)
      throw new CommerceError(400, 'Set a valid Shiprocket pickup location.');
    settings.shiprocketPickupLocation = input.shiprocketPickupLocation;
  }
  if (!Object.keys(settings).length) throw new CommerceError(400, 'Nothing to save.');
  return settings;
}

async function mergedList(db, draftCollection, publishedCollection) {
  const [drafts, published] = await Promise.all([
    db.collection(draftCollection).limit(500).get(), db.collection(publishedCollection).limit(500).get(),
  ]);
  const map = new Map(published.docs.map(doc => [doc.id, { ...doc.data(), id: doc.id, hasDraft: false,
    publishedVersion: doc.data().version || 1 }]));
  for (const doc of drafts.docs) {
    const prior = map.get(doc.id);
    map.set(doc.id, { ...doc.data(), id: doc.id, hasDraft: true, publishedVersion: prior?.publishedVersion || null });
  }
  return [...map.values()].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || String(a.name || a.title || a.id).localeCompare(String(b.name || b.title || b.id)));
}

const readPermissions = { products: 'catalog.read', inventory: 'inventory.read', content: 'content.read',
  promotions: 'promotions.manage', staff: 'staff.manage', settings: 'settings.read' };

async function readResource(req, db, env, resource) {
  const permission = readPermissions[resource];
  if (!permission) throw new CommerceError(400, 'Unknown admin resource.');
  await requireCommercePermission(req, permission, env);
  if (resource === 'products') return { items: await mergedList(db, 'productDrafts', 'publishedProducts') };
  if (resource === 'content') return { items: await mergedList(db, 'contentDrafts', 'contentPublished') };
  if (resource === 'settings') {
    const doc = await db.collection('settings').doc('commerce').get();
    return { item: doc.exists ? doc.data() : {} };
  }
  const collection = resource === 'staff' ? 'staff' : resource;
  const snapshot = await db.collection(collection).limit(500).get();
  return { items: snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })) };
}

async function saveProductDraft(req, db, env, body) {
  const actor = await requireCommercePermission(req, 'catalog.write', env);
  const item = productDraft(body.item || body.product);
  const ref = db.collection('productDrafts').doc(item.slug);
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(ref, { ...item, status: 'draft', updatedAt: now, updatedBy: actor.uid });
  batch.create(db.collection('auditEvents').doc(randomUUID()), auditData(actor, 'saveDraft', 'products', item.slug, {}, now));
  await batch.commit();
  return { item: { ...item, id: item.slug, status: 'draft' } };
}

async function publishProduct(req, db, env, id) {
  const actor = await requireCommercePermission(req, 'catalog.publish', env);
  if (!slugPattern.test(id || '')) throw new CommerceError(400, 'Invalid product slug.');
  const draftRef = db.collection('productDrafts').doc(id);
  const publishedRef = db.collection('publishedProducts').doc(id);
  const result = await db.runTransaction(async tx => {
    const draft = await tx.get(draftRef);
    if (!draft.exists) throw new CommerceError(404, 'Save a product draft before publishing.');
    const item = publishableProduct(draft.data());
    const skuRef = db.collection('skuIndex').doc(item.sku);
    const inventoryRef = db.collection('inventory').doc(item.sku);
    const [published, sku, inventory] = await Promise.all([tx.get(publishedRef), tx.get(skuRef), tx.get(inventoryRef)]);
    if (sku.exists && sku.data().slug !== id) throw new CommerceError(409, 'This SKU belongs to another product.');
    const oldSku = published.exists ? published.data().sku : null;
    if (oldSku && oldSku !== item.sku) throw new CommerceError(409, 'Published product SKUs cannot change. Create a new product for a new SKU.');
    const version = Number(published.data()?.version || 0) + 1;
    const now = new Date().toISOString();
    tx.set(publishedRef, { ...item, status: 'published', version, publishedAt: now, publishedBy: actor.uid });
    tx.set(skuRef, { slug: id, sku: item.sku });
    if (!inventory.exists) tx.set(inventoryRef, { sku: item.sku, onHand: 0, reserved: 0, updatedAt: now });
    tx.set(db.collection('auditEvents').doc(randomUUID()), { actorUid: actor.uid, action: 'publish', resource: 'products',
      id, detail: { version, sku: item.sku }, at: now });
    return { ...item, id, status: 'published', version };
  });
  return { item: result };
}

async function archiveProduct(req, db, env, id) {
  const actor = await requireCommercePermission(req, 'catalog.publish', env);
  if (!slugPattern.test(id || '')) throw new CommerceError(400, 'Invalid product slug.');
  const ref = db.collection('publishedProducts').doc(id);
  return db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new CommerceError(404, 'Published product not found.');
    const now = new Date().toISOString();
    tx.update(ref, { status: 'archived', archivedAt: now, archivedBy: actor.uid });
    tx.create(db.collection('auditEvents').doc(randomUUID()), auditData(actor, 'archive', 'products', id, {}, now));
    return { id, status: 'archived' };
  });
}

async function adjustInventory(req, db, env, body) {
  const actor = await requireCommercePermission(req, 'inventory.adjust', env);
  const sku = String(body.sku || '');
  if (!skuPattern.test(sku)) throw new CommerceError(400, 'Invalid SKU.');
  if (!Number.isSafeInteger(body.delta) || body.delta === 0 || Math.abs(body.delta) > 1_000_000) throw new CommerceError(400, 'Use a non-zero whole-number adjustment.');
  const reason = String(body.reason || '').trim();
  if (reason.length < 3 || reason.length > 400) throw new CommerceError(400, 'Give a reason for the adjustment.');
  const ref = db.collection('inventory').doc(sku);
  return db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) throw new CommerceError(404, 'Inventory SKU not found.');
    const old = current.data();
    const onHand = Number(old.onHand || 0) + body.delta;
    const reserved = Number(old.reserved || 0);
    if (onHand < 0 || onHand < reserved) throw new CommerceError(409, 'Adjustment would put stock below reserved quantity.');
    const now = new Date().toISOString();
    tx.update(ref, { onHand, updatedAt: now });
    tx.create(db.collection('inventoryMovements').doc(randomUUID()), { sku, delta: body.delta, onHand, reserved,
      reason, actorUid: actor.uid, at: now, kind: 'adjustment' });
    tx.create(db.collection('auditEvents').doc(randomUUID()), { actorUid: actor.uid, action: 'adjust', resource: 'inventory',
      id: sku, detail: { delta: body.delta, reason }, at: now });
    return { item: { sku, onHand, reserved, available: onHand - reserved } };
  });
}

async function saveContentDraft(req, db, env, body) {
  const actor = await requireCommercePermission(req, 'content.write', env);
  const id = String(body.id || body.page?.key || '');
  const page = contentDraft(body.page || body.item, id);
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.collection('contentDrafts').doc(id), { ...page, status: 'draft', updatedAt: now, updatedBy: actor.uid });
  batch.create(db.collection('auditEvents').doc(randomUUID()), auditData(actor, 'saveDraft', 'content', id, {}, now));
  await batch.commit();
  return { item: { ...page, id, status: 'draft' } };
}

async function publishContent(req, db, env, id) {
  const actor = await requireCommercePermission(req, 'content.publish', env);
  if (!pagePattern.test(id || '')) throw new CommerceError(400, 'Invalid page key.');
  const draftRef = db.collection('contentDrafts').doc(id);
  const ref = db.collection('contentPublished').doc(id);
  return db.runTransaction(async tx => {
    const [draft, current] = await Promise.all([tx.get(draftRef), tx.get(ref)]);
    if (!draft.exists) throw new CommerceError(404, 'Save page content before publishing.');
    const page = contentDraft(draft.data(), id);
    const version = Number(current.data()?.version || 0) + 1;
    const now = new Date().toISOString();
    const item = { ...page, status: 'published', version, publishedAt: now, publishedBy: actor.uid };
    tx.set(ref, item);
    tx.create(db.collection('auditEvents').doc(randomUUID()), auditData(actor, 'publish', 'content', id, { version }, now));
    return { item: { ...item, id } };
  });
}

async function savePromotion(req, db, env, body) {
  const actor = await requireCommercePermission(req, 'promotions.manage', env);
  const item = promotion(body.item);
  const ref = db.collection('promotions').doc(item.code);
  return db.runTransaction(async tx => {
    const current = await tx.get(ref);
    const usedCount = Number(current.data()?.usedCount || 0);
    const reserved = Number(current.data()?.reserved || 0);
    if (item.maxUses > 0 && usedCount + reserved > item.maxUses)
      throw new CommerceError(409, 'Usage limit is lower than existing uses and reservations.');
    const now = new Date().toISOString();
    const saved = { ...item, usedCount, reserved, updatedAt: now, updatedBy: actor.uid };
    tx.set(ref, saved);
    tx.create(db.collection('auditEvents').doc(randomUUID()), { actorUid: actor.uid, action: 'save', resource: 'promotions',
      id: item.code, detail: { maxUses: item.maxUses, active: item.active }, at: now });
    return { item: saved };
  });
}

async function changeStaff(req, db, env, body) {
  const actor = await requireCommercePermission(req, 'staff.manage', env);
  const uid = String(body.uid || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid)) throw new CommerceError(400, 'Invalid Firebase user ID.');
  if (uid === env.COMMERCE_OWNER_UID && body.action === 'revoke') throw new CommerceError(409, 'The owner bootstrap account cannot be revoked here.');
  const ref = db.collection('staff').doc(uid);
  const now = new Date().toISOString();
  const batch = db.batch();
  if (body.action === 'revoke') {
    batch.set(ref, { active: false, roles: [], updatedAt: now, updatedBy: actor.uid }, { merge: true });
  } else {
    if (!Array.isArray(body.roles) || !body.roles.length || body.roles.some(role => !roles.has(role)))
      throw new CommerceError(400, 'Select valid staff roles.');
    batch.set(ref, { active: true, roles: [...new Set(body.roles)], updatedAt: now, updatedBy: actor.uid }, { merge: true });
  }
  batch.create(db.collection('auditEvents').doc(randomUUID()), auditData(actor, body.action, 'staff', uid,
    { roles: body.action === 'revoke' ? [] : body.roles }, now));
  await batch.commit();
  return { uid, active: body.action !== 'revoke' };
}

async function saveSettings(req, db, env, body) {
  const actor = await requireCommercePermission(req, 'settings.write', env);
  const settings = commerceSettings(body.item);
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.collection('settings').doc('commerce'), { ...settings, updatedAt: now, updatedBy: actor.uid }, { merge: true });
  batch.create(db.collection('auditEvents').doc(randomUUID()), auditData(actor, 'save', 'settings', 'commerce',
    { keys: Object.keys(settings) }, now));
  await batch.commit();
  return { item: settings };
}

export function createAdminHandler(env = process.env) {
  return async (req, res) => {
    try {
      methodAllowed(req, ['GET', 'POST']);
      const db = getCommerceDb(env);
      if (req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        return sendJson(res, 200, await readResource(req, db, env, url.searchParams.get('resource')));
      }
      requireSameOrigin(req);
      const body = await readJson(req, 8 * 1024 * 1024);
      const { resource, action } = body || {};
      let result;
      if (resource === 'products' && action === 'saveDraft') result = await saveProductDraft(req, db, env, body);
      else if (resource === 'products' && action === 'publish') result = await publishProduct(req, db, env, body.id);
      else if (resource === 'products' && action === 'archive') result = await archiveProduct(req, db, env, body.id);
      else if (resource === 'inventory' && action === 'adjust') result = await adjustInventory(req, db, env, body);
      else if (resource === 'content' && action === 'saveDraft') result = await saveContentDraft(req, db, env, body);
      else if (resource === 'content' && action === 'publish') result = await publishContent(req, db, env, body.id);
      else if (resource === 'promotions' && action === 'save') result = await savePromotion(req, db, env, body);
      else if (resource === 'staff' && ['grant', 'revoke'].includes(action)) result = await changeStaff(req, db, env, body);
      else if (resource === 'settings' && action === 'save') result = await saveSettings(req, db, env, body);
      else if (resource === 'media' && action === 'upload') {
        const actor = await requireCommercePermission(req, 'catalog.write', env);
        result = await uploadAdminMedia(env, body, actor);
      } else throw new CommerceError(400, 'Unknown admin action.');
      return sendJson(res, 200, result);
    } catch (error) { return sendCommerceError(res, error); }
  };
}
