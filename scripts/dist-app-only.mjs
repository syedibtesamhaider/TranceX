// Portable build of the overlay WITHOUT the transcription sidecar.
// Setting the env var here keeps the npm script shell-agnostic.
import { spawnSync } from 'node:child_process';

const env = { ...process.env, OVERLAY_SKIP_SIDECAR: '1' };
const steps = [
  ['npm', ['run', 'clean']],
  ['npm', ['run', 'build']],
  ['npx', ['electron-builder', '--win', 'portable', '--config', 'electron-builder.config.cjs']],
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
