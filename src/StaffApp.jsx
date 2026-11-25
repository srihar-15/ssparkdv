import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import AdminPanel from './AdminPanel';
import StaffProfile from './StaffProfile';
import StaffLogin from './components/ui/staff-login';
import OrdersPage from './components/orders-page';
import { useAuth } from './components/auth-provider';

export default function StaffApp() {
  const { pathname } = useLocation();
  const { status, user, refresh, changeSession } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = 'Staff workspace | SPARK-DV'; }, [pathname]);
  async function signOut() {
    setBusy(true);
    setError('');
    try { await changeSession('sign-out'); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  if (status === 'loading') return <main className="admin-loading" role="status">Checking your staff account…</main>;
  if (status === 'unavailable') return <main className="admin-denied"><h1>Sign-in service unavailable</h1><p role="alert">Please try again shortly.</p><button onClick={refresh}>Try again</button></main>;
  if (!user) {
    if (pathname === '/login') return <StaffLogin />;
    return <Navigate to="/login" replace state={{ from: /^\/manage\/orders(?:\/[a-f0-9-]{36})?$/.test(pathname) ? pathname : '/dashboard' }} />;
  }
  const order = /^\/manage\/orders(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
  return <>
    <header style={{ display: 'flex', gap: 20, alignItems: 'center', padding: '14px 24px', background: '#0f1c2e', color: '#dce6f2', flexWrap: 'wrap', fontSize: 12, borderBottom: '1px solid #29374b' }}>
      <Link to="/dashboard">SPARK-DV · Staff workspace</Link>
      <Link to="/profile">My staff profile</Link>
      <a href={location.hostname === 'app.localhost' ? 'http://localhost:5173' : 'https://sparkdv.com'} style={{ marginLeft: 'auto' }}>View storefront</a>
      <button style={{ background: '#203347', color: '#e2e8f0', border: '1px solid #415268', borderRadius: 6, padding: '7px 12px', cursor: 'pointer' }} disabled={busy} onClick={signOut}>{busy ? 'Signing out…' : 'Sign out'}</button>
    </header>
    {error && <p role="alert">{error}</p>}
    {!user.roles?.length ? <main className="admin-denied"><h1>Staff access required</h1><p>Your account has not been granted staff access.</p></main>
      : pathname === '/login' || pathname === '/' ? <Navigate to="/dashboard" replace />
      : pathname === '/profile' ? <StaffProfile key={user.id} />
      : pathname === '/dashboard' || pathname === '/admin' ? <AdminPanel />
      : order && (user.permissions?.includes('*') || user.permissions?.includes('orders.read')) ? <OrdersPage key={pathname} id={order[1]} staff userId={user.id} />
      : <main className="admin-denied"><h1>Page not found</h1><Link to="/dashboard">Back to dashboard</Link></main>}
  </>;
}
