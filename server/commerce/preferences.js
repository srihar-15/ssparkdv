import { getCommerceDb, verifyCommerceActor } from './firebase.js';
import { CommerceError, methodAllowed, readJson, requireSameOrigin, sendCommerceError, sendJson } from './http.js';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function productSlugs(value, max) {
  if (!Array.isArray(value) || value.length > max || value.some(slug => typeof slug !== 'string' || !slugPattern.test(slug) || slug.length > 100))
    throw new CommerceError(400, 'Invalid product preferences.');
  if (new Set(value).size !== value.length) throw new CommerceError(400, 'Product preferences must be unique.');
  return value;
}

function preferenceData(data = {}) {
  return {
    recentProducts: productSlugs(data.recentProducts || [], 20),
    favorites: productSlugs(data.favorites || [], 100),
  };
}

export function createPreferencesHandler(env = process.env) {
  return async (req, res) => {
    try {
      methodAllowed(req, ['GET', 'PUT']);
      const actor = await verifyCommerceActor(req, env);
      if (!actor) throw new CommerceError(401, 'Sign in to save your preferences.');
      const ref = getCommerceDb(env).collection('userPreferences').doc(actor.uid);
      if (req.method === 'GET') {
        const doc = await ref.get();
        return sendJson(res, 200, preferenceData(doc.data()));
      }
      requireSameOrigin(req);
      const body = await readJson(req, 16384);
      const preferences = preferenceData(body);
      await ref.set({ ...preferences, updatedAt: new Date().toISOString() }, { merge: true });
      return sendJson(res, 200, preferences);
    } catch (error) { return sendCommerceError(res, error); }
  };
}
