/**
 * Ties the sidecar process, the WebSocket client and the UI together.
 *
 * Privacy: this class forwards events and holds no transcript. Recognized text
 * is never stored here, never logged, and never written to disk — the only copy
 * lives in the renderer's memory until the window goes away.
 */
import { EventEmitter } from 'node:events';
import { SidecarManager } from './sidecar-manager';
import { TranscriptClient, type SidecarEvent } from './transcript-client';

/** Latency knobs forwarded verbatim to the sidecar's `config` message. */
export interface TranscriptionTuning {
  segmentSilenceMs: number;
  vadMinSilenceMs: number;
  vadSpeechPadMs: number;
  maxSegmentSeconds: number;
  mergeWindowMs: number;
  mergeMaxSeconds: number;
  mergeGapMs: number;
  vocabulary: string;
  apiKey: string;
  sttMode: 'realtime' | 'batch';
  filterBackgroundAudio: boolean;
}

export type TranscriptionState =
  | 'stopped'
  | 'starting'
  | 'idle'
  | 'listening'
  | 'no_audio'
  | 'model_loading'
  | 'error';

export interface TranscriptionStatus {
  state: TranscriptionState;
  detail: string;
  sidecarAlive: boolean;
  sidecarKind: string | null;
  connected: boolean;
  device: string | null;
  computeType: string | null;
  deviceNote: string | null;
  audioDevice: string | null;
  model: string | null;
  language: string | null;
  englishOnly: boolean;
  behind: boolean;
  download: { percent: number; downloaded: number; total: number } | null;
}

export class TranscriptionService extends EventEmitter {
  private readonly sidecar = new SidecarManager();
  private readonly client = new TranscriptClient();
  private status: TranscriptionStatus = {
    state: 'stopped',
    detail: '',
    sidecarAlive: false,
    sidecarKind: null,
    connected: false,
    device: null,
    computeType: null,
    deviceNote: null,
    audioDevice: null,
    model: null,
    language: null,
    englishOnly: false,
    behind: false,
    download: null,
  };
  private desiredRunning = false;
  private pendingConfig: { language?: string; tuning?: TranscriptionTuning } = {};
  private reportedDevice: string | null = null;

  constructor() {
    super();

    this.sidecar.on('exit', ({ expected, code, stderr }) => {
      this.client.disconnect();
      if (expected) {
        this.patch({ state: 'stopped', detail: '', sidecarAlive: false, connected: false });
        return;
      }
      this.patch({
        state: 'error',
        detail: `Transcription engine stopped unexpectedly (exit ${code}).${stderr ? `\n${stderr}` : ''}`,
        sidecarAlive: false,
        connected: false,
      });
    });

    this.client.on('open', () => {
      this.patch({ connected: true });
      this.reportedDevice = null;
      if (this.pendingConfig.language || this.pendingConfig.tuning) {
        this.client.send({ type: 'config', ...this.pendingConfig });
      }
      if (this.desiredRunning) this.client.send({ type: 'start' });
    });

    this.client.on('event', (event: SidecarEvent) => this.onSidecarEvent(event));

    this.client.on('fatal', (err: Error) => {
      this.patch({ state: 'error', detail: err.message, connected: false });
    });
  }

  getStatus(): TranscriptionStatus {
    return { ...this.status };
  }

  /** Sidecar pid, so the self-test can prove it was actually reaped. */
  get sidecarPid(): number | null {
    return this.sidecar.pid;
  }

  /** Boots the sidecar if needed and begins transcribing. */
  async start(config: { language: string; tuning?: TranscriptionTuning }): Promise<void> {
    this.desiredRunning = true;
    this.pendingConfig = { language: config.language, tuning: config.tuning };
    this.patch({ state: 'starting', detail: '', language: config.language });

    if (!this.sidecar.alive) {
      try {
        const handshake = await this.sidecar.start();
        this.patch({ sidecarAlive: true, sidecarKind: this.sidecar.kind, detail: '' });
        this.client.connect(handshake);
      } catch (err) {
        this.desiredRunning = false;
        this.patch({
          state: 'error',
          detail: err instanceof Error ? err.message : String(err),
          sidecarAlive: false,
        });
        return;
      }
      return; // 'open' sends config + start
    }

    this.client.send({ type: 'config', ...this.pendingConfig });
    this.client.send({ type: 'start' });
  }

  stop(): void {
    this.desiredRunning = false;
    this.client.send({ type: 'stop' });
    this.patch({ state: 'idle', detail: '', behind: false });
  }

  /** Pushes the latency knobs; applies to the next segment, no restart. */
  setTuning(tuning: TranscriptionTuning): void {
    this.pendingConfig.tuning = tuning;
    this.client.send({ type: 'config', tuning });
  }

  /** Full restart after a crash, or when the user presses Restart. */
  async restart(config: { language: string; tuning?: TranscriptionTuning }): Promise<void> {
    this.client.disconnect();
    await this.sidecar.stop();
    this.patch({ sidecarAlive: false, connected: false, state: 'starting', detail: '' });
    await this.start(config);
  }

  setLanguage(language: string): void {
    this.pendingConfig.language = language;
    this.patch({ language });
    this.client.send({ type: 'config', language });
  }

  async shutdown(): Promise<void> {
    this.desiredRunning = false;
    this.client.disconnect();
    await this.sidecar.stop();
  }

  shutdownSync(): void {
    this.desiredRunning = false;
    this.client.disconnect();
    this.sidecar.stopSync();
  }

  // -- sidecar event handling -----------------------------------------------

  private onSidecarEvent(event: SidecarEvent): void {
    switch (event.type) {
      case 'ready':
      case 'state': {
        this.patch({
          device: (event.device as string) ?? null,
          computeType: (event.computeType as string) ?? null,
          deviceNote: (event.deviceNote as string) ?? null,
          audioDevice: (event.audioDevice as string) || null,
          model: (event.model as string) ?? this.status.model,
          language: (event.language as string) ?? this.status.language,
          englishOnly: Boolean(event.englishOnly),
        });
        break;
      }
      case 'status': {
        const state = String(event.state) as TranscriptionState;
        this.patch({ state, detail: String(event.detail ?? '') });
        break;
      }
      case 'audio_device': {
        this.patch({ audioDevice: String(event.name ?? '') });
        this.emit('notice', event.note ? String(event.note) : '');
        break;
      }
      case 'model_progress': {
        const total = Number(event.total ?? 0);
        this.patch({
          download: {
            percent: Number(event.percent ?? 0),
            downloaded: Number(event.downloaded ?? 0),
            total,
          },
        });
        break;
      }
      case 'model_ready': {
        const device = String(event.device ?? this.status.device ?? '');
        this.patch({
          download: null,
          model: String(event.model ?? this.status.model ?? ''),
          device,
          computeType: String(event.compute_type ?? this.status.computeType ?? ''),
          deviceNote: String(event.note ?? this.status.deviceNote ?? ''),
          englishOnly: Boolean(event.english_only),
        });
        // Only once the model is loaded is the compute path final — the CUDA
        // fallback can change it after the initial probe.
        if (device && device !== this.reportedDevice) {
          this.reportedDevice = device;
          this.emit('device', { device, computeType: String(event.compute_type ?? '') });
        }
        break;
      }
      case 'backlog': {
        this.patch({ behind: Boolean(event.behind) });
        break;
      }
      case 'segment_closed': {
        // End-of-speech, emitted before the final transcription exists. Lets
        // downstream work (the auto-answer lookup) overlap with inference.
        this.emit('segmentClosed', Number(event.id));
        return;
      }
      case 'interim':
      case 'final':
      case 'drop': {
        // Straight through to the renderer; nothing is retained here.
        this.emit('transcript', event);
        return;
      }
      case 'notice': {
        this.emit('notice', String(event.message ?? ''));
        return;
      }
      default:
        return;
    }
    this.emit('status', this.getStatus());
  }

  private patch(partial: Partial<TranscriptionStatus>): void {
    this.status = { ...this.status, ...partial };
    this.status.sidecarAlive = this.sidecar.alive;
    this.status.sidecarKind = this.sidecar.kind;
    this.emit('status', this.getStatus());
  }
}
