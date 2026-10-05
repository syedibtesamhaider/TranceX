/**
 * Spawns and supervises the Python transcription sidecar.
 *
 * Resolution order for the executable (first hit wins):
 *   1. $OVERLAY_SIDECAR                       — explicit override
 *   2. sidecar/.venv/Scripts/python.exe       — dev environment (GPU capable)
 *   3. <resources>/sidecar/overlay-transcriber.exe  — the packaged PyInstaller build
 *   4. sidecar/dist/overlay-transcriber/...   — a locally built PyInstaller bundle
 *
 * The dev venv is preferred over the bundled exe on purpose: PyInstaller cannot
 * reliably carry the cuDNN/cuBLAS libraries ctranslate2 needs, so the packaged
 * sidecar is CPU-only while the venv can use CUDA.
 *
 * Orphan prevention is deliberate and layered:
 *   - the child watches its stdin, so if this process dies without running any
 *     handler (Task Manager kill), it sees EOF and exits by itself;
 *   - on a normal quit we ask it to shut down, then `taskkill /T /F` the whole
 *     tree, because a PyInstaller one-file bootloader spawns a grandchild that a
 *     plain kill() would orphan — an orphan keeps holding the audio device.
 */
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface SidecarHandshake {
  port: number;
  token: string;
}

interface Resolved {
  command: string;
  args: string[];
  cwd: string;
  kind: 'dev-venv' | 'packaged' | 'local-build' | 'override';
}

const HANDSHAKE_PREFIX = 'SIDECAR_READY ';
const HANDSHAKE_TIMEOUT_MS = 20000;

export class SidecarManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private handshake: SidecarHandshake | null = null;
  private stopping = false;
  private stderrTail: string[] = [];
  private resolvedKind: Resolved['kind'] | null = null;

  get info(): SidecarHandshake | null {
    return this.handshake;
  }

  get kind(): string | null {
    return this.resolvedKind;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** OS pid of the sidecar, for diagnostics and the orphan self-test. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Last few stderr lines, used to explain a crash in the UI. */
  get lastError(): string {
    return this.stderrTail.slice(-6).join('\n').trim();
  }

  private repoRoot(): string {
    // dist/main/transcription -> project root in dev; unused when packaged.
    return path.resolve(__dirname, '..', '..', '..');
  }

  private resolve(): Resolved | null {
    const override = process.env.OVERLAY_SIDECAR;
    if (override && fs.existsSync(override)) {
      // Pointing the override at a venv's python.exe is the supported way to get
      // the GPU path out of a *packaged* build, where the bundled CPU-only
      // sidecar would otherwise win. Infer the module invocation from the
      // interpreter: <sidecar>/.venv/Scripts/python.exe -> cwd <sidecar>.
      if (/^pythonw?\.exe$/i.test(path.basename(override))) {
        return {
          command: override,
          args: ['-u', '-m', 'transcriber'],
          cwd: path.resolve(path.dirname(override), '..', '..'),
          kind: 'override',
        };
      }
      return { command: override, args: [], cwd: path.dirname(override), kind: 'override' };
    }

    const root = this.repoRoot();
    const venvPython = path.join(root, 'sidecar', '.venv', 'Scripts', 'python.exe');
    if (!app.isPackaged && fs.existsSync(venvPython)) {
      return {
        command: venvPython,
        args: ['-u', '-m', 'transcriber'],
        cwd: path.join(root, 'sidecar'),
        kind: 'dev-venv',
      };
    }

    const packaged = path.join(process.resourcesPath ?? '', 'sidecar', 'overlay-transcriber.exe');
    if (fs.existsSync(packaged)) {
      return { command: packaged, args: [], cwd: path.dirname(packaged), kind: 'packaged' };
    }

    const localBuild = path.join(
      root,
      'sidecar',
      'dist',
      'overlay-transcriber',
      'overlay-transcriber.exe',
    );
    if (fs.existsSync(localBuild)) {
      return { command: localBuild, args: [], cwd: path.dirname(localBuild), kind: 'local-build' };
    }

    return null;
  }

  async start(): Promise<SidecarHandshake> {
    if (this.alive && this.handshake) return this.handshake;
    await this.stop();
    this.sweepOrphans();

    const resolved = this.resolve();
    if (!resolved) {
      throw new Error(
        'Transcription sidecar not found. Run `npm run setup:sidecar` for development, ' +
          'or `npm run build:sidecar` to produce the bundled executable.',
      );
    }
    this.resolvedKind = resolved.kind;

    const token = randomBytes(32).toString('hex');
    const modelsDir = path.join(app.getPath('userData'), 'models');

    this.stopping = false;
    this.stderrTail = [];

    const child = spawn(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Token goes through the environment, never argv.
        OVERLAY_SIDECAR_TOKEN: token,
        OVERLAY_MODELS_DIR: modelsDir,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        HF_HUB_DISABLE_TELEMETRY: '1',
      },
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        this.emit('log', line);
      }
    });

    child.on('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      this.handshake = null;
      this.emit('exit', { code, signal, expected: wasStopping, stderr: this.lastError });
    });

    child.on('error', (err) => {
      this.emit('error', err);
    });

    const handshake = await this.awaitHandshake(child, token);
    this.handshake = handshake;
    this.emit('ready', handshake);
    return handshake;
  }

  private awaitHandshake(
    child: ChildProcessWithoutNullStreams,
    token: string,
  ): Promise<SidecarHandshake> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Sidecar did not report a port within ${HANDSHAKE_TIMEOUT_MS / 1000}s.` +
              (this.lastError ? `\n${this.lastError}` : ''),
          ),
        );
      }, HANDSHAKE_TIMEOUT_MS);

      const finish = (err: Error | null, value?: SidecarHandshake) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value!);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith(HANDSHAKE_PREFIX)) {
            try {
              const parsed = JSON.parse(line.slice(HANDSHAKE_PREFIX.length)) as { port: number };
              finish(null, { port: parsed.port, token });
            } catch (err) {
              finish(err instanceof Error ? err : new Error(String(err)));
            }
            return;
          }
          index = buffer.indexOf('\n');
        }
      });

      child.once('exit', (code) => {
        finish(
          new Error(
            `Sidecar exited with code ${code} before it was ready.` +
              (this.lastError ? `\n${this.lastError}` : ''),
          ),
        );
      });
    });
  }

  /** Graceful shutdown, then a hard kill of the whole process tree. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.handshake = null;

    try {
      child.stdin.write('shutdown\n');
      child.stdin.end();
    } catch {
      /* already gone */
    }

    const exited = await this.waitForExit(child, 2500);
    if (exited) {
      this.child = null;
      return;
    }

    this.killTree(child.pid);
    await this.waitForExit(child, 2000);
    this.child = null;
  }

  /** Synchronous last resort for `will-quit`, where promises will not settle. */
  stopSync(): void {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    this.killTree(child.pid, true);
    this.child = null;
    this.handshake = null;
  }

  /**
   * `sync` matters more than it looks. On `will-quit` the process exits as soon
   * as the handler returns, so an async `spawn` of taskkill is never actually
   * scheduled and the sidecar is orphaned — still holding the audio device and
   * still streaming to the transcription API on the user's key. Orphans from
   * previous runs were found doing exactly that.
   */
  private killTree(pid: number | undefined, sync = false): void {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        // /T kills the launcher's re-exec'd child too; a plain kill orphans it.
        const args = ['/pid', String(pid), '/T', '/F'];
        const options = { windowsHide: true, stdio: 'ignore' as const };
        if (sync) spawnSync('taskkill', args, options);
        else spawn('taskkill', args, options).unref();
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Kills transcriber processes left over from a previous run.
   *
   * The app is single-instance, so any sidecar running before we spawn ours is
   * by definition an orphan. Leaving it costs more than tidiness: two sidecars
   * capture the same WASAPI endpoint, which makes the second one's stream open
   * at the first one's engine period and fail reads with paUnanticipatedHostError,
   * and both hold their own realtime session, so the API is billed twice.
   *
   * Matched on the module we launch rather than on the interpreter, and only
   * ever run at start-up.
   */
  private sweepOrphans(): void {
    if (process.platform !== 'win32') return;
    try {
      // Single quotes only: this string crosses Node's Windows argv escaping,
      // and an embedded double quote does not survive it intact.
      const query =
        'Get-CimInstance Win32_Process | Where-Object { ' +
        "$_.Name -like 'python*' -and $_.CommandLine -like '*-m transcriber*' } | " +
        'Select-Object -ExpandProperty ProcessId';
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', query],
        { windowsHide: true, timeout: 5000, encoding: 'utf8' },
      );
      const pids = out
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      for (const pid of pids) {
        console.log(`[sidecar] killing orphaned sidecar from a previous run (pid ${pid})`);
        this.killTree(pid, true);
      }
    } catch {
      // Best effort: a failed sweep must never stop the sidecar from starting.
    }
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
