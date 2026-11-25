import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { ProductImage } from './Editorial';
import { money } from './data';
import { useAuth } from './components/auth-provider';
import { orderRequest } from './lib/orders';
import { orderReference } from './lib/order-status';
import { openRazorpay } from './lib/razorpay';

const states = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
];
const rupees = paise => money(paise == null ? null : paise / 100);
const emptyAddress = { name: '', email: '', mobile: '', line1: '', line2: '', city: '', state: '', pincode: '' };

export default function CheckoutPage({ cart, update, remove, completeOrder }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const attempt = useRef(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [savedOrderId, setSavedOrderId] = useState(null);
  const [quoteRecord, setQuoteRecord] = useState(null);
  const [address, setAddress] = useState(emptyAddress);
  const [promoCode, setPromoCode] = useState('');
  const items = cart.map(({ slug, qty }) => ({ slug, qty })).sort((a, b) => a.slug.localeCompare(b.slug));
  const inputKey = JSON.stringify({ items, address, promoCode: promoCode.trim().toUpperCase() });
  const quote = quoteRecord?.inputKey === inputKey ? quoteRecord.quote : null;
  const onlineOnly = cart.every(item => item.price != null && (item.purchaseMode ?? 'online') === 'online');
  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  const estimate = cart.reduce((sum, item) => sum + (item.price ?? 0) * item.qty, 0);

  function editAddress(key, value) {
    setAddress(current => ({ ...current, [key]: value }));
    setError('');
  }
  async function getQuote(event) {
    event.preventDefault();
    if (inFlight.current || !onlineOnly) return;
    inFlight.current = true;
    setBusy('quote');
    setError('');
    try {
      const { quote: priced } = await orderRequest({}, { action: 'quote', items, address, promoCode: promoCode.trim() });
      setQuoteRecord({ inputKey, quote: priced });
      attempt.current = null;
    } catch (failure) {
      setQuoteRecord(null);
      setError(failure instanceof Error ? failure.message : 'Delivery quote is unavailable. Try again.');
    } finally {
      inFlight.current = false;
      setBusy('');
    }
  }
  async function pay() {
    if (inFlight.current || !quote) return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setQuoteRecord(null);
      setError('Your delivery quote expired. Get a fresh quote before paying.');
      return;
    }
    inFlight.current = true;
    setBusy('payment');
    setError('');
    const id = attempt.current?.quoteId === quote.id ? attempt.current.id : crypto.randomUUID();
    attempt.current = { quoteId: quote.id, id };
    try {
      const checkout = await orderRequest({}, { action: 'start-payment', quoteId: quote.id, id });
      setSavedOrderId(checkout.order.id);
      let order = checkout.order;
      if (!checkout.payment.paid) {
        const result = await openRazorpay(checkout.payment, address);
        ({ order } = await orderRequest({}, { action: 'verify-payment', id, ...result }));
      }
      completeOrder(items);
      navigate(`/orders/${order.id}`, { replace: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Payment could not be completed. Open the saved order to retry.');
    } finally {
      inFlight.current = false;
      setBusy('');
    }
  }

  if (!cart.length) return <section className="checkout-shell wrap checkout-empty"><h1>Checkout</h1><ShoppingBag size={40} aria-hidden="true" /><h2>Your cart is empty</h2><Link className="button button-dark" to="/products">Shop products</Link></section>;

  return <section className="checkout-shell wrap">
    <Link className="checkout-return" to="/cart"><ArrowLeft size={16} aria-hidden="true" /> Back to cart</Link>
    <div className="checkout-title"><h1>Checkout</h1><span>{count} {count === 1 ? 'item' : 'items'} in your order</span></div>
    <p className="checkout-notice">Enter your delivery address to see the final product, tax and shipping total before payment. Guest checkout is available.</p>
    <div className="checkout-layout"><div>
      <section className="checkout-step" aria-labelledby="checkout-items-title">
        <div className="checkout-step-title"><h2 id="checkout-items-title">Your items</h2><Link to="/products">Add more</Link></div>
        <div className="checkout-items">{cart.map(item => <article className="checkout-item" key={item.slug}>
          <Link to={`/products/${item.slug}`} className="checkout-item-image"><ProductImage product={item} /></Link>
          <div className="checkout-item-copy"><Link to={`/products/${item.slug}`}><h3>{item.name}</h3></Link>
            <p>{item.price == null ? 'Request pricing' : `${money(item.price)} each`}</p>
            <div className="checkout-quantity">
              <button type="button" disabled={Boolean(busy)} aria-label={`Decrease ${item.name}`} onClick={() => update(item.slug, -1)}><Minus size={15} aria-hidden="true" /></button>
              <span aria-live="polite">{item.qty}</span>
              <button type="button" disabled={Boolean(busy) || item.qty >= 99} aria-label={`Increase ${item.name}`} onClick={() => update(item.slug, 1)}><Plus size={15} aria-hidden="true" /></button>
              <button type="button" disabled={Boolean(busy)} className="checkout-remove" aria-label={`Remove ${item.name}`} onClick={() => remove(item.slug)}><Trash2 size={16} aria-hidden="true" /></button>
            </div></div><strong>{money(item.price == null ? null : item.price * item.qty)}</strong>
        </article>)}</div>
      </section>
      <section className="checkout-step checkout-address" aria-labelledby="checkout-address-title">
        <div className="checkout-step-title"><h2 id="checkout-address-title">Delivery details</h2></div>
        <form id="checkout-address-form" onSubmit={getQuote}><div className="checkout-address-grid">
          <label>Full name<input required autoComplete="name" maxLength={100} value={address.name} onChange={event => editAddress('name', event.target.value)} /></label>
          <label>Email<input required type="email" autoComplete="email" maxLength={254} value={address.email} onChange={event => editAddress('email', event.target.value)} /></label>
          <label>Mobile number<input required type="tel" autoComplete="tel" inputMode="tel" maxLength={18} value={address.mobile} onChange={event => editAddress('mobile', event.target.value)} /></label>
          <label>PIN code<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="postal-code" value={address.pincode} onChange={event => editAddress('pincode', event.target.value)} /></label>
          <label className="checkout-address-wide">Address line 1<input required autoComplete="address-line1" maxLength={200} value={address.line1} onChange={event => editAddress('line1', event.target.value)} /></label>
          <label className="checkout-address-wide">Address line 2 (optional)<input autoComplete="address-line2" maxLength={200} value={address.line2} onChange={event => editAddress('line2', event.target.value)} /></label>
          <label>City<input required autoComplete="address-level2" maxLength={100} value={address.city} onChange={event => editAddress('city', event.target.value)} /></label>
          <label>State or union territory<select required autoComplete="address-level1" value={address.state} onChange={event => editAddress('state', event.target.value)}><option value="">Select</option>{states.map(state => <option key={state}>{state}</option>)}</select></label>
          <label className="checkout-address-wide">Promotion code (optional)<input maxLength={32} value={promoCode} onChange={event => setPromoCode(event.target.value.toUpperCase())} /></label>
        </div></form>
      </section>
    </div><aside className="checkout-summary" aria-labelledby="checkout-summary-title">
      <h2 id="checkout-summary-title">Order summary</h2><dl>
        <div><dt>Products</dt><dd>{quote ? rupees(quote.subtotalPaise) : money(estimate)}</dd></div>
        {quote && <>{quote.discountPaise > 0 && <div><dt>Promotion</dt><dd>−{rupees(quote.discountPaise)}</dd></div>}
          <div><dt>Product GST</dt><dd>{rupees(quote.taxPaise)}</dd></div>
          <div><dt>Shipping · {quote.carrier}</dt><dd>{rupees(quote.shippingPaise)}</dd></div>
          <div><dt>Shipping GST</dt><dd>{rupees(quote.shippingTaxPaise)}</dd></div></>}
        <div className="checkout-total"><dt>{quote ? 'Total payable' : 'Estimated products'}</dt><dd>{quote ? rupees(quote.totalPaise) : money(estimate)}</dd></div>
      </dl>
      {!onlineOnly && <p>Some items require an enquiry or are unavailable for online purchase. Remove them to continue, or <Link to="/contact">contact our team</Link>.</p>}
      {quote && <p role="status">Delivery by {quote.carrier}{quote.estimatedDays ? ` · estimated ${quote.estimatedDays} days` : ''}. Your price is reserved when you start payment.</p>}
      {!quote && onlineOnly && <button type="submit" form="checkout-address-form" className="button button-dark" disabled={Boolean(busy)}>{busy === 'quote' ? 'Checking delivery…' : 'Get final delivery quote'}</button>}
      {quote && <button type="button" className="button button-dark" disabled={Boolean(busy)} onClick={pay}>{busy === 'payment' ? 'Processing…' : `Pay ${rupees(quote.totalPaise)} securely`}</button>}
      {user && <p>Signed in as {user.name}. Your order will appear in My orders.</p>}
      {savedOrderId && <p style={{ overflowWrap: 'anywhere' }}>Order saved: <Link to={`/orders/${savedOrderId}`}>{orderReference(savedOrderId)}</Link>. You can retry payment from this order.</p>}
      {error && <p role="alert">{error}</p>}
      <p>Payment is handled by Razorpay. Tracking is available from your order page after payment and shipping confirmation.</p>
      <Link to="/shipping" className="checkout-terms-link">Shipping &amp; returns policy</Link>
    </aside></div>
  </section>;
}
