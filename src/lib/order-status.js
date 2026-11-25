export const orderCheckpoints = {
  placed: { label: 'Order placed', message: 'Your order is saved. Payment status is tracked separately below; our team will confirm availability and delivery.' },
  confirmed: { label: 'Order confirmed', message: 'Our team confirmed your order and is preparing it for dispatch.' },
  dispatched: { label: 'Order dispatched', message: 'Your order has been handed over to the courier.' },
  out_for_delivery: { label: 'Out for delivery', message: 'The courier is bringing your order to you.' },
  delivered: { label: 'Order delivered', message: 'The courier marked your order as delivered.' },
  cancelled: { label: 'Order cancelled', message: 'Your order was cancelled. Contact our team if you have any questions.' },
};

const next = {
  placed: 'confirmed',
  confirmed: 'dispatched',
  dispatched: 'out_for_delivery',
  out_for_delivery: 'delivered',
};

export function nextOrderCheckpoint(status) {
  return Object.hasOwn(next, status) ? next[status] : null;
}

export function orderReference(id) {
  return `SDV-${id.toUpperCase()}`;
}
