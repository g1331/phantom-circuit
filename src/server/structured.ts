import type { z } from 'zod';
import { redact } from './store.ts';

/** Total characters the balanced-object scan may read, so a pathological reply stays cheap. */
const MAX_SCAN_CHARS = 1_000_000;
/** Evidence kept for a domain pause reason, in bytes. */
const EVIDENCE_LIMIT = 2048;

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** Fenced code blocks explicitly labelled as JSON, e.g. ```json … ```. */
function* fencedJsonBlocks(reply: string) {
  for (const match of reply.matchAll(/```[ \t]*json\b[ \t]*\r?\n?([\s\S]*?)```/gi))
    yield match[1].trim();
}

/** Index of the `}` closing the object that starts at `start`, or -1 when it never closes. */
function matchingBrace(reply: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < reply.length; i++) {
    const character = reply[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * JSON values one structured reply carries, in the host's order of preference: the content of code
 * fences explicitly labelled `json` first, then every balanced JSON object in the reply. Model prose
 * around the JSON is therefore tolerated, and a candidate the schema rejects never ends the search.
 * A reply that quotes a valid verdict-shaped object as an example is indistinguishable from one that
 * states it; the bounded re-ask above is the host's answer to that residual ambiguity.
 */
function* structuredCandidates(reply: string): Generator<unknown> {
  for (const block of fencedJsonBlocks(reply)) {
    const parsed = tryParse(block);
    if (parsed) yield parsed.value;
  }
  let scanned = 0;
  for (let start = reply.indexOf('{'); start !== -1; start = reply.indexOf('{', start + 1)) {
    if (scanned > MAX_SCAN_CHARS) return;
    const end = matchingBrace(reply, start);
    scanned += (end === -1 ? reply.length : end) - start + 1;
    if (end === -1) continue;
    const parsed = tryParse(reply.slice(start, end + 1));
    if (parsed) yield parsed.value;
  }
}

/**
 * The schema-valid verdict of one structured turn. Candidates are tried in preference order and the
 * first one the schema accepts wins, so a stale example object cannot hide the real verdict and the
 * schema is never loosened. A reply with no schema-valid JSON fails; that is never a pass.
 */
export function parseStructuredReply<T>(schema: z.ZodType<T>, reply: string): T | undefined {
  for (const candidate of structuredCandidates(reply)) {
    const result = schema.safeParse(candidate);
    if (result.success) return result.data;
  }
  return undefined;
}

/** Redacted, byte-limited raw reply evidence for a domain-level pause reason. */
function replyEvidence(reply: string, limit: number): string {
  const clean = redact(reply);
  if (!clean) return '<空回复>';
  let evidence = '';
  let bytes = 0;
  for (const character of clean) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit) break;
    evidence += character;
    bytes += size;
  }
  return evidence;
}

/**
 * Evidence for a structured turn that stayed unparsable: the reply that failed first and the reply
 * to the bounded re-ask, both cleaned and together inside the 2KB budget.
 */
export function turnEvidence(first: string, retry: string): string {
  const separator = ' …[重问后]… ';
  const half = Math.floor((EVIDENCE_LIMIT - Buffer.byteLength(separator, 'utf8')) / 2);
  return `${replyEvidence(first, half)}${separator}${replyEvidence(retry, half)}`;
}
