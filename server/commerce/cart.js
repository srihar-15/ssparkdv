import { createHash, randomBytes } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { getCommerceDb, verifyCommerceActor } from './firebase.js';
import { CommerceError, methodAllowed, readJson, requireSameOrigin, sendCommerceError, sendJson } from './http.js';

const COOKIE = 'sparkdv_guest_cart';
const THIRTY_DAYS = 30 * 24 * 60 * 60;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function cookie(req, name) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}

function guestCookie(req, value, maxAge) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.VERCEL);
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function validatedItems(items) {
  if (!Array.isArray(items) || items.length > 100) throw new CommerceError(400, 'Invalid cart items.');
  const seen = new Set();
  return items.map(({ slug, qty } = {}) => {
    if (typeof slug !== 'string' || !slugPattern.test(slug) || seen.has(slug) || !Number.isInteger(qty) || qty < 1 || qty > 99)
      throw new CommerceError(400, 'Invalid cart product or quantity.');
    seen.add(slug);
    return { slug, qty };
  });
}

function mergedItems(primary, guest) {
  const map = new Map();
  for (const item of [...primary, ...guest]) map.set(item.slug, Math.min(99, (map.get(item.slug) || 0) + item.qty));
  return [...map].map(([slug, qty]) => ({ slug, qty }));
}

function userCartId(uid) {
  return 'user_' + createHash('sha256').update(uid).digest('hex');
}

export function createCartHandler(env = process.env) {
  return async (req, res) => {
    try {
      methodAllowed(req, ['GET', 'PUT']);
      const db = getCommerceDb(env);
      const actor = await verifyCommerceActor(req, env);
      const guest = cookie(req, COOKIE);
      const guestId = guest && /^[A-Za-z0-9_-]{32}$/.test(guest) ? `guest_${guest}` : null;
      if (req.method === 'GET') {
        if (actor) {
          const userRef = db.collection('carts').doc(userCartId(actor.uid));
          if (guestId) {
            const guestRef = db.collection('carts').doc(guestId);
            const items = await db.runTransaction(async tx => {
              const [userDoc, guestDoc] = await Promise.all([tx.get(userRef), tx.get(guestRef)]);
              const current = validatedItems(userDoc.data()?.items || []);
              const previous = validatedItems(guestDoc.data()?.items || []);
              const merged = mergedItems(current, previous);
              if (guestDoc.exists) {
                tx.set(userRef, { ownerUid: actor.uid, items: merged, updatedAt: new Date().toISOString() }, { merge: true });
                tx.delete(guestRef);
              }
              return merged;
            });
            res.setHeader('Set-Cookie', guestCookie(req, '', 0));
            return sendJson(res, 200, { items });
          }
          const doc = await userRef.get();
          return sendJson(res, 200, { items: validatedItems(doc.data()?.items || []) });
        }
        if (!guestId) return sendJson(res, 200, { items: [] });
        const doc = await db.collection('carts').doc(guestId).get();
        return sendJson(res, 200, { items: validatedItems(doc.data()?.items || []) });
      }
      requireSameOrigin(req);
      const body = await readJson(req, 16384);
      const items = validatedItems(body?.items);
      const now = new Date().toISOString();
      if (actor) {
        await db.collection('carts').doc(userCartId(actor.uid)).set({ ownerUid: actor.uid, items, updatedAt: now }, { merge: true });
        return sendJson(res, 200, { items });
      }
      const token = guestId ? guest : randomBytes(24).toString('base64url');
      const ref = db.collection('carts').doc(`guest_${token}`);
      await ref.set({ items, updatedAt: now, expiresAt: Timestamp.fromDate(new Date(Date.now() + THIRTY_DAYS * 1000)) }, { merge: true });
      res.setHeader('Set-Cookie', guestCookie(req, token, THIRTY_DAYS));
      return sendJson(res, 200, { items });
    } catch (error) { return sendCommerceError(res, error); }
  };
}
