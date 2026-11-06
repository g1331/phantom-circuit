import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));

export function runtimePath(...parts: string[]) {
  return join(runtimeRoot, ...parts);
}
