export class CommerceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendCommerceError(res, error) {
  if ((error.status || 0) >= 400 && error.status < 500) return sendJson(res, error.status, { error: error.message });
  console.error('Commerce API error:', error.code || error.name, error.message);
  return sendJson(res, 503, { error: 'Commerce service is unavailable. Please try again.' });
}

export async function readJson(req, limit = 1024 * 1024) {
  if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw new CommerceError(415, 'Use a JSON request.');
  if (Number(req.headers['content-length']) > limit) throw new CommerceError(413, 'Request is too large.');
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new CommerceError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CommerceError(400, 'Invalid JSON request.'); }
}

export function requireSameOrigin(req) {
  if (/^Bearer /i.test(req.headers.authorization || '')) return;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin || !host) throw new CommerceError(403, 'Same-origin request required.');
  try {
    const parsed = new URL(origin);
    const forwardedScheme = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const expectedScheme = req.socket?.encrypted || forwardedScheme === 'https' || process.env.NODE_ENV === 'production'
      ? 'https:' : 'http:';
    if (parsed.host === host && parsed.protocol === expectedScheme) return;
  } catch { /* The request origin is invalid. */ }
  throw new CommerceError(403, 'Same-origin request required.');
}

export function methodAllowed(req, methods) {
  if (methods.includes(req.method)) return;
  throw new CommerceError(405, 'Method not allowed.');
}
