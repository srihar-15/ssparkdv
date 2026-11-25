import {
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  inMemoryPersistence,
  reauthenticateWithCredential,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile,
} from 'firebase/auth';
import { firebaseAuth } from './firebase';

export interface AccountUser {
  id: string;
  uid?: string;
  email: string;
  mobile: string | null;
  name: string;
  created_at: string;
  order_staff?: boolean;
  roles?: string[];
  permissions?: string[];
  sign_in_provider?: 'password' | 'phone' | 'google';
}

const sessionUrl = '/api/commerce/session';

async function sessionRequest(body?: Record<string, string>, method = body ? 'POST' : 'GET'): Promise<AccountUser | null> {
  const response = await fetch(sessionUrl, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !('user' in data)) {
    throw new Error(data?.error || 'The account service is unavailable. Try again shortly.');
  }
  return data.user;
}

function readableAuthError(error: unknown): Error {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') return new Error('Invalid sign-in details.');
  if (code === 'auth/email-already-in-use') return new Error('That email address is already registered.');
  if (code === 'auth/weak-password') return new Error('Use a stronger password with at least eight characters.');
  if (code === 'auth/operation-not-allowed') return new Error('This sign-in method is not enabled.');
  if (code === 'auth/too-many-requests') return new Error('Too many attempts. Try again later.');
  if (code === 'auth/requires-recent-login') return new Error('Sign in again before changing your password.');
  return error instanceof Error ? error : new Error('Sign-in failed. Try again.');
}

/** Firebase Authentication owns credentials; the API issues a host-only HttpOnly session. */
export async function authRequest(action?: string, fields: Record<string, string> = {}): Promise<AccountUser | null> {
  if (!action) return sessionRequest();
  const auth = firebaseAuth;
  try {
    if (action === 'sign-out') {
      const result = await sessionRequest({ action: 'sign-out' });
      await signOut(auth).catch(() => {});
      return result;
    }
    if (action === 'update-profile') return sessionRequest({ action, name: fields.name || '', ...(fields.mobile ? { mobile: fields.mobile } : {}) });
    if (action === 'google-sign-in' || action === 'phone-sign-in') {
      if (!fields.idToken) throw new Error('Complete authentication first.');
      return sessionRequest({ idToken: fields.idToken, ...(fields.name ? { name: fields.name } : {}) });
    }

    // The browser does not retain Firebase credentials after the page closes.
    await setPersistence(auth, inMemoryPersistence);
    if (action === 'sign-up') {
      const email = (fields.email || '').trim().toLowerCase();
      const credential = await createUserWithEmailAndPassword(auth, email, fields.password || '');
      if (fields.name) await updateProfile(credential.user, { displayName: fields.name.trim() });
      const result = await sessionRequest({ idToken: await credential.user.getIdToken(true), name: fields.name || '', mobile: fields.mobile || '' });
      await signOut(auth).catch(() => {});
      return result;
    }
    if (action === 'sign-in') {
      const identifier = (fields.identifier || fields.email || '').trim().toLowerCase();
      const email = identifier === 'admin' ? 'admin@sparkdv.invalid' : identifier;
      if (!email.includes('@')) throw new Error('Use your email address, or sign in with a mobile OTP.');
      const credential = await signInWithEmailAndPassword(auth, email, fields.password || '');
      const result = await sessionRequest({ idToken: await credential.user.getIdToken(true) });
      await signOut(auth).catch(() => {});
      return result;
    }
    if (action === 'change-password') {
      const existing = await sessionRequest();
      if (!existing?.email) throw new Error('Sign in again to change your password.');
      const credential = await signInWithEmailAndPassword(auth, existing.email, fields.currentPassword || '');
      await reauthenticateWithCredential(credential.user, EmailAuthProvider.credential(existing.email, fields.currentPassword || ''));
      await updatePassword(credential.user, fields.password || '');
      await signOut(auth);
      return sessionRequest({ action: 'sign-out' });
    }
    throw new Error('Unknown account action.');
  } catch (error) {
    throw readableAuthError(error);
  }
}
