/**
 * electron-builder configuration.
 *
 * Extends the `build` block in package.json with one dynamic bit: the Python
 * transcription sidecar ships as an extra resource only when it has been built.
 * That lets `npm run dist:app-only` produce an overlay-only binary without
 * maintaining a second config, and makes a forgotten sidecar build an explicit
 * error (see scripts/check-sidecar.mjs) rather than a silent omission.
 *
 * Both PyInstaller layouts are supported and land at the same place —
 * `resources/sidecar/overlay-transcriber.exe` — which is what SidecarManager
 * looks for:
 *   --onedir  (default) sidecar/dist/overlay-transcriber/
 *   --onefile           sidecar/dist/overlay-transcriber.exe
 */
const fs = require('node:fs');
const path = require('node:path');

const base = require('./package.json').build;

const oneDir = path.join(__dirname, 'sidecar', 'dist', 'overlay-transcriber');
const oneFile = path.join(__dirname, 'sidecar', 'dist', 'overlay-transcriber.exe');

let extraResources = [];
if (process.env.OVERLAY_SKIP_SIDECAR) {
  console.warn('[electron-builder] OVERLAY_SKIP_SIDECAR set — building without transcription');
} else if (fs.existsSync(path.join(oneDir, 'overlay-transcriber.exe'))) {
  extraResources = [{ from: 'sidecar/dist/overlay-transcriber', to: 'sidecar', filter: ['**/*'] }];
} else if (fs.existsSync(oneFile)) {
  extraResources = [{ from: 'sidecar/dist/overlay-transcriber.exe', to: 'sidecar/overlay-transcriber.exe' }];
} else {
  console.warn('[electron-builder] no sidecar bundle found — building without transcription');
}

module.exports = { ...base, extraResources };
