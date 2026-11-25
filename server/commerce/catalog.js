import { getCommerceDb } from './firebase.js';
import { CommerceError, methodAllowed, sendCommerceError, sendJson } from './http.js';

function publicProduct(product, availableStock) {
  const pricePaise = product.pricePaise ?? (product.price == null ? null : Math.round(Number(product.price) * 100));
  return {
    ...product,
    pricePaise,
    price: pricePaise == null ? null : pricePaise / 100,
    availableStock,
    // A listing can remain visible when out of stock; checkout still verifies stock.
    canBuy: product.purchaseMode === 'online' && availableStock > 0,
  };
}

export async function readPublishedProducts(db = getCommerceDb()) {
  const snapshot = await db.collection('publishedProducts').where('status', '==', 'published').get();
  const rows = snapshot.docs.map(doc => ({ ...doc.data(), slug: doc.id }));
  const stock = await Promise.all(rows.map(row => db.collection('inventory').doc(row.sku || row.slug).get()));
  return rows.map((row, i) => publicProduct(row, stock[i].exists
    ? Math.max(0, Number(stock[i].data().onHand || 0) - Number(stock[i].data().reserved || 0)) : 0))
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.name.localeCompare(b.name));
}

export function createCatalogHandler(env = process.env) {
  return async (req, res) => {
    try {
      methodAllowed(req, ['GET']);
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const db = getCommerceDb(env);
      if (url.searchParams.get('resource') === 'content') {
        const key = url.searchParams.get('page') || '';
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) throw new CommerceError(400, 'Invalid page key.');
        const doc = await db.collection('contentPublished').doc(key).get();
        return sendJson(res, 200, { page: doc.exists ? { ...doc.data(), key: doc.id } : null });
      }
      const [products, home] = await Promise.all([
        readPublishedProducts(db),
        db.collection('contentPublished').doc('home').get(),
      ]);
      const categories = ['All products', ...new Set(products.map(product => product.category).filter(Boolean))];
      return sendJson(res, 200, { products, categories, content: home.exists ? home.data() : null });
    } catch (error) { return sendCommerceError(res, error); }
  };
}
