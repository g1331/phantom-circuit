/**
 * Stable host-facing message descriptors.
 *
 * `legacy` is deliberately kept separate from the rendered text. Existing clients and durable
 * records may still depend on the original Chinese message, while a new client can render the
 * same descriptor in another locale without parsing prose.
 */

export type HostLocale = 'zh-CN' | 'en';

export type HostMessageCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'service_unavailable'
  | 'bad_gateway'
  | 'gateway_timeout'
  | 'internal_error'
  | 'host_not_allowed'
  | 'origin_not_allowed'
  | 'session_expired'
  | 'csrf_required'
  | 'provider_invalid'
  | 'provider_unavailable'
  | 'agent_unavailable'
  | 'upload_storage_failed'
  | 'upload_limit_exceeded'
  | 'project_not_found'
  | 'cross_project'
  | 'invalid_price';

export type HostMessageParams = Record<string, string | number | boolean | null | undefined> & {
  status?: number;
  detail?: string;
  name?: string;
  id?: string;
  provider?: string;
  agent?: string;
  limit?: string | number;
  field?: string;
  model?: string;
};

/** A transport-safe descriptor. `legacy` is the raw, backward-compatible text. */
export interface HostMessageDescriptor<C extends string = HostMessageCode | string> {
  code: C;
  params?: HostMessageParams;
  legacy?: string;
  detail?: string;
}

const templates: Record<HostLocale, Partial<Record<HostMessageCode, string>>> = {
  'zh-CN': {
    bad_request: '请求无效',
    unauthorized: '本地会话已失效，请刷新页面',
    forbidden: '缺少本地操作校验',
    not_found: '请求的资源不存在',
    conflict: '当前资源状态不允许此操作',
    payload_too_large: '请求内容超过限制',
    service_unavailable: '服务暂时不可用，请稍后重试',
    bad_gateway: '上游服务返回无效响应',
    gateway_timeout: '上游服务响应超时',
    internal_error: '宿主服务发生内部错误',
    host_not_allowed: '不允许的 Host',
    origin_not_allowed: '不允许的跨站请求',
    session_expired: '本地会话已失效，请刷新页面',
    csrf_required: '缺少本地操作校验',
    provider_invalid: 'Provider 请求无效，请检查输入或稍后重试',
    provider_unavailable: 'Provider 暂时不可用，请稍后重试',
    agent_unavailable: 'Agent 当前不可用；已保存配置保持不变',
    upload_storage_failed: '图片保存失败，请检查本地磁盘空间和权限后重试',
    upload_limit_exceeded: '上传超限：每条消息最多 4 张图片，每张不超过 10 MiB',
    project_not_found: '项目不存在',
    cross_project: '跨项目操作被拒绝',
    invalid_price: '模型价格必须是非负十进制数',
  },
  en: {
    bad_request: 'Invalid request',
    unauthorized: 'The local session has expired; refresh the page',
    forbidden: 'The local operation check is missing',
    not_found: 'The requested resource was not found',
    conflict: 'The current resource state does not allow this operation',
    payload_too_large: 'The request exceeds the allowed size',
    service_unavailable: 'The service is temporarily unavailable; try again later',
    bad_gateway: 'The upstream service returned an invalid response',
    gateway_timeout: 'The upstream service timed out',
    internal_error: 'The host service encountered an internal error',
    host_not_allowed: 'Host is not allowed',
    origin_not_allowed: 'Cross-origin request is not allowed',
    session_expired: 'The local session has expired; refresh the page',
    csrf_required: 'The local operation check is missing',
    provider_invalid: 'Invalid Provider request; check the input and try again',
    provider_unavailable: 'The Provider is temporarily unavailable; try again later',
    agent_unavailable: 'The Agent is currently unavailable; saved configuration was retained',
    upload_storage_failed: 'Could not save the image; check local disk space and permissions',
    upload_limit_exceeded: 'Upload limit exceeded: at most 4 images per message, 10 MiB each',
    project_not_found: 'Project not found',
    cross_project: 'Cross-project operation denied',
    invalid_price: 'Model prices must be non-negative decimal values',
  },
};

const statusCodes: Partial<Record<number, HostMessageCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  502: 'bad_gateway',
  503: 'service_unavailable',
  504: 'gateway_timeout',
};

function interpolate(template: string, params: HostMessageParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (_all, key: string) => {
    const value = params[key as keyof HostMessageParams];
    return value === undefined ? `{${key}}` : String(value);
  });
}

/** Render a descriptor without ever attempting to interpret its legacy prose. */
export function renderHostMessage(
  descriptor: Pick<HostMessageDescriptor, 'code' | 'params' | 'legacy'> & {
    message?: string;
    error?: string;
  },
  locale: HostLocale = 'zh-CN',
): string {
  const code = descriptor.code as HostMessageCode;
  const template = templates[locale][code] ?? templates['zh-CN'][code];
  return template
    ? interpolate(template, descriptor.params ?? {})
    : (descriptor.legacy ?? descriptor.message ?? descriptor.error ?? '');
}

export function hostLocale(value: unknown): HostLocale {
  if (typeof value !== 'string') return 'zh-CN';
  const normalized = value.trim().toLowerCase();
  return normalized === 'en' || normalized.startsWith('en-') ? 'en' : 'zh-CN';
}

/** Pick a request locale from an explicit query/header value without parsing error text. */
export function requestHostLocale(locale: unknown, acceptLanguage: unknown): HostLocale {
  if (locale !== undefined) return hostLocale(locale);
  if (typeof acceptLanguage === 'string') {
    const first = acceptLanguage.split(',')[0]?.split(';')[0];
    return hostLocale(first);
  }
  return 'zh-CN';
}

/** Build a descriptor for an HTTP failure when the source did not provide one explicitly. */
export function hostDescriptor(
  status: number,
  legacy: string,
  detail?: string,
): HostMessageDescriptor {
  const code = statusCodes[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
  return {
    code,
    params: { status, ...(detail ? { detail } : {}) },
    legacy,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Normalize a descriptor attached by a domain Fault/adapter. This is intentionally structural so
 * the shared catalog does not import server-only classes and can be consumed by the browser.
 */
export function attachedHostDescriptor(
  error: unknown,
  status: number,
  legacy: string,
): HostMessageDescriptor {
  const candidate =
    typeof error === 'object' && error !== null && 'descriptor' in error
      ? (error as { descriptor?: unknown }).descriptor
      : undefined;
  if (typeof candidate === 'object' && candidate !== null) {
    const value = candidate as { code?: unknown; params?: unknown; detail?: unknown };
    if (typeof value.code === 'string') {
      const params =
        typeof value.params === 'object' && value.params !== null && !Array.isArray(value.params)
          ? (value.params as HostMessageParams)
          : {};
      const detail = typeof value.detail === 'string' ? value.detail : undefined;
      return {
        code: value.code,
        params,
        legacy,
        ...(detail ? { detail } : {}),
      };
    }
  }
  return hostDescriptor(status, legacy);
}

export const hostMessageTemplates = templates;
