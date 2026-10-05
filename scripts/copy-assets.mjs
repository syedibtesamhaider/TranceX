// Copies static renderer assets (.html, .css) from src/renderer into dist/renderer,
// preserving the folder layout. No third-party deps on purpose.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'renderer');
const outDir = path.join(root, 'dist', 'renderer');

const COPY_EXT = new Set(['.html', '.css', '.svg', '.png']);

async function walk(dir, rel = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(dir, entry.name);
    const relPath = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      await walk(from, relPath);
    } else if (COPY_EXT.has(path.extname(entry.name).toLowerCase())) {
      const to = path.join(outDir, relPath);
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to);
    }
  }
}

if (!existsSync(srcDir)) {
  console.error(`[copy-assets] missing ${srcDir}`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
await walk(srcDir);
console.log('[copy-assets] renderer assets copied to dist/renderer');
