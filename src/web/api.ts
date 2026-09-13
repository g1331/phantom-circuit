let csrf = '';
export class LocalRequestError extends Error {
  constructor(
    public readonly kind: 'connection' | 'request',
    public readonly status: number,
  ) {
    super(`Local ${kind} failed (${status})`);
  }
}
export async function session() {
  const r = await fetch('/api/session');
  if (!r.ok) throw new LocalRequestError('connection', r.status);
  csrf = (await r.json()).csrf;
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Phantom-CSRF': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw data.error ? new Error(data.error) : new LocalRequestError('request', r.status);
  return data;
}
