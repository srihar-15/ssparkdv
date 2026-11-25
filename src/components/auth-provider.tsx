import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { authRequest, type AccountUser } from '../lib/auth';

type AuthState =
  | { status: 'loading' | 'signed-out' | 'unavailable'; user: null }
  | { status: 'signed-in'; user: AccountUser };

interface AuthContextValue {
  state: AuthState;
  changeSession: (action: string, fields?: Record<string, string>) => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const sessionChannel = window.location.hostname.startsWith('app.') ? 'sparkdv-staff-session' : 'sparkdv-customer-session';

function sessionState(user: AccountUser | null): AuthState {
  return user ? { status: 'signed-in', user } : { status: 'signed-out', user: null };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });
  const revision = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const user = await authRequest();
      if (request === revision.current) setState(sessionState(user));
    } catch {
      if (request === revision.current) setState({ status: 'unavailable', user: null });
    }
  }, []);

  const changeSession = useCallback(async (action: string, fields?: Record<string, string>) => {
    const user = await authRequest(action, fields);
    revision.current++;
    setState(sessionState(user));
    // Other tabs receive only a transient notification, never session credentials.
    channel.current?.postMessage('changed');
  }, []);

  useEffect(() => {
    void refresh();
    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel(sessionChannel);
      channel.current.onmessage = () => void refresh();
    }
    window.addEventListener('focus', refresh);
    return () => {
      revision.current++;
      channel.current?.close();
      channel.current = null;
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  return <AuthContext.Provider value={{ state, changeSession, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is required');
  return { ...context.state, changeSession: context.changeSession, refresh: context.refresh };
}
