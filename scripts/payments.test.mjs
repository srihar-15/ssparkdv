import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';
import { initializePayments, startPayment, verifyPayment } from '../server/payments.js';

test('payment retry, signature validation and captured amount verification', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute('CREATE TABLE orders (id TEXT PRIMARY KEY)');
  await db.execute("INSERT INTO orders VALUES ('checkout-1')");
  await initializePayments(db);
  const env = { RAZORPAY_KEY_ID: 'rzp_test_example', RAZORPAY_KEY_SECRET: 'test-secret' };
  const order = { id: 'checkout-1', status: 'placed', items: [{ price: 149.99, qty: 2 }] };
  const originalFetch = globalThis.fetch;
  let created = 0;
  let captured = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/orders')) {
      const body = JSON.parse(options.body);
      assert.equal(body.amount, 29998);
      assert.equal(body.currency, 'INR');
      created++;
      return Response.json({ id: 'order_test' });
    }
    assert.ok(url.endsWith('/orders/order_test/payments'));
    return Response.json({ items: captured });
  };
  try {
    await assert.rejects(startPayment(db, env, { ...order, items: [{ price: null, qty: 1 }] }), /quote/);
    const first = await startPayment(db, env, order);
    const retry = await startPayment(db, env, order);
    assert.equal(first.order_id, retry.order_id);
    assert.equal(created, 1);
    const body = {
      razorpay_order_id: 'order_test', razorpay_payment_id: 'pay_test',
      razorpay_signature: '0'.repeat(64),
    };
    await assert.rejects(verifyPayment(db, env, order, body), /verified/);
    body.razorpay_signature = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update('order_test|pay_test').digest('hex');
    captured = [{ id: 'pay_test', order_id: 'order_test', status: 'authorized', currency: 'INR', amount: 29998 }];
    await assert.rejects(verifyPayment(db, env, order, body), /processing/);
    captured[0].status = 'captured';
    captured[0].amount = 1;
    await assert.rejects(verifyPayment(db, env, order, body), /processing/);
    captured[0].amount = 29998;
    await verifyPayment(db, env, order, body);
    await verifyPayment(db, env, order, body);
    assert.equal((await startPayment(db, env, order)).paid, true);
    assert.equal(created, 1);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
