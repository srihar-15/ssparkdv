import { createHmac, timingSafeEqual } from 'node:crypto';

export class CommerceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function razorpayRequest(env, path, method = 'GET', body) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new CommerceError(503, 'Online payment is not configured.');
  }
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new CommerceError(502, 'Payment provider is unavailable. Please retry.');
  return response.json();
}

export function verifyCheckoutSignature(env, orderId, paymentId, signature) {
  if (!env.RAZORPAY_KEY_SECRET || !/^order_[a-zA-Z0-9]+$/.test(orderId ?? '') ||
      !/^pay_[a-zA-Z0-9]+$/.test(paymentId ?? '') || !/^[a-f0-9]{64}$/i.test(signature ?? '')) return false;
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function verifyWebhookSignature(secret, raw, signature) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

let shiprocketSession;
export async function shiprocketRequest(env, path, method = 'GET', body) {
  if (!env.SHIPROCKET_API_EMAIL || !env.SHIPROCKET_API_PASSWORD) {
    throw new CommerceError(503, 'Shipping provider is not configured.');
  }
  if (!shiprocketSession || shiprocketSession.expiresAt < Date.now() + 60000) {
    const login = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.SHIPROCKET_API_EMAIL, password: env.SHIPROCKET_API_PASSWORD }),
      signal: AbortSignal.timeout(15000),
    });
    if (!login.ok) throw new CommerceError(502, 'Shipping provider authentication failed.');
    const data = await login.json();
    if (!data.token) throw new CommerceError(502, 'Shipping provider returned no token.');
    shiprocketSession = { token: data.token, expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
  }
  const response = await fetch(`https://apiv2.shiprocket.in/v1/external/${path}`, {
    method,
    headers: { Authorization: `Bearer ${shiprocketSession.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 401) shiprocketSession = null;
  if (!response.ok) throw new CommerceError(502, 'Shipping provider is unavailable. Please retry.');
  return response.json();
}

export async function shiprocketRate(env, { pickupPincode, deliveryPincode, weightGrams, dimensionsCm, declaredValuePaise }) {
  const params = new URLSearchParams({
    pickup_postcode: pickupPincode,
    delivery_postcode: deliveryPincode,
    cod: '0',
    weight: String(Math.max(0.1, Math.ceil(weightGrams / 100) / 10)),
    declared_value: String(Math.ceil(declaredValuePaise / 100)),
    ...(dimensionsCm ? { length: String(dimensionsCm.length), breadth: String(dimensionsCm.width),
      height: String(dimensionsCm.height) } : {}),
  });
  const result = await shiprocketRequest(env, `courier/serviceability/?${params}`);
  const couriers = result.data?.available_courier_companies ?? [];
  const eligible = couriers.filter(c => Number.isFinite(Number(c.freight_charge)) && Number(c.freight_charge) >= 0 && c.courier_company_id);
  eligible.sort((a, b) => Number(a.freight_charge) - Number(b.freight_charge));
  if (!eligible.length) throw new CommerceError(422, 'Delivery is unavailable for this postal code.');
  const courier = eligible[0];
  return {
    carrier: courier.courier_name || 'Shiprocket',
    courierId: courier.courier_company_id,
    shippingPaise: Math.round(Number(courier.freight_charge) * 100),
    estimatedDays: courier.estimated_delivery_days ?? null,
  };
}
