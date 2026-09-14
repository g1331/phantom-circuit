// One shared predicate answers "is this name a credential?", so the word list cannot drift apart
// between rules and silently stop matching a shape.
const credentialWords = new Set([
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'SECRET',
  'SECRETS',
  'TOKEN',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTHORIZATION',
  'COOKIE',
]);
const keyQualifiers = new Set(['API', 'ACCESS', 'SECRET', 'PRIVATE', 'SIGNING', 'ENCRYPTION']);
// Vendors and contexts whose name may be glued to a credential word, as in PGPASSWORD or MYSQLPWD.
const credentialPrefixes = new Set([
  'PG',
  'MYSQL',
  'MARIADB',
  'AWS',
  'AZURE',
  'GCP',
  'GOOGLE',
  'REDIS',
  'MONGO',
  'DOCKER',
  'REGISTRY',
  'NPM',
  'YARN',
  'GH',
  'GITHUB',
  'GITLAB',
  'DB',
  'SQL',
  'AZ',
  'KV',
  'AUTH',
  'OPENAI',
  'ANTHROPIC',
]);
// Every stem a run-on name can end in, and every word that may be glued in front of one. KEY and PWD are
// ambiguous, so they only count here with an issuer in front of them: APIKEY and PGPWD match, MONKEY does not.
const credentialStems = [...credentialWords, 'KEY', 'PWD'];
// TOKENS and COOKIES name a field or a count, so outside the password plurals a trailing S is not a credential.
const credentialPlurals = new Set(['PASSWORD', 'PASSWD']);
const credentialIssuers = [...new Set([...credentialPrefixes, ...keyQualifiers, ...credentialWords])].sort(
  (a, b) => b.length - a.length,
);

// Programs whose own CLI gives a flag to a password, and which form of that flag carries one. Only these
// programs are listed: docker's `-p` publishes a port and grep's `-a` selects text, so a blanket flag
// rule would delete diagnostic detail instead of a credential. `gluedOnly` marks the flags whose
// password must be written straight after the flag: mysql's `-p` alone prompts instead of carrying one
// (`mysql -p dbname` names a database), while redis-cli, sshpass and sqlcmd accept either form.
const passwordFlagPrograms: Record<string, { short: string; gluedOnly: boolean; long?: string }> = {
  mysql: { short: 'p', gluedOnly: true },
  mysqladmin: { short: 'p', gluedOnly: true },
  mysqldump: { short: 'p', gluedOnly: true },
  mysqlimport: { short: 'p', gluedOnly: true },
  mariadb: { short: 'p', gluedOnly: true },
  'mariadb-admin': { short: 'p', gluedOnly: true },
  'mariadb-dump': { short: 'p', gluedOnly: true },
  mariadbdump: { short: 'p', gluedOnly: true },
  'redis-cli': { short: 'a', gluedOnly: false, long: 'pass' },
  sshpass: { short: 'p', gluedOnly: false },
  sqlcmd: { short: 'P', gluedOnly: false },
};

export function isCredentialName(name: string): boolean {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toUpperCase());
  if (!segments.length) return false;
  if (segments.some((segment) => credentialWords.has(segment))) return true;
  if (segments.some((segment) => credentialRunOnCounts(segment))) return true;
  if (segments.length === 1) return false;
  // KEY is ambiguous across segments too (a JSON key, a sort key), so it needs a qualifying segment.
  if (segments.includes('PWD')) return true;
  return segments.includes('KEY') && segments.some((segment) => keyQualifiers.has(segment));
}

// A name written as one run-on segment (MYSQLPWD, APIKEY, AUTHTOKEN, PASSWORDS) only counts when it ends in
// a credential stem and what is left names the issuer. The issuer is built from vendors, key qualifiers and
// credential words, so it covers one word (TOKENKEY) or a combination (AWSSECRETKEY) instead of listing the
// glued forms by hand. TOKENIZERS_PARALLELISM, NOTOKEN, TOKENS, COOKIES and a bare KEY therefore keep their
// diagnostic value instead of being deleted.
function credentialRunOnCounts(segment: string): boolean {
  return credentialStems.some((stem) => {
    if (segment === `${stem}S`) return credentialPlurals.has(stem);
    if (segment.length <= stem.length || !segment.endsWith(stem)) return false;
    return credentialIssuer(segment.slice(0, -stem.length));
  });
}

// The prefix of a run-on name says who issued the credential. It has to be built from known issuers only, so
// AWS_ACCESSKEY and TOKENKEY match while NOTOKEN and MONKEY stay readable.
function credentialIssuer(prefix: string): boolean {
  let rest = prefix;
  while (rest) {
    const issuer = credentialIssuers.find((candidate) => rest.startsWith(candidate));
    if (!issuer) return false;
    rest = rest.slice(issuer.length);
  }
  return prefix.length > 0;
}

// A flag's meaning comes from the program that owns the command segment: `mysql -p` prompts for a
// password while `docker run -p` publishes a port. The owner is the first token this closed list names, so
// a wrapper such as `sudo`, `cmd /c`, `env NAME=value` or `powershell -Command` cannot hide it, and a path
// prefix, a Windows `.exe` suffix or surrounding quotes are not part of its name.
function programName(whole: string, offset: number): string {
  const segment = (whole.slice(0, offset).split(/[;&|\r\n]/).pop() ?? '').trim();
  for (const token of segment.split(/\s+/)) {
    const name = token
      .replace(/^["']|["']$/g, '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.exe$/i, '')
      .toLowerCase();
    if (Object.hasOwn(passwordFlagPrograms, name)) return name;
  }
  return '';
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
  return (
    value
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
      // A single-dash flag carries a password only in the program that defines it that way, so the value
      // is judged against the command segment's program rather than redacted everywhere `-p` appears.
      .replace(
        /(?<![-\S])(?<flag>--pass(?:=|\s+)|-(?<short>[A-Za-z])(?<gap>\s*))(?<value>"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s"']+)/g,
        (match, ...args) => {
          const groups = args.at(-1) as {
            flag: string;
            short: string | undefined;
            gap: string | undefined;
          };
          const spec =
            passwordFlagPrograms[programName(args.at(-2) as string, args.at(-3) as number)];
          if (!spec) return match;
          if (groups.short === undefined)
            return spec.long === 'pass' ? `${groups.flag}<REDACTED>` : match;
          if (groups.short !== spec.short) return match;
          if (groups.gap !== '' && spec.gluedOnly) return match;
          return `${groups.flag}<REDACTED>`;
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
        /(?<![\w.-])(?<assignment>["']?(?<name>[A-Za-z_][\w.-]{0,63})["']?\s*[=:](?!\s*\/\/)\s*)(?<value>"(?:\\.|[^"\\])*"|'[^']*'|[^?\s,;&}\]"']+)/gi,
        (match, ...args) => {
          // A URL scheme or query is not an assignment: the separator stops before `//` and the value
          // before `?`, so a credential query parameter is judged on its own, not swallowed as a value.
          // A quote ends an unquoted value, so the closing quote of a header keeps its command readable.
          const groups = args.at(-1) as { assignment: string; name: string };
          return isCredentialName(groups.name) ? `${groups.assignment}<REDACTED>` : match;
        },
      )
      // setx stores a Windows environment variable as `setx NAME value`, separated by a space.
      .replace(
        /(?<!\S)setx(?<gap>\s+)(?<name>["']?[A-Za-z_][\w.-]{0,63}["']?)(?<before>\s+)(?<value>"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s"']+)/gi,
        (match, ...args) => {
          const groups = args.at(-1) as { gap: string; name: string; before: string };
          return isCredentialName(groups.name)
            ? `setx${groups.gap}${groups.name}${groups.before}<REDACTED>`
            : match;
        },
      )
      // sqlplus takes its login as `user/pass@connect`, so only the password half is a credential.
      .replace(
        /(?<!\S)(?<program>sqlplus\s+)(?<login>[A-Za-z_][\w.$-]*\/)(?<password>[^\s/@]+)@/gi,
        '$1$2<REDACTED>@',
      )
      .replace(
        /(?<!\S)(?<flag>--[A-Za-z_][\w.-]{0,63}(?:=|\s+))(?<value>"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\]]+)/gi,
        (match, ...args) => {
          const groups = args.at(-1) as { flag: string; value: string };
          const name = groups.flag.replace(/^--/, '').replace(/[=\s]+$/, '');
          return isCredentialName(name) ? `${groups.flag}<REDACTED>` : match;
        },
      )
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
