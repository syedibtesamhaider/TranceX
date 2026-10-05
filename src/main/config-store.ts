/**
 * Config persistence: a single JSON file in the Electron userData directory.
 * Writes are debounced and atomic (temp file + rename) so a crash mid-write
 * cannot leave a truncated config behind.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  MAX_OPACITY,
  MAX_TRANSCRIPT_FONT,
  MIN_OPACITY,
  MIN_TRANSCRIPT_FONT,
  CONFIG_SCHEMA_VERSION,
  STT_MODES,
  TRANSCRIPTION_LANGUAGES,
  TUNING_LIMITS,
  type AppConfig,
  type Bounds,
  type ConfigPatch,
  type TranscriptionConfig,
  type SttMode,
  type TranscriptionLanguage,
  type LookupConfig,
  type LLMProviderId,
  LLM_PROVIDERS,
} from '../shared/types';

const WRITE_DELAY_MS = 250;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeBounds(raw: unknown): Bounds | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const nums = ['x', 'y', 'width', 'height'].map((k) => b[k]);
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return {
    x: Math.round(b.x as number),
    y: Math.round(b.y as number),
    width: Math.round(b.width as number),
    height: Math.round(b.height as number),
  };
}

function sanitizeTranscription(raw: unknown): TranscriptionConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fallback = DEFAULT_CONFIG.transcription;
  const language = input.language as TranscriptionLanguage;

  const num = (key: keyof typeof TUNING_LIMITS, decimals = 0): number => {
    const value = input[key];
    const limits = TUNING_LIMITS[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback[key];
    const clamped = clamp(value, limits.min, limits.max);
    return decimals > 0 ? Number(clamped.toFixed(decimals)) : Math.round(clamped);
  };

  const mode = input.sttMode as SttMode;
  return {
    sttMode: STT_MODES.includes(mode) ? mode : fallback.sttMode,
    filterBackgroundAudio:
      typeof input.filterBackgroundAudio === 'boolean'
        ? input.filterBackgroundAudio
        : fallback.filterBackgroundAudio,
    language: TRANSCRIPTION_LANGUAGES.includes(language) ? language : fallback.language,
    fontSize:
      typeof input.fontSize === 'number' && Number.isFinite(input.fontSize)
        ? Math.round(clamp(input.fontSize, MIN_TRANSCRIPT_FONT, MAX_TRANSCRIPT_FONT))
        : fallback.fontSize,
    segmentSilenceMs: num('segmentSilenceMs'),
    vadMinSilenceMs: num('vadMinSilenceMs'),
    vadSpeechPadMs: num('vadSpeechPadMs'),
    maxSegmentSeconds: num('maxSegmentSeconds', 1),
    mergeWindowMs: num('mergeWindowMs'),
    mergeMaxSeconds: num('mergeMaxSeconds', 1),
    mergeGapMs: num('mergeGapMs'),
    vocabulary:
      typeof input.vocabulary === 'string' ? input.vocabulary : fallback.vocabulary,
    // Stored verbatim — never trimmed or rewritten.
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : fallback.apiKey,
  };
}

function sanitizeLookup(raw: unknown): LookupConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fallback = DEFAULT_CONFIG.lookup;
  const provider = input.provider as LLMProviderId;

  const str = (key: keyof LookupConfig): string =>
    typeof input[key] === 'string' ? (input[key] as string).trim() : (fallback[key] as string);
  const int = (key: keyof LookupConfig, min: number, max: number): number =>
    typeof input[key] === 'number' && Number.isFinite(input[key] as number)
      ? Math.round(clamp(input[key] as number, min, max))
      : (fallback[key] as number);

  return {
    autoAnswer: typeof input.autoAnswer === 'boolean' ? input.autoAnswer : fallback.autoAnswer,
    provider: LLM_PROVIDERS.includes(provider) ? provider : fallback.provider,
    baseUrl: str('baseUrl'),
    model: str('model') || fallback.model,
    // Never trimmed away or rewritten — the key is stored exactly as given.
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : fallback.apiKey,
    bulletCount: str('bulletCount') || fallback.bulletCount,
    maxTokens: int('maxTokens', 64, 8192),
    timeoutMs: int('timeoutMs', 1000, 60000),
    callsPerHour: int('callsPerHour', 1, 1000),
    minSpacingMs: int('minSpacingMs', 0, 600000),
    pauseMinutes: int('pauseMinutes', 1, 240),
    fadeSeconds: int('fadeSeconds', 5, 600),
    maxEntries: int('maxEntries', 1, 20),
  };
}

/**
 * One-time migrations for defaults that changed after release.
 *
 * `sanitize` deliberately preserves anything already stored, which means a
 * changed default never reaches an existing install on its own. The accuracy
 * work (v2) is worthless if a config written before it keeps the old 350 ms /
 * 3 s segmentation, so those specific old values are moved forward once.
 * Anything the user had customised away from the old defaults is left alone.
 */
function migrate(input: Record<string, unknown>): Record<string, unknown> {
  const version = typeof input.schemaVersion === 'number' ? input.schemaVersion : 1;
  if (version >= CONFIG_SCHEMA_VERSION) return input;

  const t = (input.transcription ?? {}) as Record<string, unknown>;
  const next = { ...t };

  // v1 -> v2: segmentation defaults moved for accuracy.
  if (next.segmentSilenceMs === 350) next.segmentSilenceMs = 700;
  if (next.vadMinSilenceMs === 350) next.vadMinSilenceMs = 700;
  if (next.maxSegmentSeconds === 3) next.maxSegmentSeconds = 12;

  // v2 -> v3: the local Whisper engine was removed. Carry the vocabulary over
  // from the old field name and drop the model-selection settings, which no
  // longer mean anything.
  if (typeof next.initialPrompt === 'string' && typeof next.vocabulary !== 'string') {
    next.vocabulary = next.initialPrompt;
  }
  delete next.initialPrompt;
  delete next.model;
  delete next.autoModel;
  delete next.sttProvider;
  delete next.sttFallbackLocal;

  // v3 -> v4: streaming recognition became the default.
  if (typeof next.sttMode !== 'string') next.sttMode = 'realtime';

  console.log(`[config] migrated schema v${version} -> v${CONFIG_SCHEMA_VERSION}`);
  return { ...input, schemaVersion: CONFIG_SCHEMA_VERSION, transcription: next };
}

function sanitize(raw: unknown): AppConfig {
  const input = migrate((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    hotkeyTranscribe:
      typeof input.hotkeyTranscribe === 'string' && input.hotkeyTranscribe.trim().length > 0
        ? input.hotkeyTranscribe.trim()
        : DEFAULT_CONFIG.hotkeyTranscribe,
    hotkeyQuit:
      typeof input.hotkeyQuit === 'string' && input.hotkeyQuit.trim().length > 0
        ? input.hotkeyQuit.trim()
        : DEFAULT_CONFIG.hotkeyQuit,
    transcription: sanitizeTranscription(input.transcription),
    lookup: sanitizeLookup(input.lookup),
    hotkeyLookup:
      typeof input.hotkeyLookup === 'string' && input.hotkeyLookup.trim().length > 0
        ? input.hotkeyLookup.trim()
        : DEFAULT_CONFIG.hotkeyLookup,
    hotkeyPause:
      typeof input.hotkeyPause === 'string' && input.hotkeyPause.trim().length > 0
        ? input.hotkeyPause.trim()
        : DEFAULT_CONFIG.hotkeyPause,
    bounds: sanitizeBounds(input.bounds),
    visible: typeof input.visible === 'boolean' ? input.visible : DEFAULT_CONFIG.visible,
    opacity:
      typeof input.opacity === 'number' && Number.isFinite(input.opacity)
        ? clamp(input.opacity, MIN_OPACITY, MAX_OPACITY)
        : DEFAULT_CONFIG.opacity,
    hotkey:
      typeof input.hotkey === 'string' && input.hotkey.trim().length > 0
        ? input.hotkey.trim()
        : DEFAULT_CONFIG.hotkey,
    alwaysOnTop:
      typeof input.alwaysOnTop === 'boolean' ? input.alwaysOnTop : DEFAULT_CONFIG.alwaysOnTop,
  };
}

export class ConfigStore {
  private readonly filePath: string;
  private current: AppConfig;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(config: AppConfig) => void>();

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'config.json');
    this.current = this.read();
  }

  get path(): string {
    return this.filePath;
  }

  get(): AppConfig {
    return { ...this.current };
  }

  set(patch: ConfigPatch): AppConfig {
    const merged: Record<string, unknown> = { ...this.current, ...patch };
    if (patch.transcription) {
      // Nested sections are merged, not replaced, so callers can patch one field.
      merged.transcription = { ...this.current.transcription, ...patch.transcription };
    }
    if (patch.lookup) {
      merged.lookup = { ...this.current.lookup, ...patch.lookup };
    }
    this.current = sanitize(merged);
    this.scheduleWrite();
    for (const listener of this.listeners) listener(this.get());
    return this.get();
  }

  onChange(listener: (config: AppConfig) => void): void {
    this.listeners.add(listener);
  }

  /** Writes immediately, e.g. on quit. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  private read(): AppConfig {
    try {
      const text = fs.readFileSync(this.filePath, 'utf8');
      return sanitize(JSON.parse(text));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private scheduleWrite(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, WRITE_DELAY_MS);
  }

  private write(): void {
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[config] write failed:', err);
    }
  }
}
