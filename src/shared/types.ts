export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SttMode = 'realtime' | 'batch';
export const STT_MODES: readonly SttMode[] = ['realtime', 'batch'];

export type TranscriptionLanguage = 'en' | 'ur' | 'hi' | 'auto';
export interface TranscriptionConfig {
  /**
   * `realtime` streams audio over a websocket to scribe_v2_realtime and shows
   * text while the person is still talking (measured median ~1.0 s from word
   * spoken to word on screen). `batch` POSTs each locally-segmented sentence to
   * scribe_v1 and shows nothing until the sentence ends (2-3 s).
   *
   * Realtime also does its own voice-activity detection, so the local
   * segmenter, merge layer and background rejection do not apply to it.
   */
  sttMode: SttMode;
  /** Ask the service to ignore background audio. Realtime only. */
  filterBackgroundAudio: boolean;
  language: TranscriptionLanguage;
  /** Transcript text size in px. */
  fontSize: number;

  /**
   * Latency tuning. `segmentSilenceMs` is the one that gates end-of-speech
   * latency — it is how long our own segmenter waits before deciding a sentence
   * has ended. The two `vad*` values are faster-whisper's internal Silero pass,
   * which only trims the chunk we already cut.
   */
  segmentSilenceMs: number;
  vadMinSilenceMs: number;
  vadSpeechPadMs: number;
  maxSegmentSeconds: number;

  /**
   * Sentence merge. A finalized segment is held this long in case the speaker
   * was only pausing; a fragment that arrives inside the window and has no
   * terminal punctuation is joined and re-transcribed from the combined audio.
   * 0 disables merging.
   */
  mergeWindowMs: number;
  mergeMaxSeconds: number;
  /**
   * Silence below which a following utterance is treated as the same sentence.
   * Punctuation cannot be used for this: Whisper full-stops nearly every
   * segment, including ones cut mid-sentence.
   */
  mergeGapMs: number;

  /**
   * Domain vocabulary, sent to the API as `keyterms`. Stops domain words
   * arriving as acoustic lookalikes ("scalable application" -> "SK label").
   * Add your own project and service names.
   */
  vocabulary: string;

  /**
   * ElevenLabs key. Stored in plain text in config.json, like the auto-answer
   * key. `ELEVENLABS_API_KEY` in the environment takes precedence and keeps the
   * key off disk entirely.
   */
  apiKey: string;
}

export type LLMProviderId = 'anthropic' | 'openai_compatible';

/**
 * Auto-answer settings.
 *
 * `apiKey` is the one secret this app stores, and config.json is plain text in
 * %APPDATA%. Set the OVERLAY_LLM_API_KEY environment variable instead to keep it
 * off disk entirely — it takes precedence over this field. See PROVIDERS.md.
 */
export interface LookupConfig {
  /** Auto-answer from the transcript. Default OFF. */
  autoAnswer: boolean;
  provider: LLMProviderId;
  /** Used by openai_compatible only; ignored by anthropic. */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Bullet range handed to the model, e.g. "10-20". */
  bulletCount: string;
  maxTokens: number;
  timeoutMs: number;
  /** Hard limits. Over them, calls are skipped, never queued. */
  callsPerHour: number;
  minSpacingMs: number;
  /** How long the pause hotkey silences auto-answer. */
  pauseMinutes: number;
  /** Seconds before an answer entry fades, unless hovered. */
  fadeSeconds: number;
  /** How many answers stay stacked in the panel. */
  maxEntries: number;
}

/**
 * Note there is no persisted "transcription was running" flag, deliberately:
 * the app never starts capturing audio on launch without an explicit action.
 */
/**
 * Bumped when a default changes in a way that must reach existing installs.
 * Sanitizing preserves whatever is already stored, so without this a shipped
 * default change is invisible to anyone who has run the app before.
 */
export const CONFIG_SCHEMA_VERSION = 4;

export interface AppConfig {
  /** Schema version, for one-time migrations of changed defaults. */
  schemaVersion: number;
  /** Last known overlay window rectangle. Null until the window has been placed once. */
  bounds: Bounds | null;
  /** Whether the overlay was visible when the app last exited. */
  visible: boolean;
  /** Window opacity, 0.3 - 1.0. */
  opacity: number;
  /** Electron accelerator string for the show/hide global hotkey. */
  hotkey: string;
  /** Electron accelerator string for the start/stop transcription hotkey. */
  hotkeyTranscribe: string;
  /** Electron accelerator string for the quit hotkey. */
  hotkeyQuit: string;
  /** Electron accelerator string for the manual lookup hotkey. */
  hotkeyLookup: string;
  /** Electron accelerator string for the pause-auto-answer hotkey. */
  hotkeyPause: string;
  /** Keep the overlay above other windows. */
  alwaysOnTop: boolean;
  transcription: TranscriptionConfig;
  lookup: LookupConfig;
}

/** A config update; `transcription` may be partial and is merged, not replaced. */
export type ConfigPatch = Partial<Omit<AppConfig, 'transcription' | 'lookup'>> & {
  transcription?: Partial<TranscriptionConfig>;
  lookup?: Partial<LookupConfig>;
};

export const TRANSCRIPTION_LANGUAGES: readonly TranscriptionLanguage[] = ['en', 'ur', 'hi', 'auto'];

/** Seed domain vocabulary; editable in settings. */
export const DEFAULT_VOCABULARY =
  'Azure, Kubernetes, Docker, API, endpoint, latency, scalable, scalability, ' +
  'microservices, deployment, pipeline, repository, database, authentication, ' +
  'middleware, throughput, caching, load balancer.';

export const MIN_TRANSCRIPT_FONT = 10;
export const MAX_TRANSCRIPT_FONT = 20;

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  bounds: null,
  visible: true,
  opacity: 1,
  hotkey: 'Control+Shift+Space',
  hotkeyTranscribe: 'Control+Shift+T',
  hotkeyQuit: 'Control+Shift+Q',
  hotkeyLookup: 'Control+Shift+A',
  hotkeyPause: 'Control+Shift+P',
  alwaysOnTop: true,
  transcription: {
    sttMode: 'realtime',
    filterBackgroundAudio: true,
    language: 'en',
    fontSize: 12,
    segmentSilenceMs: 700,
    vadMinSilenceMs: 700,
    vadSpeechPadMs: 100,
    maxSegmentSeconds: 12,
    mergeWindowMs: 900,
    mergeMaxSeconds: 12,
    mergeGapMs: 1500,
    vocabulary: DEFAULT_VOCABULARY,
    apiKey: '',
  },
  lookup: {
    autoAnswer: false,
    provider: 'anthropic',
    baseUrl: '',
    model: 'claude-haiku-4-5-20251001',
    apiKey: '',
    bulletCount: '10-20',
    maxTokens: 1024,
    timeoutMs: 10000,
    callsPerHour: 20,
    minSpacingMs: 8000,
    pauseMinutes: 5,
    fadeSeconds: 45,
    maxEntries: 5,
  },
};

export const LLM_PROVIDERS: readonly LLMProviderId[] = ['anthropic', 'openai_compatible'];


export const TUNING_LIMITS = {
  segmentSilenceMs: { min: 150, max: 1500 },
  vadMinSilenceMs: { min: 100, max: 1500 },
  vadSpeechPadMs: { min: 0, max: 500 },
  maxSegmentSeconds: { min: 2, max: 60 },
  mergeWindowMs: { min: 0, max: 5000 },
  mergeMaxSeconds: { min: 2, max: 60 },
  mergeGapMs: { min: 0, max: 5000 },
} as const;

export const MIN_OPACITY = 0.3;
export const MAX_OPACITY = 1;
export const MIN_WIDTH = 250;
export const MIN_HEIGHT = 200;

/** Minimum Windows 10 build that implements WDA_EXCLUDEFROMCAPTURE. */
export const MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE = 19041;

export interface ProtectionStatus {
  /** True when the OS build supports WDA_EXCLUDEFROMCAPTURE. */
  supported: boolean;
  /** True when the window currently reports affinity == WDA_EXCLUDEFROMCAPTURE. */
  applied: boolean;
  /** Raw value read back from GetWindowDisplayAffinity, or null if it could not be read. */
  affinity: number | null;
  /** Human-readable name of the affinity value. */
  affinityName: string;
  /** Windows build number, e.g. 26200. */
  buildNumber: number;
  /** How the flag was set on this window. */
  method: 'native-ffi' | 'electron-only' | 'none';
  /** Short explanation suitable for display in the settings window. */
  message: string;
}

export interface AppPaths {
  config: string;
  userData: string;
}
