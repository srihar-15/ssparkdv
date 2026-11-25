import { BrandWordmark } from '@/components/ui/brand-wordmark';
import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import ScrollProductHero, { ALL_HERO_SLIDES } from './components/ui/scroll-product-hero';
import { HomeHypeSections } from './components/home/HomeHypeSections';

export function CommerceHome({ add, products = [], content = {} }) {
  const home = content?.home || content || {};
  const slides = useMemo(() => {
    const bySlug = new Map(products.map(product => [product.slug, product]));
    const requested = Array.isArray(home.heroProductSlugs) ? home.heroProductSlugs : [];
    const slugs = requested.length
      ? requested
      : [...ALL_HERO_SLIDES.map(slide => slide.slug), ...products.map(product => product.slug)];
    const seen = new Set();
    return slugs.filter(slug => bySlug.has(slug) && !seen.has(slug) && seen.add(slug)).slice(0, 5).map(slug => {
      const product = bySlug.get(slug);
      const design = ALL_HERO_SLIDES.find(slide => slide.slug === slug);
      const [first, ...rest] = product.name.split(' ');
      const img = product.shareImage || product.img || '';
      return {
        ...design,
        id: slug,
        slug,
        name: product.name,
        category: product.category || '',
        textLeft: product.heroTextLeft || design?.textLeft || first.toUpperCase(),
        textRight: product.heroTextRight || design?.textRight || rest.join(' ').toUpperCase(),
        price: product.price ?? null,
        image: img.startsWith('/') || img.startsWith('http') ? img : `/images/${img}`,
        alt: product.imageAlt || product.name,
        bgGradient: product.heroGradient || design?.bgGradient || 'linear-gradient(135deg, #11405e, #08243c)',
        textColor: design?.textColor || 'rgba(255, 255, 255, 0.3)',
        imgClass: design?.imgClass || '',
      };
    });
  }, [products, home.heroProductSlugs]);
  return (
    <div className="commerce-home">
      {/* Scroll-driven centerpiece hero section */}
      <ScrollProductHero slides={slides} />

      {/* High-status company leadership, 21st.dev / Inspira UI bento grid, dual portals, and flagships */}
      <HomeHypeSections add={add} products={products} content={home} />

      {/* Editorial and scientific research band */}
      <section className="shop-science-band" id="home-content">
        <div className="wrap shop-science-inner">
          <h2>
            {home.scienceTitleFirst || 'Product details,'}
            <br />
            <em>{home.scienceTitleSecond || 'without the guesswork.'}</em>
          </h2>
          <p>
            {home.scienceIntro || <>Read clinical trial summaries, IFU use guidance, and peer-reviewed dental literature from <BrandWordmark />.</>}
          </p>
          <Link className="button button-light" to="/science">
            Explore the blogs <ArrowUpRight size={16} />
          </Link>
        </div>
      </section>

      {/* Audience navigation cards */}
      <section className="shop-audience wrap" aria-label="Explore SPARK-DV">
        <Link to="/dentists">
          <span>For dental professionals</span>
          <strong>Protocols &amp; product support <ArrowUpRight size={18} /></strong>
        </Link>
        <Link to="/parents">
          <span>For parents</span>
          <strong>Everyday care guidance <ArrowUpRight size={18} /></strong>
        </Link>
        <Link to="/contact?type=Distributor%20enquiry">
          <span>For partners</span>
          <strong>Distribution enquiries <ArrowUpRight size={18} /></strong>
        </Link>
      </section>
    </div>
  );
}
