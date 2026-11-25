import { createPaymentWebhook } from '../../server/payment-events.js';

export default createPaymentWebhook(process.env);
