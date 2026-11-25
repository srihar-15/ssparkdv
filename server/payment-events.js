import { createHash } from 'node:crypto';
import { applyProviderPayment, applyProviderRefund } from './commerce/checkout.js';
import { CommerceError, verifyWebhookSignature } from './commerce/provider.js';

export function createPaymentWebhook(env = process.env) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      if (req.method !== 'POST') throw new CommerceError(405, 'Use POST.');
      if (!env.RAZORPAY_WEBHOOK_SECRET) throw new CommerceError(503, 'Webhook is not configured.');
      const signature = req.headers['x-razorpay-signature'];
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262144) throw new CommerceError(413, 'Webhook too large.');
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks);
      if (!verifyWebhookSignature(env.RAZORPAY_WEBHOOK_SECRET, raw, signature)) throw new CommerceError(401, 'Invalid webhook signature.');
      let event;
      try { event = JSON.parse(raw.toString('utf8')); }
      catch { throw new CommerceError(400, 'Invalid webhook body.'); }
      const providerId = req.headers['x-razorpay-event-id'] || createHash('sha256').update(raw).digest('hex');
      const eventId = `razorpay:${createHash('sha256').update(String(providerId)).digest('hex')}`;
      if (['refund.created', 'refund.processed', 'refund.failed'].includes(event?.event)) {
        await applyProviderRefund(env, event.payload?.refund?.entity, eventId);
        return send(200, { received: true });
      }
      if (!['payment.captured', 'payment.authorized', 'payment.failed', 'order.paid'].includes(event?.event)) {
        return send(200, { received: true, ignored: true });
      }
      const payment = event.payload?.payment?.entity;
      if (!payment?.order_id) throw new CommerceError(400, 'Missing provider payment.');
      const expected = event.event === 'order.paid' ? 'captured' : event.event.split('.')[1];
      if (payment.status !== expected) throw new CommerceError(400, 'Payment event status does not match.');
      await applyProviderPayment(env, payment, eventId, 'webhook');
      return send(200, { received: true });
    } catch (error) {
      if (error.status) return send(error.status, { error: error.message });
      console.error('Payment webhook error:', error.code ?? error.name, error.message);
      return send(503, { error: 'Webhook processing failed; retry later.' });
    }
  };
}
