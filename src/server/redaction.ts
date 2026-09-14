// One shared predicate answers "is this name a credential?", so the word list cannot drift apart
// between rules and silently stop matching a shape.
const credentialWords = new Set([
  'PASSWORD',
  'PASSWD',
  'PWD',
  'SECRET',
  'SECRETS',
  'TOKEN',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTHORIZATION',
  'COOKIE',
]);
const keyQualifiers = new Set(['API', 'ACCESS', 'SECRET', 'PRIVATE', 'SIGNING', 'ENCRYPTION']);

export function isCredentialName(name: string): boolean {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toUpperCase());
  if (!segments.length) return false;
  if (segments.some((segment) => credentialWords.has(segment))) return true;
  // A run-on name (PGPASSWORD, AUTHTOKEN, MYSQLPWD) counts only when the whole segment ends with a
  // credential word, so names such as TOKENIZERS_PARALLELISM keep their diagnostic value.
  if (segments.length === 1)
    return [...credentialWords].some(
      (word) => segments[0].length > word.length && segments[0].endsWith(word),
    );
  // KEY is ambiguous on its own (a JSON key, a sort key), so it needs a qualifying segment.
  return segments.includes('KEY') && segments.some((segment) => keyQualifiers.has(segment));
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isCredentialName(key) ? '<REDACTED>' : redactValue(child),
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
  // PowerShell uses a provider prefix; do not loosen the generic path-safe key boundary.
  return value
    .replace(
      /(\$(?:env:([\w]+)|\{env:([^}]+)\})\s*=\s*)("(?:`[\s\S]|[^"`])*"|'(?:''|[^'])*'|[^\s;|&]+)/gi,
      (match, assignment: string, name: string | undefined, bracedName: string | undefined) =>
        isCredentialName(name ?? bracedName ?? '') ? `${assignment}<REDACTED>` : match,
    )
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
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return match;
        // Only a value that carries a password (user:pass) is a credential. A bare user name, a UID
        // or a UID:GID pair stays readable so the expanded detail can still be diagnosed.
        const separator = value.indexOf(':');
        const user = value.slice(0, separator);
        const password = value.slice(separator + 1);
        const carriesPassword =
          separator > 0 && password.length > 0 && !(/^\d+$/.test(user) && /^\d+$/.test(password));
        return carriesPassword ? `${flag}<REDACTED>` : match;
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
    .replace(
      /(?<![\w"'\\/:.-])((?:authorization|(?:set-)?cookie)\s*[=:]\s*)[^\r\n]+/gi,
      '$1<REDACTED>',
    )
    .replace(
      /(?<![\w.-])(?<assignment>["']?(?<name>[A-Za-z_][\w.-]{0,63})["']?\s*[=:](?!\s*\/\/)\s*)(?<value>"(?:\\.|[^"\\])*"|'[^']*'|[^?\s,;&}\]]+)/gi,
      (match, ...args) => {
        // A URL scheme or query is not an assignment: the separator stops before `//` and the value
        // before `?`, so a credential query parameter is judged on its own, not swallowed as a value.
        const groups = args.at(-1) as { assignment: string; name: string };
        return isCredentialName(groups.name) ? `${groups.assignment}<REDACTED>` : match;
      },
    )
    .replace(
      /(?<!\S)(?<flag>--[A-Za-z_][\w.-]{0,63}(?:=|\s+))(?<value>"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\]]+)/gi,
      (match, ...args) => {
        const groups = args.at(-1) as { flag: string; value: string };
        const name = groups.flag.replace(/^--/, '').replace(/[=\s]+$/, '');
        return isCredentialName(name) ? `${groups.flag}<REDACTED>` : match;
      },
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
