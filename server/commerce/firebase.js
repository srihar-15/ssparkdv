import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const APP_NAME = 'sparkdv-commerce';
const DATABASE_ID = 'commerce';

const ROLE_PERMISSIONS = Object.freeze({
  owner: ['*'],
  catalog: ['catalog.read', 'catalog.write', 'inventory.read', 'inventory.adjust', 'content.read', 'content.write'],
  fulfillment: ['orders.read', 'orders.manage', 'shipments.manage', 'inventory.read'],
  support: ['orders.read', 'customers.read'],
  finance: ['orders.read', 'refunds.manage', 'settings.read', 'settings.write'],
});

let legacyStore;

function config(env = process.env) {
  return { ...process.env, ...env };
}

function commerceApp(env = process.env) {
  const existing = getApps().find(app => app.name === APP_NAME);
  if (existing) return existing;
  const values = config(env);
  const projectId = values.COMMERCE_FIREBASE_PROJECT_ID || values.VITE_FIREBASE_PROJECT_ID || values.GCLOUD_PROJECT || values.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('COMMERCE_FIREBASE_PROJECT_ID or VITE_FIREBASE_PROJECT_ID is required.');
  const emulator = values.FIRESTORE_EMULATOR_HOST || values.FIREBASE_AUTH_EMULATOR_HOST;
  return initializeApp({ projectId, ...(!emulator && { credential: applicationDefault() }) }, APP_NAME);
}

export function getCommerceDb(env = process.env) {
  return getFirestore(commerceApp(env), config(env).COMMERCE_FIRESTORE_DATABASE || DATABASE_ID);
}

export function getCommerceAuth(env = process.env) {
  return getAuth(commerceApp(env));
}

export function getCommerceStorage(env = process.env) {
  return getStorage(commerceApp(env));
}

function cookie(req, name) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}

async function verifiedIdentity(req, env) {
  const auth = getCommerceAuth(env);
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (bearer) {
    try { return await auth.verifyIdToken(bearer, true); } catch { return null; }
  }
  const session = cookie(req, 'sparkdv_commerce_session');
  if (session) {
    try { return await auth.verifySessionCookie(session, true); } catch { return null; }
  }
  if (config(env).COMMERCE_ALLOW_LEGACY_SESSION !== '1') return null;
  if (!cookie(req, 'sparkdv_session') && !cookie(req, 'sparkdv_staff_session')) return null;
  const { createStoreAccess, sessionUser } = await import('../auth.js');
  legacyStore ??= createStoreAccess(env, Boolean(process.env.VERCEL));
  const user = await sessionUser(req, await legacyStore());
  return user && { uid: user.id, email: user.email, name: user.name, legacy: true };
}

export async function verifyCommerceActor(req, env = process.env) {
  const identity = await verifiedIdentity(req, env);
  if (!identity?.uid) return null;
  const db = getCommerceDb(env);
  const [profile, staff] = await Promise.all([
    db.collection('users').doc(identity.uid).get(),
    db.collection('staff').doc(identity.uid).get(),
  ]);
  const values = config(env);
  const grant = staff.exists && staff.data().active !== false ? staff.data() : null;
  const roles = new Set(Array.isArray(grant?.roles) ? grant.roles.filter(role => ROLE_PERMISSIONS[role]) : []);
  if (values.COMMERCE_OWNER_UID && identity.uid === values.COMMERCE_OWNER_UID) roles.add('owner');
  // The legacy staff grant may manage orders during the migration, never the whole admin.
  if (identity.legacy && values.COMMERCE_ALLOW_LEGACY_SESSION === '1') {
    const { isOrderStaff } = await import('../auth.js');
    if (isOrderStaff(env, identity.uid)) roles.add('fulfillment');
  }
  const permissions = [...new Set([...roles].flatMap(role => ROLE_PERMISSIONS[role]))];
  const data = profile.exists ? profile.data() : {};
  const provider = identity.firebase?.sign_in_provider || data.signInProvider || null;
  return {
    uid: identity.uid,
    email: identity.email || data.email || null,
    name: data.name || identity.name || identity.email?.split('@')[0] || 'Customer',
    mobile: data.mobile || identity.phone_number || null,
    created_at: data.createdAt || null,
    sign_in_provider: provider === 'google.com' ? 'google' : provider === 'phone' || provider === 'password' ? provider : null,
    roles: [...roles],
    permissions,
    order_staff: permissions.includes('*') || permissions.includes('orders.manage'),
  };
}

export async function requireCommercePermission(req, permission, env = process.env) {
  const actor = await verifyCommerceActor(req, env);
  if (!actor) throw Object.assign(new Error('Sign in required.'), { status: 401 });
  if (!actor.permissions.includes('*') && !actor.permissions.includes(permission)) {
    throw Object.assign(new Error('Staff access required.'), { status: 403 });
  }
  return actor;
}

export function publicCommerceUser(actor) {
  if (!actor) return null;
  return { id: actor.uid, uid: actor.uid, email: actor.email, name: actor.name, mobile: actor.mobile,
    created_at: actor.created_at, sign_in_provider: actor.sign_in_provider,
    roles: actor.roles, permissions: actor.permissions, order_staff: actor.order_staff };
}
