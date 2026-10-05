// Creates the Python 3.11 virtual environment for the transcription sidecar.
//
// 3.11 is pinned because PyAudioWPatch has no wheels for 3.12+. The dependency
// set is tiny now that recognition happens in the ElevenLabs API — audio capture,
// numpy, websockets and requests.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = path.join(root, 'sidecar');
const venv = path.join(sidecar, '.venv');
const venvPython = path.join(venv, 'Scripts', 'python.exe');
const requirements = path.join(sidecar, 'requirements.txt');

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  return result.status === 0;
}

function has(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', shell: false });
  return result.status === 0;
}

const useUv = has('uv');

if (!existsSync(venvPython)) {
  const created = useUv
    ? run('uv', ['venv', '--python', '3.11', venv])
    : run('py', ['-3.11', '-m', 'venv', venv]);
  if (!created) {
    console.error(
      '\nCould not create the Python 3.11 environment.\n' +
        'Install Python 3.11 (https://www.python.org/downloads/release/python-3119/)\n' +
        'or install uv (https://docs.astral.sh/uv/) and re-run `npm run setup:sidecar`.',
    );
    process.exit(1);
  }
}

const installed = useUv
  ? run('uv', ['pip', 'install', '--python', venvPython, '-r', requirements])
  : run(venvPython, ['-m', 'pip', 'install', '-r', requirements]);

if (!installed) {
  console.error('\nDependency installation failed.');
  process.exit(1);
}

console.log('\nSidecar environment ready.');
console.log('Check it with:  npm run sidecar:probe');
if (!gpu) {
}
