import {defineConfig, loadEnv} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath, URL} from 'node:url';
import {createAuthHandler, createStoreAccess} from './server/auth.js';
import {createPaymentWebhook} from './server/payment-events.js';
import {createOrdersHandler} from './server/orders.js';
import {createCatalogHandler} from './server/commerce/catalog.js';
import {createAdminHandler} from './server/commerce/admin.js';
import {createCommerceSessionHandler} from './server/commerce/session.js';
import {createShiprocketWebhook} from './server/commerce/fulfillment.js';
import {createMediaHandler} from './server/commerce/media.js';
import {createCartHandler} from './server/commerce/cart.js';
import {createPreferencesHandler} from './server/commerce/preferences.js';

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), ['AUTH_', 'ORDER_', 'RESEND_', 'RAZORPAY_', 'SHIPROCKET_', 'COMMERCE_', 'FIREBASE_']) };
  const getStore = createStoreAccess(env, false);
  const auth = createAuthHandler(env, false, getStore);
  const orders = createOrdersHandler(env, false);
  const mountApi = server => {
    server.middlewares.use('/api/payments/webhook', createPaymentWebhook(env));
    server.middlewares.use('/api/shipping/webhook', createShiprocketWebhook(env));
    server.middlewares.use('/api/commerce/session', createCommerceSessionHandler(env));
    server.middlewares.use('/api/media', createMediaHandler(env));
    server.middlewares.use('/api/cart', createCartHandler(env));
    server.middlewares.use('/api/commerce/preferences', createPreferencesHandler(env));
    server.middlewares.use('/api/catalog', createCatalogHandler(env));
    server.middlewares.use('/api/admin', createAdminHandler(env));
    server.middlewares.use('/api/auth', auth);
    server.middlewares.use('/api/orders', orders);
  };
  return {
  plugins: [react(), tailwindcss(), { name: 'sparkdv-api', configureServer: mountApi, configurePreviewServer: mountApi }],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.endsWith('source-content.json')) return 'source-content';
        }
      }
    }
  }
  };
});
