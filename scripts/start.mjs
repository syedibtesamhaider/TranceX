// Launches Electron with the app.
//
// ELECTRON_RUN_AS_NODE is stripped deliberately: some hosts (VS Code's
// integrated terminal / extension host, certain CI runners) export it, and it
// makes electron.exe boot as a plain Node process, where `require('electron')`
// returns a path string instead of the API and the app crashes at startup.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));
