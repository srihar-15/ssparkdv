const endpoint = 'https://identitytoolkit.googleapis.com/v1/accounts:';

export async function firebasePassword(action, fields, key) {
  if (!key) throw new Error('AUTH_FIREBASE_API_KEY is required');
  const response = await fetch(endpoint + action + '?key=' + key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...fields, returnSecureToken: true }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) {
    const code = data.error?.message || '';
    const error = new Error('Firebase authentication failed');
    error.code = code.split(' : ')[0];
    throw error;
  }
  return data;
}
