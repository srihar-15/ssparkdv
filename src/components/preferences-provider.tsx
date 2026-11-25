import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './auth-provider';

type Preferences = { recentProducts: string[]; favorites: string[] };
type PreferencesContextValue = Preferences & {
  ready: boolean;
  error: string;
  rememberProduct: (slug: string) => void;
  toggleFavorite: (slug: string) => boolean;
};

const empty: Preferences = { recentProducts: [], favorites: [] };
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function cleanList(items: unknown, limit: number): string[] {
  return Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === 'string' && /^[a-z0-9-]+$/.test(item)))].slice(0, limit) : [];
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [preferences, setPreferences] = useState<Preferences>(empty);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    setPreferences(empty);
    setError('');
    if (!userId) { setReady(true); return () => { active = false; }; }
    setReady(false);
    fetch('/api/commerce/preferences', { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || 'Could not load your saved products.');
        return { recentProducts: cleanList(data?.recentProducts, 5), favorites: cleanList(data?.favorites, 100) };
      })
      .then(data => { if (active) { setPreferences(data); setReady(true); } })
      .catch(failure => { if (active) { setError(failure.message); setReady(true); } });
    return () => { active = false; };
  }, [userId]);

  const save = useCallback((next: Preferences) => {
    if (!userId) return;
    queue.current = queue.current.catch(() => {}).then(async () => {
      const response = await fetch('/api/commerce/preferences', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Could not save your preferences.');
      setError('');
    }).catch(failure => setError(failure.message));
  }, [userId]);

  const rememberProduct = useCallback((slug: string) => {
    if (!ready) return;
    if (preferences.recentProducts[0] === slug) return;
    const next = { ...preferences, recentProducts: [slug, ...preferences.recentProducts.filter(item => item !== slug)].slice(0, 5) };
    setPreferences(next);
    save(next);
  }, [preferences, ready, save]);

  const toggleFavorite = useCallback((slug: string) => {
    if (!ready) return false;
    const liked = !preferences.favorites.includes(slug);
    const next = { ...preferences, favorites: liked ? [...preferences.favorites, slug] : preferences.favorites.filter(item => item !== slug) };
    setPreferences(next);
    save(next);
    return liked;
  }, [preferences, ready, save]);

  return <PreferencesContext.Provider value={{ ...preferences, ready, error, rememberProduct, toggleFavorite }}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('PreferencesProvider is required');
  return value;
}
