import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type CatalogProduct = { slug: string; name: string; category?: string; eyebrow?: string; price: number | null; tags: string[]; features: string[]; availableStock: number | null; canBuy?: boolean; [key: string]: any };
type CatalogData = { products: CatalogProduct[]; categories: string[]; content: Record<string, any> | null };
type CatalogContextValue = CatalogData & { status: 'loading' | 'ready' | 'error'; error: string; refresh: () => void };
const CatalogContext = createContext<CatalogContextValue | null>(null);

function normalizeProducts(items: unknown): CatalogProduct[] {
  if (!Array.isArray(items)) throw new Error('The catalog response is invalid.');
  return items.filter((item): item is CatalogProduct => item && typeof item.slug === 'string' && typeof item.name === 'string')
    .map((item): CatalogProduct => ({
      ...item,
      tags: Array.isArray(item.tags) ? item.tags : [],
      features: Array.isArray(item.features) ? item.features : [],
      price: item.price == null ? null : Number(item.price),
      availableStock: item.availableStock == null ? null : Number(item.availableStock),
    }));
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<CatalogData>({ products: [], categories: ['All products'], content: null });
  const [status, setStatus] = useState<CatalogContextValue['status']>('loading');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setError('');
    fetch('/api/catalog', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || 'Could not load the product catalog.');
        if (!body) throw new Error('The catalog response is empty.');
        const products = normalizeProducts(body.products);
        const fromProducts = [...new Set(products.map(product => product.category).filter((category): category is string => typeof category === 'string' && category.length > 0))];
        const serverCategories: string[] = Array.isArray(body.categories) ? body.categories.filter((category: unknown): category is string => typeof category === 'string') : [];
        const categories = ['All products', ...new Set([...serverCategories, ...fromProducts].filter(category => category !== 'All products'))];
        return { products, categories, content: body.content && typeof body.content === 'object' ? body.content : null };
      })
      .then(result => {
        if (controller.signal.aborted) return;
        setCatalog(result);
        setStatus('ready');
      })
      .catch(failure => {
        if (controller.signal.aborted) return;
        setCatalog({ products: [], categories: ['All products'], content: null });
        setStatus('error');
        setError(failure instanceof Error ? failure.message : 'Could not load the product catalog.');
      });
    return () => controller.abort();
  }, [revision]);

  const value = useMemo(() => ({ ...catalog, status, error, refresh }), [catalog, status, error, refresh]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog() {
  const catalog = useContext(CatalogContext);
  if (!catalog) throw new Error('CatalogProvider is required');
  return catalog;
}
