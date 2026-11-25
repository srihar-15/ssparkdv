import { createServer } from 'node:http';
import { createCatalogHandler } from './commerce/catalog.js';
import { createAdminHandler } from './commerce/admin.js';
import { createCommerceSessionHandler } from './commerce/session.js';
import { createOrdersHandler } from './orders.js';
import { createPaymentWebhook } from './payment-events.js';
import { createFulfillmentWorker, createShiprocketWebhook } from './commerce/fulfillment.js';
import { createMediaHandler } from './commerce/media.js';
import { createCartHandler } from './commerce/cart.js';
import { createPreferencesHandler } from './commerce/preferences.js';

const env = process.env;
const routes = [
  ['/internal/fulfillment', createFulfillmentWorker(env)],
  ['/api/commerce/session', createCommerceSessionHandler(env)],
  ['/api/payments/webhook', createPaymentWebhook(env)],
  ['/api/shipping/webhook', createShiprocketWebhook(env)],
  ['/api/media', createMediaHandler(env)],
  ['/api/cart', createCartHandler(env)],
  ['/api/commerce/preferences', createPreferencesHandler(env)],
  ['/api/catalog', createCatalogHandler(env)],
  ['/api/admin', createAdminHandler(env)],
  ['/api/orders', createOrdersHandler(env, true)],
];

const server = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ready' }));
    return;
  }
  const match = routes.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix + '/'));
  if (!match) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  const [prefix, handler] = match;
  req.originalUrl = req.url;
  req.url = req.url.slice(prefix.length) || '/';
  Promise.resolve(handler(req, res)).catch(error => {
    console.error('API handler error:', error);
    if (!res.headersSent) res.statusCode = 500;
    if (!res.writableEnded) res.end('Internal server error');
  });
});

const port = Number(env.PORT || 8080);
server.listen(port, '0.0.0.0', () => console.log(`SPARK DV API listening on ${port}`));
