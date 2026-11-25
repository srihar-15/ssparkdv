import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { discountFor, ensureProviderOrder, orderAccess, publicOrder, taxLines } from './checkout.js';
import { verifyCheckoutSignature, verifyWebhookSignature } from './provider.js';

const items = [
  { sku: 'A', linePaise: 10000, gstRateBps: 500 },
  { sku: 'B', linePaise: 20000, gstRateBps: 1800 },
];
const active = { active: true, kind: 'percent', value: 1000, maxUses: 2,
  usedCount: 0, reserved: 0, eligibleSkus: ['A'] };

test('percentage promotion applies only to eligible product and GST follows discounted taxable value', () => {
  const discount = discountFor(active, items, '2026-11-25T00:00:00.000Z');
  assert.equal(discount, 1000);
  const priced = taxLines(items, discount, 'Andhra Pradesh', 'Andhra Pradesh', active.eligibleSkus);
  assert.deepEqual(priced.items.map(item => item.discountPaise), [1000, 0]);
  assert.equal(priced.taxPaise, 4050);
  assert.equal(priced.items[0].cgstPaise + priced.items[0].sgstPaise, 450);
  assert.equal(priced.items[0].igstPaise, 0);
});

test('fixed promotion is capped by eligible subtotal and interstate tax uses IGST', () => {
  const promo = { ...active, kind: 'fixed', value: 30000, eligibleSkus: ['B'] };
  const discount = discountFor(promo, items, '2026-11-25T00:00:00.000Z');
  assert.equal(discount, 20000);
  const priced = taxLines(items, discount, 'Andhra Pradesh', 'Karnataka', promo.eligibleSkus);
  assert.equal(priced.items[0].discountPaise, 0);
  assert.equal(priced.items[1].taxablePaise, 0);
  assert.equal(priced.taxPaise, 500);
  assert.equal(priced.items[0].igstPaise, 500);
});

test('promotion usage limit counts reservations', () => {
  assert.throws(() => discountFor({ ...active, usedCount: 1, reserved: 1 }, items, '2026-11-25T00:00:00.000Z'),
    /unavailable/);
});

test('discount allocation never creates a negative discount on small lines', () => {
  const four = ['A', 'B', 'C', 'D'].map(sku => ({ sku, linePaise: 100, gstRateBps: 500 }));
  const priced = taxLines(four, 2, 'Andhra Pradesh', 'Andhra Pradesh');
  assert.deepEqual(priced.items.map(item => item.discountPaise), [1, 1, 0, 0]);
  assert.equal(priced.items.reduce((sum, item) => sum + item.discountPaise, 0), 2);
  assert.ok(priced.items.every(item => item.taxablePaise <= item.linePaise));
});

test('order response redacts guest secret and access requires matching browser cookie', () => {
  const token = 'a'.repeat(64);
  const order = { id: 'sample', guestTokenHash: createHash('sha256').update(token).digest('hex'),
    pickupAddress: { phone: 'private' }, customerUid: null, address: { name: 'Customer', email: 'a@example.com' },
    items: [{ sku: 'A', pricePaise: 10000 }] };
  assert.equal(publicOrder(order).guestTokenHash, undefined);
  assert.equal(publicOrder(order).pickupAddress, undefined);
  assert.equal(orderAccess({ headers: { cookie: `sparkdv_guest_session=${token}` } }, order, null), true);
  assert.equal(orderAccess({ headers: { cookie: 'sparkdv_guest_session=wrong' } }, order, null), false);
});

test('payment and webhook signatures reject altered values', () => {
  const env = { RAZORPAY_KEY_SECRET: 'secret' };
  const checkout = createHmac('sha256', 'secret').update('order_ABC|pay_XYZ').digest('hex');
  assert.equal(verifyCheckoutSignature(env, 'order_ABC', 'pay_XYZ', checkout), true);
  assert.equal(verifyCheckoutSignature(env, 'order_ABC', 'pay_XXZ', checkout), false);
  const raw = Buffer.from('{"event":"payment.captured"}');
  const webhook = createHmac('sha256', 'webhook').update(raw).digest('hex');
  assert.equal(verifyWebhookSignature('webhook', raw, webhook), true);
  assert.equal(verifyWebhookSignature('webhook', Buffer.from('{}'), webhook), false);
});

test('Razorpay order creation recovers provider success after a lost response', async () => {
  const order = { id: '1c30345d-c0e0-4309-bd1d-85a05bb64e80', totalPaise: 15400 };
  let lookups = 0;
  let posts = 0;
  const provider = { id: 'order_ABC', receipt: order.id, amount: 15400, currency: 'INR' };
  const request = async (_env, path, method) => {
    if (method === 'POST') { posts++; throw new Error('Provider response was lost'); }
    assert.match(path, /orders\?receipt=/);
    lookups++;
    return { items: lookups === 1 ? [] : [provider] };
  };
  assert.deepEqual(await ensureProviderOrder({}, order, request), provider);
  assert.equal(posts, 1);
  assert.equal(lookups, 2);
});

test('Razorpay order lookup refuses a mismatched amount', async () => {
  const order = { id: '1c30345d-c0e0-4309-bd1d-85a05bb64e80', totalPaise: 15400 };
  const request = async () => ({ items: [{ id: 'order_ABC', receipt: order.id, amount: 15300, currency: 'INR' }] });
  await assert.rejects(ensureProviderOrder({}, order, request), /Payment amount changed/);
});
