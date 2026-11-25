import { createClient } from '@libsql/client';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firebasePassword } from './firebase-password.js';

const issuer = 'sparkdv';
const audience = 'sparkdv-storefront';
const cookieName = 'sparkdv_session';
const lifetime = 7 * 24 * 60 * 60;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function localSecret(directory) {
  const file = resolve(directory, 'auth-secret');
  try {
    writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readFileSync(file, 'utf8').trim();
}

async function openStore(env, deployed) {
  const url = env.AUTH_DATABASE_URL?.trim() || env.TURSO_DATABASE_URL?.trim();
  const authToken = env.AUTH_DATABASE_TOKEN?.trim() || env.TURSO_AUTH_TOKEN?.trim();
  const configuredSecret = env.AUTH_JWT_SECRET?.trim();
  if (deployed && (!url || !/^(libsql|https):\/\//.test(url) || !authToken || !configuredSecret)) {
    throw new Error('Vercel authentication requires a remote database and a signing secret');
  }

  const directory = resolve(env.AUTH_DATA_DIR || '.data');
  if (!url || !configuredSecret) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secret = new TextEncoder().encode(configuredSecret || localSecret(directory));
  if (secret.length < 32) throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes');

  const db = createClient({ url: url || pathToFileURL(resolve(directory, 'auth.sqlite')).href, authToken });
  await db.batch([
    `CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, mobile TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS auth_limits (
      id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`,
  ], 'write');
  const { rows: userColumns } = await db.execute('PRAGMA table_info(auth_users)');
  if (!userColumns.some(column => column.name === 'mobile')) {
    try {
      await db.execute('ALTER TABLE auth_users ADD COLUMN mobile TEXT');
    } catch (error) {
      // Another server instance may have added the column after the schema check.
      const { rows } = await db.execute('PRAGMA table_info(auth_users)');
      if (!rows.some(column => column.name === 'mobile')) throw error;
    }
  }
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS auth_users_mobile ON auth_users(mobile)');
  return { db, secret };
}

function requirePassword(password, isNew = false) {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 256 || (isNew && password.length < 8)) {
    throw new AuthError(400, isNew ? 'Use a password with at least 8 characters and at most 256 bytes.' : 'Enter your password.');
  }
}

function normalizeMobile(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const number = value.trim().replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(number)) return `+91${number}`;
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}

function publicUser({ id, email, name, created_at, mobile }) {
  return { id, email, name, created_at, mobile: mobile ?? null };
}

function sendSessionCookie(res, token, secure) {
  res.setHeader('Set-Cookie', `${res.authCookieName || cookieName}=${token}; Path=${res.authCookiePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${token ? lifetime : 0}${secure ? '; Secure' : ''}`);
}

async function sessionClaims(req, secret) {
  const selectedCookie = req.url.startsWith('/pipeline/') || /^app\.(localhost|sparkdv\.com)(:|$)/.test(req.headers.host || '') ? 'sparkdv_staff_session' : cookieName;
  const token = req.headers.cookie?.split('; ').find(part => part.startsWith(`${selectedCookie}=`))?.slice(selectedCookie.length + 1);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'], issuer, audience, requiredClaims: ['sub', 'jti', 'iat', 'exp'],
    });
    return payload;
  } catch {
    return null;
  }
}

async function startSession(db, secret, user, res, secure, provider = 'password') {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expires = now + lifetime;
  const token = await new SignJWT({ provider }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer).setAudience(audience).setSubject(user.id).setJti(id)
    .setIssuedAt(now).setExpirationTime(expires).sign(secret);
  const [, insert] = await db.batch([
    { sql: 'DELETE FROM auth_sessions WHERE expires_at <= ?', args: [now] },
    { sql: 'INSERT INTO auth_sessions SELECT ?, id, ? FROM auth_users WHERE id = ? AND password_hash = ?', args: [id, expires, user.id, user.password_hash] },
  ], 'write');
  if (!insert.rowsAffected) throw new AuthError(401, 'Please sign in again.');
  sendSessionCookie(res, token, secure);
  return { user: { ...publicUser(user), sign_in_provider: provider } };
}

async function limitAttempts(db, req, action, deployed) {
  const ip = (deployed && req.headers['x-vercel-forwarded-for']) || req.socket.remoteAddress || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const [, result] = await db.batch([
    { sql: 'DELETE FROM auth_limits WHERE expires_at <= ?', args: [now] },
    { sql: `INSERT INTO auth_limits (id, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`, args: [`${action}:${ip}`, now + 15 * 60] },
  ], 'write');
  if (Number(result.rows[0].attempts) > (action === 'sign-in' ? 30 : 12)) {
    throw new AuthError(429, 'Too many attempts. Try again in a few minutes.');
  }
}

export async function readBody(req) {
  if (Number(req.headers['content-length']) > 8192) throw new AuthError(413, 'Request is too large.');
  const type = req.headers['content-type']?.split(';')[0];
  if (type !== 'application/json') throw new AuthError(415, 'Use a JSON request.');
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new AuthError(413, 'Request is too large.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(req.body || Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AuthError(400, 'Invalid request.');
  }
}

export function createStoreAccess(env, deployed) {
  let store;
  return () => store ??= openStore(env, deployed).catch(error => { store = undefined; throw error; });
}

export async function sessionUser(req, { db, secret }) {
  const claims = await sessionClaims(req, secret);
  if (!claims) return null;
  const { rows } = await db.execute({
    sql: 'SELECT u.id, u.email, u.name, u.created_at, u.mobile FROM auth_users u JOIN auth_sessions s ON s.user_id = u.id WHERE s.id = ? AND u.id = ? AND s.expires_at > ?',
    args: [claims.jti, claims.sub, Math.floor(Date.now() / 1000)],
  });
  return rows[0] ? { ...publicUser(rows[0]), sign_in_provider: claims.provider || 'password' } : null;
}

export function isOrderStaff(env, userId) {
  // Firebase UID of the provisioned SPARK-DV Pipeline administrator.
  if (userId === 'ZKhCji5uItQS8DUJgEcADzZEz8W2') return true;
  return (env.ORDER_STAFF_USER_IDS ?? '').split(',').some(id => id.trim() === userId);
}

export function requireStorefrontRequest(req, res, deployed) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    throw new AuthError(405, 'Method not allowed.');
  }
  const secure = deployed || Boolean(req.socket.encrypted);
  if (req.method === 'POST' && req.headers.origin !== `${secure ? 'https' : 'http'}://${req.headers.host}`) {
    throw new AuthError(403, 'This request must come from the storefront.');
  }
  return secure;
}

export function createAuthHandler(env, deployed = false, getStore = createStoreAccess(env, deployed)) {

  return async (req, res) => {
    const staffSurface = req.url.startsWith('/pipeline/') || /^app\.(localhost|sparkdv\.com)(:|$)/.test(req.headers.host || '');
    res.authCookieName = staffSurface ? 'sparkdv_staff_session' : cookieName;
    res.authCookiePath = req.url.startsWith('/pipeline/') ? '/pipeline' : '/';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, body) => {
      if (body.user) body.user.order_staff = isOrderStaff(env, body.user.id);
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    try {
      const secure = requireStorefrontRequest(req, res, deployed);
      const { db, secret } = await getStore();
      if (req.method === 'GET') {
        return send(200, { user: await sessionUser(req, { db, secret }) });
      }

      const { action, password, currentPassword, ...fields } = (await readBody(req)) ?? {};
      if (action === 'update-profile') {
        const user = await sessionUser(req, {db,secret});
        if (!user) throw new AuthError(401, 'Sign in to edit your profile.');
        const name = typeof fields.name === 'string' ? fields.name.trim() : '';
        if (!name || name.length > 100) throw new AuthError(400, 'Enter a name between 1 and 100 characters.');
        await db.execute({sql:'UPDATE auth_users SET name = ? WHERE id = ?',args:[name,user.id]});
        return send(200,{user:{...user,name}});
      }
      if (action === 'sign-out') {
        const claims = await sessionClaims(req, secret);
        if (claims) await db.execute({ sql: 'DELETE FROM auth_sessions WHERE id = ? AND user_id = ?', args: [claims.jti, claims.sub] });
        sendSessionCookie(res, '', secure);
        return send(200, { user: null });
      }
      if (action === 'google-sign-in') {
        if (staffSurface) throw new AuthError(403, 'Use your staff credentials in the pipeline app.');
        await limitAttempts(db, req, action, deployed);
        if (typeof fields.idToken !== 'string' || !fields.idToken || fields.idToken.length > 6000) throw new AuthError(400, 'Complete Google sign-in first.');
        const result = await firebasePassword('lookup', { idToken: fields.idToken }, env.AUTH_FIREBASE_API_KEY);
        const identity = result.users?.[0];
        const google = identity?.providerUserInfo?.find(provider => provider.providerId === 'google.com');
        if (!identity?.localId || identity.disabled || !identity.emailVerified || !google || typeof identity.email !== 'string') throw new AuthError(401, 'Sign in with a verified Google account.');
        const email = identity.email.trim().toLowerCase();
        if (!email || email.length > 254) throw new AuthError(401, 'Your Google account needs a valid email address.');
        const {rows:[existing]} = await db.execute({sql:'SELECT * FROM auth_users WHERE id = ? OR email = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1',args:[identity.localId,email,identity.localId]});
        if (existing && existing.id !== identity.localId) throw new AuthError(409, 'This email belongs to an existing account. Use your original sign-in method and contact support to link Google.');
        if (!existing) {
          const name = (identity.displayName || google.displayName || email.split('@')[0]).slice(0,100);
          await db.execute({sql:'INSERT INTO auth_users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',args:[identity.localId,email,name,randomUUID(),new Date().toISOString()]});
        }
        const {rows:[user]} = await db.execute({sql:'SELECT * FROM auth_users WHERE id = ?',args:[identity.localId]});
        if (!user) throw new AuthError(409, 'Use your existing sign-in method for this account.');
        return send(200, await startSession(db, secret, user, res, secure, 'google'));
      }
      if (action === 'phone-sign-in') {
        if (staffSurface) throw new AuthError(403, 'Use your staff credentials in the pipeline app.');
        await limitAttempts(db, req, action, deployed);
        if (typeof fields.idToken !== 'string' || fields.idToken.length > 6000) throw new AuthError(400, 'Verify your mobile number first.');
        const result = await firebasePassword('lookup', { idToken: fields.idToken }, env.AUTH_FIREBASE_API_KEY);
        const identity = result.users?.[0];
        const mobile = normalizeMobile(identity?.phoneNumber);
        if (!identity?.localId || !mobile || identity.disabled) throw new AuthError(401, 'Verify your mobile number first.');
        const { rows: [existing] } = await db.execute({sql:'SELECT * FROM auth_users WHERE id = ? OR mobile = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1',args:[identity.localId,mobile,identity.localId]});
        if (existing && existing.id !== identity.localId) throw new AuthError(409, 'This mobile number belongs to an existing password account. Sign in with your password and contact support to link phone sign-in.');
        const name = typeof fields.name === 'string' ? fields.name.trim().slice(0,100) : '';
        if (!existing && !name) throw new AuthError(400, 'Enter your name to create your account.');
        if (!existing) await db.execute({sql:'INSERT INTO auth_users (id,email,name,password_hash,created_at,mobile) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',args:[identity.localId,identity.email || identity.localId+'@phone.sparkdv.invalid',name,randomUUID(),new Date().toISOString(),mobile]});
        const {rows:[user]} = await db.execute({sql:'SELECT * FROM auth_users WHERE id = ?',args:[identity.localId]});
        if (!user) throw new AuthError(409, 'This mobile number is already registered. Use your existing sign-in method.');
        return send(200, await startSession(db, secret, user, res, secure, 'phone'));
      }
      if (!['sign-in', 'sign-up', 'change-password'].includes(action)) throw new AuthError(400, 'Unknown account action.');
      await limitAttempts(db, req, action, deployed);
      requirePassword(password, action !== 'sign-in');

      if (action === 'change-password') {
        const claims = await sessionClaims(req, secret);
        if (!claims) throw new AuthError(401, 'Sign in again to change your password.');
        requirePassword(currentPassword);
        const { rows: [user] } = await db.execute({
          sql: 'SELECT u.id,u.email,u.password_hash FROM auth_users u JOIN auth_sessions s ON s.user_id = u.id WHERE s.id = ? AND u.id = ?', args: [claims.jti, claims.sub],
        });
        if (!user) throw new AuthError(401, 'Sign in again.');
        const credential = await firebasePassword('signInWithPassword', { email: user.email, password: currentPassword }, env.AUTH_FIREBASE_API_KEY);
        if (credential.localId !== user.id) throw new AuthError(401, 'Sign in again.');
        await firebasePassword('update', { idToken: credential.idToken, password }, env.AUTH_FIREBASE_API_KEY);
        const [updated] = await db.batch([
          { sql: 'UPDATE auth_users SET password_hash = ? WHERE id = ? AND password_hash = ?', args: [randomUUID(), claims.sub, user.password_hash] },
          { sql: 'DELETE FROM auth_sessions WHERE user_id = ?', args: [claims.sub] },
        ], 'write');
        if (!updated.rowsAffected) throw new AuthError(409, 'Your password changed. Sign in and try again.');
        sendSessionCookie(res, '', secure);
        return send(200, { user: null });
      }

      if (action === 'sign-up') {
        const email = typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : '';
        const name = typeof fields.name === 'string' ? fields.name.trim() : '';
        const mobile = normalizeMobile(fields.mobile);
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(400, 'Enter a valid email address.');
        if (!name || name.length > 100) throw new AuthError(400, 'Enter your name using 100 characters or fewer.');
        if (!mobile) throw new AuthError(400, 'Enter a 10-digit Indian mobile number or include the country code.');
        if ((await db.execute({sql:'SELECT id FROM auth_users WHERE email = ? OR mobile = ?',args:[email,mobile]})).rows.length) throw new AuthError(409,'That email or mobile number is already registered.');
        const identity = await firebasePassword('signUp', { email, password, displayName: name }, env.AUTH_FIREBASE_API_KEY);
        const user = { id: identity.localId, email, name, mobile, password_hash: randomUUID(), created_at: new Date().toISOString() };
        const created = await db.execute({
          sql: 'INSERT INTO auth_users (id, email, name, mobile, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          args: [user.id, user.email, user.name, user.mobile, user.password_hash, user.created_at],
        });
        if (!created.rowsAffected) throw new AuthError(409, 'That email address or mobile number is already registered.');
        return send(201, await startSession(db, secret, user, res, secure));
      }

      const identifier = fields.identifier ?? fields.email;
      const login = typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
      const email = login === 'admin' ? 'admin@sparkdv.invalid' : login.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) ? login : null;
      const mobile = normalizeMobile(login);
      if (!email && !mobile) throw new AuthError(400, 'Enter a valid email address or mobile number.');
      const { rows: [profile] } = await db.execute({ sql: 'SELECT * FROM auth_users WHERE email = ? OR mobile = ?', args: [email, mobile] });
      if (!email && !profile) throw new AuthError(401, 'Invalid sign-in details.');
      const identity = await firebasePassword('signInWithPassword', { email: email || profile.email, password }, env.AUTH_FIREBASE_API_KEY);
      if (profile && profile.id !== identity.localId) throw new AuthError(409, 'This account requires migration. Contact support.');
      await db.execute({sql:'INSERT INTO auth_users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',args:[identity.localId,identity.email,identity.displayName || (login === 'admin' ? 'Admin' : identity.email),randomUUID(),new Date().toISOString()]});
      const {rows:[user]} = await db.execute({sql:'SELECT * FROM auth_users WHERE id = ?',args:[identity.localId]});
      return send(200, await startSession(db, secret, user, res, secure));
    } catch (error) {
      if (error instanceof AuthError) return send(error.status, { error: error.message });
      if (['INVALID_LOGIN_CREDENTIALS','EMAIL_NOT_FOUND','INVALID_PASSWORD','USER_DISABLED','INVALID_ID_TOKEN','TOKEN_EXPIRED'].includes(error.code)) return send(401,{error:'Invalid or expired sign-in details. Please sign in again.'});
      if (error.code === 'EMAIL_EXISTS') return send(409,{error:'This email is already registered.'});
      console.error('Account service error:', error.code ?? error.name);
      return send(503, { error: 'The account service is unavailable. Try again shortly.' });
    }
  };
}
