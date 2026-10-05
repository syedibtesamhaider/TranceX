// Removes build output so `npm run dist` always packages a fresh tree.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['dist', 'release']) {
  await rm(path.join(root, dir), { recursive: true, force: true });
}
console.log('[clean] removed dist/ and release/');
