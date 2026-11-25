import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth-provider';
import './staff-login.css';

export default function StaffLogin() {
  const { changeSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setPending(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await changeSession('sign-in', {
        identifier: String(form.get('identifier') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      const returnTo = location.state?.from;
      navigate(typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : '/dashboard', { replace: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed. Check your details and try again.');
      setPending(false);
    }
  }

  return (
    <main className="staff-login">
      <section className="staff-login-card" aria-labelledby="staff-login-title">
        <div className="staff-login-mark"><ShieldCheck size={22} aria-hidden="true" /></div>
        <p className="staff-login-eyebrow">SPARK-DV · PIPELINE</p>
        <h1 id="staff-login-title">Staff sign in</h1>
        <p className="staff-login-copy">Sign in to manage orders and the SPARK-DV workspace.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="staff-identifier">Work email</label>
          <input id="staff-identifier" name="identifier" type="email" autoComplete="username" autoCapitalize="none" required />
          <label htmlFor="staff-password">Password</label>
          <div className="staff-password-field">
            <input id="staff-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required />
            <button className="staff-password-toggle" type="button" aria-controls="staff-password"
              aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(value => !value)}>
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          {error && <p className="staff-login-error" role="alert">{error}</p>}
          <button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Continue'} <ArrowRight size={17} /></button>
        </form>
        <p className="staff-login-foot"><LockKeyhole size={13} aria-hidden="true" /> Authorized staff accounts only</p>
      </section>
    </main>
  );
}
