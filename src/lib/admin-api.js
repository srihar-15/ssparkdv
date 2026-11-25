async function parse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Admin request failed (${response.status}).`);
  if (!data || typeof data !== 'object') throw new Error('The admin response was empty.');
  return data;
}

export async function adminRead(resource, signal) {
  const response = await fetch(`/api/admin?resource=${encodeURIComponent(resource)}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  return parse(response);
}

export async function adminWrite(resource, action, payload = {}) {
  const response = await fetch('/api/admin', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource, action, ...payload }),
  });
  return parse(response);
}
