import { useEffect, useRef, useState } from 'react';
import { getAuth, GoogleAuthProvider, inMemoryPersistence, setPersistence, signInWithPopup, signOut } from 'firebase/auth';
import { firebaseApp } from '../../lib/firebase';
import { useAuth } from '../auth-provider';
import './google-login.css';

const messages: Record<string, string> = {
  'auth/popup-blocked': 'Allow pop-ups for this site, then try Continue with Google again.',
  'auth/popup-closed-by-user': 'Google sign-in was closed. You can try again.',
  'auth/cancelled-popup-request': 'Please finish the open Google sign-in window.',
  'auth/unauthorized-domain': 'Google sign-in is not available on this website yet.',
  'auth/operation-not-allowed': 'Google sign-in is temporarily unavailable. Please use your password.',
  'auth/account-exists-with-different-credential': 'An account already uses this email. Sign in with your existing method to keep your profile and orders.',
  'auth/network-request-failed': 'Check your connection and try Google sign-in again.',
  'auth/user-disabled': 'This account is disabled. Please contact support.',
};

export default function GoogleLogin({onBusyChange}: {onBusyChange?: (busy: boolean) => void}) {
  const {changeSession} = useAuth();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setPersistence(getAuth(firebaseApp), inMemoryPersistence)
      .then(() => { if (mounted.current) setReady(true); })
      .catch(() => { if (mounted.current) setError('Google sign-in could not start. Refresh the page to try again.'); });
    return () => { mounted.current = false; };
  }, []);
  async function signIn() {
    if (!ready || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    const auth = getAuth(firebaseApp);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({prompt: 'select_account'});
    try {
      // Start directly from the click so browsers can open the account picker.
      const result = await signInWithPopup(auth, provider);
      await changeSession('google-sign-in', {idToken: await result.user.getIdToken()});
    } catch (failure) {
      const detail = failure as {code?: string; message?: string};
      if (mounted.current) setError(detail.code ? messages[detail.code] || 'Could not sign in with Google. Please try again.' : detail.message || 'Could not sign in. Please try again.');
    } finally {
      // Application sessions live in HttpOnly cookies, not Firebase browser storage.
      await signOut(auth).catch(() => {});
      inFlight.current = false;
      if (mounted.current) { setBusy(false); onBusyChange?.(false); }
    }
  }
  return <div className="google-login">
    <button type="button" className="google-login-button" onClick={signIn} disabled={!ready || busy}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/>
        <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.13H3.06v2.59A10 10 0 0 0 12 22Z"/>
        <path fill="#FBBC05" d="M6.4 13.91A6 6 0 0 1 6.09 12c0-.66.11-1.3.31-1.91V7.5H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.5l3.34-2.59Z"/>
        <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.5l3.34 2.59C7.19 7.72 9.4 5.96 12 5.96Z"/>
      </svg>
      <span>{busy ? 'Signing in…' : 'Continue with Google'}</span>
    </button>
    {error && <p className="auth-message" role="alert">{error}</p>}
    <p className="google-login-note">Use your Google account. No SMS code needed.</p>
    <div className="google-login-divider"><span>or use another sign-in method</span></div>
  </div>;
}
