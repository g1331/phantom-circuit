let csrf = '';
export async function session() {
  const r = await fetch('/api/session');
  if (!r.ok) throw new Error('无法连接本地服务');
  csrf = (await r.json()).csrf;
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'X-Phantom-CSRF': csrf,
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `请求失败 (${r.status})`);
  return data;
}
