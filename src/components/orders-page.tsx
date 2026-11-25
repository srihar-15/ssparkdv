import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Package, RefreshCw, Truck } from 'lucide-react';
import { money } from '../data';
import { nextOrderCheckpoint, orderCheckpoints, orderReference } from '../lib/order-status';
import { orderRequest, type Order, type OrderStatus, type OrderSummary } from '../lib/orders';
import { openRazorpay } from '../lib/razorpay';
import { useAuth } from './auth-provider';
import './orders-page.css';

const paymentLabels: Record<string, string> = {'payment.captured':'Payment captured', 'payment.authorized':'Payment authorized — awaiting capture', 'payment.failed':'Payment failed', 'checkout.started':'Checkout started', 'checkout.closed':'Customer closed checkout', 'checkout.error':'Checkout interrupted — check payment status'};

const dateFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function OrderBadge({ status }: { status: OrderStatus }) {
  return <span className="order-status" data-status={status}>{orderCheckpoints[status].label}</span>;
}

function OrderDate({ value }: { value: string }) {
  return <time dateTime={value}>{dateFormat.format(new Date(value))}</time>;
}

function StaffCheckpointForm({ order, onOrder }: { order: Order; onOrder: (order: Order) => void }) {
  const next = nextOrderCheckpoint(order.status) as OrderStatus | null;
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function save(body: object) {
    setPending(true);
    setError('');
    try {
      const result = await orderRequest<{ order: Order }>({ staff: '1' }, body);
      onOrder(result.order);
      setStatus('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The checkpoint couldn’t be saved.');
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const shipping = Object.fromEntries(new FormData(event.currentTarget));
    void save({ action: 'checkpoint', id: order.id, expected: order.status, status, ...shipping });
  }

  return (
    <section className="order-panel" aria-labelledby="manage-checkpoint">
      <h2 id="manage-checkpoint">Update order</h2>
      {next ? (
        <form className="order-staff-form" onSubmit={submit}>
          <label>Checkpoint
            <select value={status} onChange={event => setStatus(event.target.value)} required disabled={pending}>
              <option value="">Choose a checkpoint</option>
              <option value={next}>{orderCheckpoints[next].label}</option>
              <option value="cancelled">Order cancelled</option>
            </select>
          </label>
          {status === 'dispatched' && (
            <>
              <label>Courier <input name="carrier" maxLength={100} /></label>
              <label>Tracking number <input name="trackingNumber" maxLength={100} /></label>
              <label>Courier tracking link <input name="trackingUrl" type="url" placeholder="https://" maxLength={500} /></label>
            </>
          )}
          <button className="button button-dark" disabled={pending || !status}>{pending ? 'Saving…' : 'Save checkpoint'}</button>
        </form>
      ) : <p>This order is complete.</p>}
      {error && <p className="order-error" role="alert">{error}</p>}
      {order.events.some(event => event.email_status === 'failed') && (
        <div className="order-email-retries">
          <h3>Emails that need attention</h3>
          {order.events.filter(event => event.email_status === 'failed').map(event => (
            <button
              type="button"
              className="button button-outline"
              key={event.seq}
              disabled={pending || Date.now() - Date.parse(event.created_at) >= 23 * 60 * 60 * 1000}
              onClick={() => void save({ action: 'retry-email', id: order.id, status: event.status })}
            >
              Retry email · {orderCheckpoints[event.status].label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function RefundForm({ order, onOrder }: { order: Order; onOrder: (order: Order) => void }) {
  const [amount, setAmount] = useState(order.totalPaise ? (order.totalPaise / 100).toFixed(2) : '');
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) { setError('Enter an amount with at most two decimal places.'); return; }
    const amountPaise = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 1 || amountPaise > (order.totalPaise ?? 0)) {
      setError('Refund amount must be within the amount paid.'); return;
    }
    setPending(true); setError(''); setMessage('');
    try {
      const result = await orderRequest<{ refund: { id: string; status: string } }>({ staff: '1' },
        { action: 'refund', id: order.id, requestId, amountPaise, reason });
      setMessage(`Refund ${result.refund.id} is ${result.refund.status}.`);
      setRequestId(crypto.randomUUID());
      setReason('');
      try {
        const refreshed = await orderRequest<{ order: Order }>({ staff: '1', id: order.id });
        onOrder(refreshed.order);
      } catch { setError('Refund was requested, but its history could not refresh. Reload this order to check it.'); }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Refund could not be requested.');
    } finally { setPending(false); }
  }
  return <section className="order-panel" aria-labelledby="refund-title">
    <h2 id="refund-title">Refund payment</h2>
    {order.refunds?.length ? <ul>{order.refunds.map(refund => <li key={refund.id}>{money(refund.amountPaise / 100)} · {refund.status} · {refund.reason}</li>)}</ul> : <p>No refunds requested.</p>}
    {order.payment_status === 'paid' && <form className="order-staff-form" onSubmit={submit}>
      <label>Amount in rupees<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={pending} /></label>
      <label>Reason<input required maxLength={200} value={reason} onChange={event => setReason(event.target.value)} disabled={pending} /></label>
      <button className="button button-dark" disabled={pending}>{pending ? 'Submitting…' : 'Request refund'}</button>
    </form>}
    {message && <p role="status">{message}</p>}
    {error && <p className="order-error" role="alert">{error}</p>}
  </section>;
}

function OrderTracking({ order, staff, onOrder }: { order: Order; staff: boolean; onOrder: (order: Order) => void }) {
  const { user } = useAuth();
  const canManage = staff && Boolean(user?.permissions?.includes('*') || user?.permissions?.includes('orders.manage'));
  const canRefund = staff && Boolean(user?.permissions?.includes('*') || user?.permissions?.includes('refunds.manage'));
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  async function retryPayment() {
    if (paying || !order.quoteId) return;
    setPaying(true); setPaymentError('');
    try {
      const result = await orderRequest<{order: Order; payment: any}>({}, {action: 'start-payment', id: order.id, quoteId: order.quoteId});
      if (result.payment.paid) {onOrder(result.order); return;}
      const confirmation = await openRazorpay(result.payment, order.customer || {});
      const verified = await orderRequest<{order: Order}>({}, {action: 'verify-payment', id: order.id, ...confirmation as object});
      onOrder(verified.order);
    } catch (failure) {
      setPaymentError(failure instanceof Error ? failure.message : 'Payment could not be completed.');
    } finally {setPaying(false);}
  }
  const checkpoints = (Object.keys(orderCheckpoints) as OrderStatus[]).filter(status =>
    order.status === 'cancelled' ? order.events.some(event => event.status === status) : status !== 'cancelled'
  );
  const dispatch = order.events.find(event => event.status === 'dispatched');
  const carrier = dispatch?.carrier || order.carrier;
  const trackingNumber = dispatch?.tracking_number || order.trackingNumber;
  const trackingUrl = dispatch?.tracking_url || order.trackingUrl;
  return (
    <div className="order-detail-layout">
      <div className="order-detail-main">
        <section className="order-panel" aria-labelledby="order-progress">
          <h2 id="order-progress">Order progress</h2>
          <ol className="order-timeline">
            {checkpoints.map(status => {
              const event = order.events.find(item => item.status === status);
              const checkpoint = orderCheckpoints[status];
              return (
                <li key={status} data-completed={Boolean(event)} data-current={order.status === status} aria-current={order.status === status ? 'step' : undefined}>
                  <span className="order-timeline-icon" aria-hidden="true">{event && <Check size={14} />}</span>
                  <div>
                    <h3>{checkpoint.label}</h3>
                    {event && (
                      <>
                        <OrderDate value={event.created_at} />
                        <p>{checkpoint.message}</p>
                        {staff && <small>{event.email_status === 'sent' ? 'Email submitted' : event.email_status === 'failed' ? 'Email failed' : 'Email not submitted'}</small>}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
        {canManage && <StaffCheckpointForm key={order.status} order={order} onOrder={onOrder} />}
        {canRefund && <RefundForm order={order} onOrder={onOrder} />}
      </div>
      <div className="order-detail-side">
        {(carrier || trackingNumber || trackingUrl) && (
          <section className="order-panel" aria-labelledby="courier-details">
            <h2 id="courier-details"><Truck size={20} aria-hidden="true" /> Courier details</h2>
            {carrier && <p>{carrier}</p>}
            {trackingNumber && <p>Tracking number <strong>{trackingNumber}</strong></p>}
            {trackingUrl && <a className="profile-inline-link" href={trackingUrl} target="_blank" rel="noopener noreferrer">Track with courier <ArrowUpRight size={15} aria-hidden="true" /></a>}
          </section>
        )}
        <section className="order-panel" aria-labelledby="ordered-items">
          <h2 id="ordered-items">Items in this order</h2>
          <ul className="order-items-list">
            {order.items.map(item => (
              <li key={item.slug}>
                <img src={item.img} alt="" width={56} height={56} loading="lazy" />
                <div><Link to={`/products/${item.slug}`}>{item.name}</Link><small>Quantity {item.qty}</small></div>
                <strong>{money(item.price == null ? null : item.price * item.qty)}</strong>
              </li>
            ))}
          </ul>
          <dl className="order-subtotal"><dt>Product subtotal</dt><dd>{money(order.subtotal)}</dd></dl>
          {order.totalPaise != null && <dl className="order-subtotal"><dt>Total including GST and shipping</dt><dd>{money(order.totalPaise / 100)}</dd></dl>}
          <p role="status">Payment: {order.payment_status === 'paid' ? 'Paid via Razorpay' : order.paymentStatus === 'expired' ? 'Payment window expired. Please create a new checkout from your cart.' : order.payment_status === 'failed' ? 'Payment failed — your order is saved.' : order.payment_status === 'pending' ? 'Pending — refresh this order after payment to check confirmation.' : 'Awaiting payment'}</p>
          {order.fulfillmentStatus === 'stock_exception' && <p className="order-error" role="alert">Payment was captured, but stock or promotion availability changed. Our team must review this order and arrange fulfilment or a refund.</p>}
          {order.fulfillmentStatus === 'payment_exception' && <p className="order-error" role="alert">Payment was captured after this order was cancelled. Our team must review and refund the payment.</p>}
          {order.payment_sync_pending && <p role="status">Razorpay could not be reached. Showing the last saved payment status; refresh shortly.</p>}
          {!staff && order.status !== 'cancelled' && order.paymentStatus === 'pending' && order.quoteId && <button className="button button-dark" disabled={paying} onClick={() => void retryPayment()}>{paying ? 'Processing…' : 'Pay this order'}</button>}
          {paymentError && <p role="alert">{paymentError}</p>}
        </section>
        <section className="order-panel" aria-labelledby="payment-history">
          <h2 id="payment-history">Payment history</h2>
          <p>Order ID: <strong style={{overflowWrap: 'anywhere'}}>{order.id}</strong></p>
          {order.payment_events?.length ? <ul>{order.payment_events.map(event => <li key={event.event_id} style={{marginBottom: 16, overflowWrap: 'anywhere'}}>
            <strong>{paymentLabels[event.kind] || event.kind}</strong><br />
            <OrderDate value={event.occurred_at} /><br />
            <small>{event.source === 'customer' ? 'Reported by checkout' : 'Verified with Razorpay'}{event.payment_id ? ' · ' + event.payment_id : ''}</small>
          </li>)}</ul> : <p>No payment attempts recorded yet.</p>}
          <p>Refresh to check the latest provider status. Closing checkout does not prove that a payment failed.</p>
        </section>
        {staff && order.customer && (
          <section className="order-panel" aria-labelledby="order-customer">
            <h2 id="order-customer">Customer</h2>
            <strong>{order.customer.name}</strong>
            <p>{order.customer.email}</p>
            {order.customer.mobile && <p>{order.customer.mobile}</p>}
          </section>
        )}
      </div>
    </div>
  );
}

export default function OrdersPage({ id, staff = false }: { id?: string; staff?: boolean; userId?: string }) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [order, setOrder] = useState<Order | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const base = staff ? '/manage/orders' : '/orders';

  useEffect(() => {
    const controller = new AbortController();
    function reload() {
      const params = { ...(staff && { staff: '1' }), ...(id ? { id } : { page: String(page) }) };
      setError('');
      orderRequest<{ order?: Order; orders?: OrderSummary[]; hasMore?: boolean }>(params, undefined, controller.signal)
        .then(result => {
          if (controller.signal.aborted) return;
          setOrder(result.order ?? null);
          setOrders(result.orders ?? []);
          setHasMore(Boolean(result.hasMore));
        })
        .catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    reload();
    function visible() {
      if (!staff && document.visibilityState === 'visible') reload();
    }
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [id, page, revision, staff]);

  function showPage(number: number) {
    setLoading(true);
    setPage(number);
  }

  return (
    <section className="orders-shell wrap" aria-labelledby="orders-title">
      <Link className="orders-back" to={id ? base : '/profile'}><ArrowLeft size={16} aria-hidden="true" /> {id ? (staff ? 'Manage orders' : 'My orders') : 'Profile'}</Link>
      <header className="orders-heading">
        <div>
          <h1 id="orders-title">{id ? (staff ? 'Order details' : 'Track order') : (staff ? 'Manage orders' : 'My orders')}</h1>
          {order && <p><strong>{orderReference(order.id)}</strong> · <OrderDate value={order.created_at} /></p>}
          {!id && <p>{staff ? 'Review orders and record delivery checkpoints.' : 'Track your orders and read delivery updates.'}</p>}
        </div>
        <button className="button button-outline order-refresh" type="button" onClick={() => setRevision(value => value + 1)} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </button>
      </header>
      {loading && <p role="status">Loading orders…</p>}
      {error && <p className="order-error" role="alert">{error}</p>}
      {order && <OrderTracking order={order} staff={staff} onOrder={setOrder} />}
      {!id && !loading && !error && (
        orders.length ? (
          <>
            <ul className="orders-list">
              {orders.map(item => (
                <li key={item.id}>
                  <Link className="order-list-card" to={`${base}/${item.id}`}>
                    <img src={item.items[0].img} alt="" width={64} height={64} loading="lazy" />
                    <span className="order-list-description">
                      <strong>{orderReference(item.id)}</strong>
                      <span>{item.customer ? item.customer.name : item.items[0].name}{item.items.length > 1 && !item.customer ? ` + ${item.items.length - 1} more` : ''}</span>
                      <OrderDate value={item.created_at} />
                    </span>
                    <span className="order-list-status"><OrderBadge status={item.status} /><small>Payment: {item.payment_status || 'unpaid'}</small><strong>{money(item.subtotal)}</strong></span>
                    <span className="order-list-action">{staff ? 'View order' : 'Track order'} <ArrowRight size={16} aria-hidden="true" /></span>
                  </Link>
                </li>
              ))}
            </ul>
            {(page > 1 || hasMore) && <nav className="order-pagination" aria-label="Order pages">
              <button type="button" className="button button-outline" disabled={page === 1} onClick={() => showPage(page - 1)}>Previous</button>
              <span>Page {page}</span>
              <button type="button" className="button button-outline" disabled={!hasMore} onClick={() => showPage(page + 1)}>Next</button>
            </nav>}
          </>
        ) : (
          <div className="order-panel orders-empty">
            <Package size={32} aria-hidden="true" />
            <h2>No orders yet</h2>
            <p>{staff ? 'New orders will appear here.' : 'Orders you place through the website will appear here.'}</p>
            {!staff && <Link className="button button-dark" to="/products">Shop products <ArrowRight size={16} aria-hidden="true" /></Link>}
          </div>
        )
      )}
    </section>
  );
}
