// Guards `npm run dist`: the portable build must contain the sidecar, otherwise
// the shipped .exe silently has no transcription.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'sidecar', 'dist', 'overlay-transcriber', 'overlay-transcriber.exe');

if (!existsSync(bundle)) {
  console.error(
    '\nMissing the packaged transcription sidecar:\n' +
      `  ${bundle}\n\n` +
      'Build it first:\n' +
      '  npm run setup:sidecar     (once)\n' +
      '  npm run build:sidecar\n\n' +
      'Or build the overlay without transcription:\n' +
      '  npm run dist:app-only\n',
  );
  process.exit(1);
}

console.log('[check-sidecar] ok');
