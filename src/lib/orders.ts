import { money } from '../data';
import { whatsappDraft } from './enquiry';
import { orderCheckpoints, orderReference } from './order-status';

export type OrderStatus = keyof typeof orderCheckpoints;
export type OrderItem = {
  slug: string;
  name: string;
  price: number | null;
  qty: number;
  img: string;
  photo: string;
  variant: string | null;
};

export type OrderSummary = {
  payment_sync_pending?: boolean;
  payment_status?: 'paid' | 'pending' | 'unpaid' | 'failed';
  paymentStatus?: 'paid' | 'pending' | 'expired';
  fulfillmentStatus?: string;
  quoteId?: string;
  totalPaise?: number;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  id: string;
  created_at: string;
  subtotal: number | null;
  status: OrderStatus;
  items: OrderItem[];
  customer?: { name: string; email: string; mobile: string | null };
};

export type OrderCheckpoint = {
  seq: number;
  status: OrderStatus;
  created_at: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  email_status?: 'pending' | 'sent' | 'failed';
};

export type Order = OrderSummary & {
  payment_events?: {event_id: string; payment_id: string | null; kind: string; source: string; occurred_at: string}[];
  events: OrderCheckpoint[];
  refunds?: { id: string; amountPaise: number; status: string; reason: string; requestedAt: string; refundId: string | null }[];
};

export async function orderRequest<T>(params: Record<string, string>, body?: object, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params);
  const api = window.location.pathname.startsWith('/pipeline/') ? '/pipeline/api/orders' : '/api/orders';
  const response = await fetch(`${api}?${query}`, {
    method: body ? 'POST' : 'GET',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    cache: 'no-store',
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    throw new Error(result?.error || 'The order service is unavailable. Try again shortly.');
  }
  return result as T;
}

export function whatsappOrderDraft(order: OrderSummary) {
  const lines = order.items.map(item => [
    [item.name, item.variant].filter(Boolean).join(' · '),
    `Quantity: ${item.qty} · ${item.price == null ? 'Request pricing' : `${money(item.price)} each · ${money(item.price * item.qty)}`}`,
    `Photo: ${new URL(item.photo, 'https://sparkdv.com').href}`,
  ].join('\n'));

  return whatsappDraft([
    'Hello SPARK-DV, I’d like to order:',
    `Order reference: ${orderReference(order.id)}`,
    ...lines,
    `Product subtotal: ${money(order.subtotal)}`,
    'Please confirm availability, shipping, and payment details.',
  ].join('\n\n'));
}
