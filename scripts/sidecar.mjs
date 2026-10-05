// Runs the sidecar's Python from the project root, with the right cwd so the
// `transcriber` package resolves. Keeps npm scripts shell-agnostic.
//
//   node scripts/sidecar.mjs --probe
//   node scripts/sidecar.mjs --build [--onefile]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = path.join(root, 'sidecar');
const python = path.join(sidecar, '.venv', 'Scripts', 'python.exe');

if (!existsSync(python)) {
  console.error(`Missing ${python}\nRun: npm run setup:sidecar`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const build = argv.includes('--build');
const args = build
  ? ['build.py', ...argv.filter((a) => a !== '--build')]
  : ['-u', '-m', 'transcriber', ...argv];

const result = spawnSync(python, args, { cwd: sidecar, stdio: 'inherit' });
process.exit(result.status ?? 1);
