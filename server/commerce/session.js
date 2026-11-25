import { getCommerceAuth, getCommerceDb, publicCommerceUser, verifyCommerceActor } from './firebase.js';
import { CommerceError, methodAllowed, readJson, requireSameOrigin, sendCommerceError, sendJson } from './http.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'sparkdv_commerce_session';

function sessionCookie(req, value, maxAge) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.VERCEL);
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function nameFrom(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : fallback;
  if (!name || name.length > 100) throw new CommerceError(400, 'Enter a name using 100 characters or fewer.');
  return name;
}

function mobileFrom(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new CommerceError(400, 'Enter a valid mobile number.');
  const normal = value.trim().replace(/[\s().-]/g, '');
  const mobile = /^\d{10}$/.test(normal) ? `+91${normal}` : normal;
  if (!/^\+[1-9]\d{7,14}$/.test(mobile)) throw new CommerceError(400, 'Enter a valid mobile number.');
  return mobile;
}

async function upsertProfile(db, decoded, fields = {}) {
  const ref = db.collection('users').doc(decoded.uid);
  const current = await ref.get();
  const existing = current.exists ? current.data() : {};
  const now = new Date().toISOString();
  const profile = {
    uid: decoded.uid,
    email: decoded.email || existing.email || null,
    name: nameFrom(fields.name, existing.name || decoded.name || decoded.email?.split('@')[0] || 'Customer'),
    mobile: fields.mobile !== undefined ? mobileFrom(fields.mobile) : existing.mobile || decoded.phone_number || null,
    signInProvider: decoded.firebase?.sign_in_provider || existing.signInProvider || null,
    updatedAt: now,
    ...(!current.exists && { createdAt: now }),
  };
  await ref.set(profile, { merge: true });
}

export function createCommerceSessionHandler(env = process.env) {
  return async (req, res) => {
    try {
      methodAllowed(req, ['GET', 'POST', 'DELETE']);
      if (req.method === 'GET') return sendJson(res, 200, { user: publicCommerceUser(await verifyCommerceActor(req, env)) });
      requireSameOrigin(req);
      if (req.method === 'DELETE') {
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        return sendJson(res, 200, { user: null });
      }
      const body = await readJson(req, 16384);
      if (body?.action === 'sign-out') {
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        return sendJson(res, 200, { user: null });
      }
      if (body?.action === 'update-profile') {
        const actor = await verifyCommerceActor(req, env);
        if (!actor) throw new CommerceError(401, 'Sign in required.');
        if (body.name === undefined && body.mobile === undefined) throw new CommerceError(400, 'Nothing to update.');
        await upsertProfile(getCommerceDb(env), { uid: actor.uid, email: actor.email, name: actor.name }, body);
        return sendJson(res, 200, { user: publicCommerceUser(await verifyCommerceActor(req, env)) });
      }
      if (typeof body?.idToken !== 'string' || body.idToken.length > 8192) throw new CommerceError(400, 'Firebase sign-in token required.');
      const auth = getCommerceAuth(env);
      let decoded;
      try { decoded = await auth.verifyIdToken(body.idToken, true); }
      catch { throw new CommerceError(401, 'Invalid or expired sign-in token.'); }
      if (Date.now() / 1000 - decoded.auth_time > 5 * 60) throw new CommerceError(401, 'Sign in again to start a session.');
      await upsertProfile(getCommerceDb(env), decoded, body);
      const session = await auth.createSessionCookie(body.idToken, { expiresIn: WEEK_MS });
      res.setHeader('Set-Cookie', sessionCookie(req, session, Math.floor(WEEK_MS / 1000)));
      // The new cookie is not part of this request, so use the verified token for the response.
      req.headers.authorization = `Bearer ${body.idToken}`;
      return sendJson(res, 200, { user: publicCommerceUser(await verifyCommerceActor(req, env)) });
    } catch (error) { return sendCommerceError(res, error); }
  };
}
