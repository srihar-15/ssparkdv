import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { ArrowUpRight } from 'lucide-react';
import { useCatalog } from './catalog-provider';
import { ProductImage } from '../Editorial';
import './managed-page.css';

function safeHref(value) {
  return typeof value === 'string' && (/^\/(?!\/)/.test(value) || /^https:\/\//.test(value) || /^mailto:/.test(value)) ? value : '/contact';
}

function ManagedSection({ section, products }) {
  if (!section || typeof section !== 'object') return null;
  const title = section.title || section.heading;
  if (section.type === 'markdown' || section.type === 'text') return <section className="managed-section wrap" id={section.id}><div className="managed-prose">{title && <h2>{title}</h2>}<ReactMarkdown>{String(section.body || section.text || '')}</ReactMarkdown></div></section>;
  if (section.type === 'image') return <figure className="managed-image wrap" id={section.id}><img src={section.src || section.image} alt={section.alt || ''} loading="lazy" />{section.caption && <figcaption>{section.caption}</figcaption>}</figure>;
  if (section.type === 'cta') return <section className="managed-cta wrap" id={section.id}><div>{title && <h2>{title}</h2>}{section.body && <p>{section.body}</p>}</div><a className="button button-dark" href={safeHref(section.href)}>{section.label || 'Contact us'} <ArrowUpRight size={16}/></a></section>;
  if (section.type === 'faq') return <section className="managed-section wrap" id={section.id}>{title && <h2>{title}</h2>}<div className="managed-faq">{(Array.isArray(section.items) ? section.items : []).map((item, index) => <details key={item.question || index}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div></section>;
  if (section.type === 'products') {
    const selected = Array.isArray(section.slugs) ? section.slugs.flatMap(slug => products.filter(product => product.slug === slug)) : products.slice(0, 4);
    return <section className="managed-section wrap" id={section.id}>{title && <h2>{title}</h2>}<div className="managed-products">{selected.map(product => <Link key={product.slug} to={`/products/${product.slug}`}><ProductImage product={product}/><strong>{product.name}</strong><span>{product.canBuy ? `₹${product.price?.toLocaleString('en-IN')}` : product.purchaseMode === 'online' && product.availableStock === 0 ? 'Sold out' : 'View product'}</span></Link>)}</div></section>;
  }
  return null;
}

export default function ManagedPage({ pageKey, fallback }) {
  const { products } = useCatalog();
  const [state, setState] = useState({ status: 'loading', page: null, error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', page: null, error: '' });
    fetch(`/api/catalog?resource=content&page=${encodeURIComponent(pageKey)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || 'Page content is unavailable.');
        return data?.page || null;
      })
      .then(page => { if (!controller.signal.aborted) setState({ status: 'ready', page, error: '' }); })
      .catch(failure => { if (!controller.signal.aborted) setState({ status: 'error', page: null, error: failure.message || 'Page content is unavailable.' }); });
    return () => controller.abort();
  }, [pageKey, revision]);
  useEffect(() => {
    if (!state.page) return;
    const title = state.page.seo?.title || state.page.title || state.page.hero?.title;
    if (title) document.title = `${title} | SPARK-DV`;
    if (state.page.seo?.description) {
      let meta = document.querySelector('meta[name="description"]');
      if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name', 'description'); document.head.append(meta); }
      meta.content = state.page.seo.description;
    }
  }, [state.page]);
  if (state.status === 'loading') return <main className="wrap section" role="status">Loading page…</main>;
  if (state.status === 'error') return <><p className="managed-content-error wrap" role="alert">{state.error} <button type="button" onClick={() => setRevision(value => value + 1)}>Retry</button></p>{fallback}</>;
  if (!state.page) return fallback;
  const page = state.page;
  return <div className="managed-page"><header className="managed-hero"><div className="wrap managed-hero-inner"><p className="eyebrow">SPARK-DV</p><h1>{page.hero?.title || page.title || 'SPARK-DV'}</h1>{(page.hero?.description || page.lede) && <p>{page.hero?.description || page.lede}</p>}{page.hero?.href && <a className="button button-dark" href={safeHref(page.hero.href)}>{page.hero.label || 'Explore'} <ArrowUpRight size={16}/></a>}</div>{page.hero?.image && <img src={page.hero.image} alt={page.hero.alt || ''} />}</header>{(Array.isArray(page.sections) ? page.sections : []).map((section, index) => <ManagedSection key={section.id || index} section={section} products={products} />)}</div>;
}
