import type { z } from 'zod';
import { redact } from './store.ts';

/** Bound on how many brace candidates one reply may contribute, so a pathological reply stays cheap. */
const MAX_BRACE_CANDIDATES = 64;
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
 * The JSON verdict carried by one review, feedback or merge reply. A JSON code fence wins; otherwise
 * the first balanced JSON object anywhere in the reply is used, so surrounding model prose is
 * tolerated. Returns undefined when the reply carries no JSON object at all.
 */
export function extractStructuredJson(reply: string): unknown {
  for (const block of fencedJsonBlocks(reply)) {
    const parsed = tryParse(block);
    if (parsed) return parsed.value;
  }
  let candidates = 0;
  for (let start = reply.indexOf('{'); start !== -1; start = reply.indexOf('{', start + 1)) {
    if (++candidates > MAX_BRACE_CANDIDATES) break;
    const end = matchingBrace(reply, start);
    if (end === -1) continue;
    const parsed = tryParse(reply.slice(start, end + 1));
    if (parsed) return parsed.value;
  }
  return undefined;
}

/**
 * Extract and strictly validate one structured turn reply. Replies without JSON, and JSON that
 * violates the schema, both fail; neither is ever treated as a pass.
 */
export function parseStructuredReply<T>(schema: z.ZodType<T>, reply: string): T | undefined {
  const value = extractStructuredJson(reply);
  if (value === undefined) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Redacted, byte-limited raw reply evidence for a domain-level pause reason. */
export function replyEvidence(reply: string, limit = EVIDENCE_LIMIT): string {
  const clean = redact(reply);
  if (!clean) return '<空回复>';
  let evidence = '';
  for (const character of clean) {
    if (Buffer.byteLength(evidence + character, 'utf8') > limit) break;
    evidence += character;
  }
  return evidence;
}
