const credentialKey =
  /^(?:(?:proxy[-_])?authorization|(?:set[-_])?cookie|(?:[\w]+[-_])?(?:api[-_]?key|token|password|passwd|secret)|apiKey|accessToken|refreshToken|clientSecret|password|secret|token)$/i;

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        credentialKey.test(key) ? '<REDACTED>' : redactValue(child),
      ]),
    );
  return value;
}

export function redact(value: string): string {
  // Structured tool arguments often contain quoted credentials, spaces and escaped newlines.
  if (/^\s*[\[{]/.test(value)) {
    try {
      return JSON.stringify(redactValue(JSON.parse(value)));
    } catch {
      /* Plain text follows. */
    }
  }
  return value
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      '<REDACTED>',
    )
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi, '$1<REDACTED>@')
    .replace(
      /(?<!\S)(--(?:proxy-)?user(?:=|\s+)|-[uU]\s*)("(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s"']+)/g,
      (match, flag: string, argument: string) => {
        // Other tools use -u for a URL. Its userinfo has already been removed above.
        const value = argument.replace(/^["']|["']$/g, '');
        return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? match : `${flag}<REDACTED>`;
      },
    )
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, 'Bearer <REDACTED>')
    .replace(
      /(["'])((?:proxy-)?authorization|(?:set-)?cookie)\s*:\s*[^\r\n]*?\1/gi,
      '$1$2: <REDACTED>$1',
    )
    .replace(
      /(["'](?:authorization|(?:set-)?cookie)["']\s*:\s*)("(?:\\.|[^"\\])*"|'[^']*')/gi,
      '$1"<REDACTED>"',
    )
    .replace(/(?<![\w"'])((?:authorization|(?:set-)?cookie)\s*[=:]\s*)[^\r\n]+/gi, '$1<REDACTED>')
    .replace(
      /(?<![\w\\/:.-])(["']?(?:[\w]{1,64}[_-])?(?:api[_-]?key|accessToken|refreshToken|clientSecret|token|password|passwd|secret)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\]]+)/gi,
      '$1<REDACTED>',
    )
    .replace(
      /(?<!\S)(--(?:[\w]{1,64}[_-])?(?:api[_-]?key|accessToken|refreshToken|clientSecret|token|password|passwd|secret)(?:=|\s+))("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\]]+)/gi,
      '$1<REDACTED>',
    );
}

export function bounded(value: string, limit = 8000): string {
  const safe = redact(value);
  return safe.length <= limit
    ? safe
    : `${safe.slice(0, limit)}\n… [已截断 ${safe.length - limit} 字符]`;
}

// A separate publication seam: local diagnostic paths never need this treatment in the UI.
export function externalValue(value: unknown): unknown {
  const safe = redactValue(value);
  const paths = (v: unknown): unknown => {
    if (typeof v === 'string')
      return v
        .replace(/(?<![\w+./\\-])[A-Za-z]:[\\/][^\r\n"'<>]+/g, '<LOCAL_PATH>')
        .replace(/(?<![\w/.:])\/(?:Users|home|tmp|var|private)\/[^\s"'<>]+/g, '<LOCAL_PATH>');
    if (Array.isArray(v)) return v.map(paths);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, paths(child)]));
    return v;
  };
  return paths(safe);
}
