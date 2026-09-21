import type { StaticTranslationKey } from './locale/core.ts';
import type { MessageDescriptor } from '../shared/types.ts';
export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly descriptor: MessageDescriptor,
  ) {
    super(message);
  }
}
let csrf = '';
export class LocalUiError extends Error {
  constructor(readonly key: StaticTranslationKey) {
    super(key);
  }
}
export class LocalRequestError extends Error {
  constructor(
    readonly kind: 'connection' | 'request',
    readonly status = 0,
  ) {
    super(kind === 'connection' ? 'Cannot connect to local service' : `Request failed (${status})`);
  }
}
export async function session() {
  const r = await fetch('/api/session');
  if (!r.ok) throw new LocalRequestError('connection');
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
      'Accept-Language': document.documentElement.lang,
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok)
    throw typeof data.code === 'string'
      ? new HostRequestError(data.error ?? data.message ?? '', {
          code: data.code,
          params: data.params,
          detail: data.detail,
        })
      : data.error
        ? new Error(data.error)
        : new LocalRequestError('request', r.status);
  return data;
}
