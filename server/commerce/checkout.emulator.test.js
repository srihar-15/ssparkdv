import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

test('Firestore checkout reserves stock once and captured payment consumes it once',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
    const env = { ...process.env, COMMERCE_FIREBASE_PROJECT_ID: process.env.COMMERCE_FIREBASE_PROJECT_ID || 'spark-dv-dealatecorp',
      COMMERCE_FIRESTORE_DATABASE: `checkout-test-${randomUUID().slice(0, 8)}`,
      RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'secret',
      SHIPROCKET_API_EMAIL: 'test@example.com', SHIPROCKET_API_PASSWORD: 'fake' };
    env.RAZORPAY_WEBHOOK_SECRET = 'webhook-secret';
    const { getCommerceDb } = await import('./firebase.js');
    const { quoteOrder, createPaymentOrder, applyProviderPayment, releaseOrderReservation } = await import('./checkout.js');
    const { createPaymentWebhook } = await import('../payment-events.js');
    const db = getCommerceDb(env);
    const slug = 'test-product';
    const sku = 'TEST-SKU';
    const originalFetch = globalThis.fetch;
    let razorpayOrder;
    let providerCreates = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) return Response.json({ token: 'shiprocket-test-token' });
      if (url.includes('/courier/serviceability/')) return Response.json({ data: { available_courier_companies: [
        { courier_company_id: 10, courier_name: 'Test Courier', freight_charge: 100, estimated_delivery_days: '3' },
      ] } });
      if (url.includes('/v1/orders?receipt=')) return Response.json({ items: razorpayOrder ? [razorpayOrder] : [] });
      if (url.endsWith('/v1/orders') && init.method === 'POST') {
        providerCreates++;
        const body = JSON.parse(init.body);
        razorpayOrder = { id: 'order_TEST123', receipt: body.receipt, amount: body.amount, currency: body.currency };
        return Response.json(razorpayOrder);
      }
      throw new Error(`Unexpected provider request: ${url}`);
    };
    try {
      await db.collection('settings').doc('commerce').set({ gstin: '37ABCDE1234F1Z5', originState: 'Andhra Pradesh',
        pickupPincode: '530001', shiprocketPickupLocation: 'Test Warehouse', shippingGstRateBps: 1800,
        updatedAt: '2026-11-25T00:00:00.000Z' });
      await db.collection('publishedProducts').doc(slug).set({ slug, sku, name: 'Test Product', status: 'published',
        purchaseMode: 'online', version: 1, pricePaise: 10000, gstRateBps: 500, hsn: '3306', weightGrams: 100,
        dimensionsCm: { length: 10, width: 10, height: 10 } });
      await db.collection('inventory').doc(sku).set({ sku, onHand: 5, reserved: 0 });
      await db.collection('promotions').doc('SAVE10').set({ active: true, kind: 'percent', value: 1000,
        maxUses: 1, usedCount: 0, reserved: 0, eligibleSkus: [sku], startAt: '2020-01-01T00:00:00.000Z',
        endAt: '2099-01-01T00:00:00.000Z' });
      const quote = await quoteOrder(env, { items: [{ slug, qty: 2 }], promoCode: 'SAVE10', address: {
        name: 'Test Customer', email: 'customer@example.com', mobile: '9999999999', line1: 'Test Street',
        line2: '', city: 'Visakhapatnam', state: 'Andhra Pradesh', pincode: '530002',
      } });
      assert.equal(quote.subtotalPaise, 20000);
      assert.equal(quote.discountPaise, 2000);
      assert.equal(quote.taxPaise, 900);
      assert.equal(quote.shippingPaise, 10000);
      assert.equal(quote.shippingTaxPaise, 1800);
      assert.equal(quote.totalPaise, 30700);
      const req = { headers: {} };
      const headers = {};
      const res = { setHeader: (name, value) => { headers[name] = value; } };
      const id = randomUUID();
      const first = await createPaymentOrder(env, { id, quoteId: quote.id }, null, req, res, false);
      assert.equal(first.payment.order_id, 'order_TEST123');
      assert.equal((await db.collection('inventory').doc(sku).get()).data().reserved, 2);
      assert.equal((await db.collection('promotions').doc('SAVE10').get()).data().reserved, 1);
      req.headers.cookie = headers['Set-Cookie'].split(';')[0];
      const retry = await createPaymentOrder(env, { id, quoteId: quote.id }, null, req, res, false);
      assert.equal(retry.payment.order_id, first.payment.order_id);
      assert.equal(providerCreates, 1);
      assert.equal((await db.collection('inventory').doc(sku).get()).data().reserved, 2);
      const captured = { id: 'pay_TEST123', order_id: 'order_TEST123', amount: 30700,
        currency: 'INR', status: 'captured', created_at: 1795600000 };
      const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: captured } } }));
      const signature = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
      const webhook = createPaymentWebhook(env);
      async function deliver() {
        const request = Readable.from([raw]);
        request.method = 'POST';
        request.headers = { 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'event-1' };
        const response = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
        await webhook(request, response);
        return response;
      }
      assert.equal((await deliver()).statusCode, 503);
      assert.equal((await deliver()).statusCode, 503);
      await applyProviderPayment(env, captured, 'test-capture-2');
      const stock = (await db.collection('inventory').doc(sku).get()).data();
      assert.equal(stock.onHand, 3);
      assert.equal(stock.reserved, 0);
      const promo = (await db.collection('promotions').doc('SAVE10').get()).data();
      assert.equal(promo.usedCount, 1);
      assert.equal(promo.reserved, 0);
      assert.equal((await db.collection('orders').doc(id).get()).data().paymentStatus, 'paid');
      assert.equal((await db.collection('orders').doc(id).get()).data().fulfillmentStatus, 'queue_failed');
      assert.equal(await releaseOrderReservation(env, id), false);
    } finally {
      globalThis.fetch = originalFetch;
      for (const name of ['providerEvents', 'inventoryMovements', 'payments', 'orders', 'quotes', 'promotions',
        'inventory', 'publishedProducts', 'settings']) {
        const docs = await db.collection(name).get();
        await Promise.all(docs.docs.map(doc => doc.ref.delete()));
      }
    }
  });

test('captured payment with unavailable stock releases its reservation and needs review',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
    const env = { ...process.env, COMMERCE_FIREBASE_PROJECT_ID: process.env.COMMERCE_FIREBASE_PROJECT_ID || 'spark-dv-dealatecorp',
      COMMERCE_FIRESTORE_DATABASE: `stock-exception-${randomUUID().slice(0, 8)}` };
    const { getCommerceDb } = await import('./firebase.js');
    const { applyProviderPayment } = await import('./checkout.js');
    const db = getCommerceDb(env);
    const id = randomUUID();
    const sku = 'EXCEPTION-SKU';
    await db.collection('inventory').doc(sku).set({ onHand: 0, reserved: 1 });
    await db.collection('orders').doc(id).set({ id, status: 'placed', paymentStatus: 'pending',
      reservationState: 'reserved', totalPaise: 100, items: [{ sku, qty: 1 }], events: [], payment_events: [] });
    await db.collection('payments').doc(id).set({ orderId: id, razorpayOrderId: 'order_STOCK',
      amountPaise: 100, currency: 'INR', status: 'pending' });
    try {
      await applyProviderPayment(env, { id: 'pay_STOCK', order_id: 'order_STOCK', amount: 100,
        currency: 'INR', status: 'captured' }, 'stock-exception', 'provider-api');
      const stock = (await db.collection('inventory').doc(sku).get()).data();
      assert.equal(stock.onHand, 0);
      assert.equal(stock.reserved, 0);
      const order = (await db.collection('orders').doc(id).get()).data();
      assert.equal(order.paymentStatus, 'paid');
      assert.equal(order.reservationState, 'released');
      assert.equal(order.fulfillmentStatus, 'stock_exception');
      const cancelledId = randomUUID();
      await db.collection('inventory').doc(sku).set({ onHand: 1, reserved: 0 });
      await db.collection('orders').doc(cancelledId).set({ id: cancelledId, status: 'cancelled', paymentStatus: 'cancelled',
        reservationState: 'released', totalPaise: 100, items: [{ sku, qty: 1 }], events: [], payment_events: [] });
      await db.collection('payments').doc(cancelledId).set({ orderId: cancelledId, razorpayOrderId: 'order_LATE',
        amountPaise: 100, currency: 'INR', status: 'pending' });
      await applyProviderPayment(env, { id: 'pay_LATE', order_id: 'order_LATE', amount: 100,
        currency: 'INR', status: 'captured' }, 'late-capture', 'provider-api');
      assert.equal((await db.collection('inventory').doc(sku).get()).data().onHand, 1);
      const cancelled = (await db.collection('orders').doc(cancelledId).get()).data();
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.paymentStatus, 'paid');
      assert.equal(cancelled.fulfillmentStatus, 'payment_exception');
    } finally {
      for (const name of ['providerEvents', 'payments', 'orders', 'inventory']) {
        const docs = await db.collection(name).get();
        await Promise.all(docs.docs.map(doc => doc.ref.delete()));
      }
    }
  });
