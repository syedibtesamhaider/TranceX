/**
 * Renderer-side view of the preload bridge (see src/preload/preload.ts).
 * Declared locally so the renderer tsconfig stays rooted in src/renderer.
 */
export {};

declare global {
  type LLMProviderId = 'anthropic' | 'openai_compatible';

  interface LookupConfig {
    autoAnswer: boolean;
    provider: LLMProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
    bulletCount: string;
    maxTokens: number;
    timeoutMs: number;
    callsPerHour: number;
    minSpacingMs: number;
    pauseMinutes: number;
    fadeSeconds: number;
    maxEntries: number;
  }

  interface RateLimitState {
    remaining: number;
    limit: number;
    spacingWaitMs: number;
    windowResetMs: number;
  }

  interface LookupStatus {
    enabled: boolean;
    hasApiKey: boolean;
    paused: boolean;
    pausedForMs: number;
    provider: string;
    rate: RateLimitState;
  }

  interface LookupStartedEvent {
    id: string;
    question: string;
    source: 'auto' | 'manual';
    at: number;
    provider: string;
  }

  interface LookupChunkEvent {
    id: string;
    text: string;
    firstTokenMs?: number;
  }

  interface LookupDoneEvent {
    id: string;
    totalMs: number;
    cancelled?: boolean;
  }

  interface LookupErrorEvent {
    id: string;
    message: string;
  }

  type TranscriptionLanguage = 'en' | 'ur' | 'hi' | 'auto';
  type SttMode = 'realtime' | 'batch';

  interface TranscriptionConfig {
    sttMode: SttMode;
    filterBackgroundAudio: boolean;
    language: TranscriptionLanguage;
    fontSize: number;
    segmentSilenceMs: number;
    vadMinSilenceMs: number;
    vadSpeechPadMs: number;
    maxSegmentSeconds: number;
    mergeWindowMs: number;
    mergeMaxSeconds: number;
    mergeGapMs: number;
    vocabulary: string;
    apiKey: string;
  }

  interface AppConfig {
    schemaVersion: number;
    bounds: { x: number; y: number; width: number; height: number } | null;
    visible: boolean;
    opacity: number;
    hotkey: string;
    hotkeyTranscribe: string;
    hotkeyQuit: string;
    hotkeyLookup: string;
    hotkeyPause: string;
    alwaysOnTop: boolean;
    transcription: TranscriptionConfig;
    lookup: LookupConfig;
  }

  type ConfigPatch = Partial<Omit<AppConfig, 'transcription' | 'lookup'>> & {
    transcription?: Partial<TranscriptionConfig>;
    lookup?: Partial<LookupConfig>;
  };

  type TranscriptionState =
    | 'stopped'
    | 'starting'
    | 'idle'
    | 'listening'
    | 'no_audio'
    | 'model_loading'
    | 'error';

  interface TranscriptionStatus {
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

  interface TranscriptEvent {
    type: 'interim' | 'final' | 'drop';
    id: number;
    text?: string;
    startedAt?: number;
    endedAt?: number;
    language?: string;
    truncated?: boolean;
    fragments?: number;
    mergeReason?: string;
    mergeMs?: number;
    /** Latency breakdown on `final`, in ms. */
    silenceMs?: number;
    queueMs?: number;
    inferenceMs?: number;
    latencyMs?: number;
    rtf?: number;
    audioSeconds?: number;
  }

  interface ProtectionStatus {
    supported: boolean;
    applied: boolean;
    affinity: number | null;
    affinityName: string;
    buildNumber: number;
    method: 'native-ffi' | 'electron-only' | 'none';
    message: string;
  }

  interface AppPaths {
    config: string;
    userData: string;
  }

  interface OverlayApi {
    getConfig(): Promise<AppConfig>;
    setConfig(patch: ConfigPatch): Promise<AppConfig>;
    onConfigChanged(cb: (config: AppConfig) => void): void;

    getTranscriptionStatus(): Promise<TranscriptionStatus>;
    startTranscription(): void;
    stopTranscription(): void;
    restartTranscription(): void;
    onTranscriptionStatus(cb: (status: TranscriptionStatus) => void): void;
    onTranscriptionEvent(cb: (event: TranscriptEvent) => void): void;
    onTranscriptionToggled(cb: (running: boolean) => void): void;
    onNotice(cb: (message: string) => void): void;
    onTranscriptClear(cb: () => void): void;
    copyToClipboard(text: string): void;

    getLookupStatus(): Promise<LookupStatus>;
    testLookupConnection(): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
    setLookupApiKey(key: string): Promise<LookupStatus>;
    setSttApiKey(key: string): Promise<TranscriptionStatus>;
    manualLookup(text?: string): void;
    toggleLookupPause(): void;
    onLookupStatus(cb: (status: LookupStatus) => void): void;
    onLookupStarted(cb: (event: LookupStartedEvent) => void): void;
    onLookupChunk(cb: (event: LookupChunkEvent) => void): void;
    onLookupDone(cb: (event: LookupDoneEvent) => void): void;
    onLookupError(cb: (event: LookupErrorEvent) => void): void;
    onLookupClear(cb: () => void): void;

    getProtectionStatus(): Promise<ProtectionStatus | null>;
    reapplyProtection(): Promise<ProtectionStatus | null>;

    hideOverlay(): void;
    openSettings(): void;
    closeSettings(): void;
    contextAction(action: 'settings' | 'quit'): void;

    testHotkey(accelerator: string): Promise<boolean>;
    getHotkeyFailures(): Promise<string[]>;
    getPaths(): Promise<AppPaths>;
    revealConfig(): void;
    quit(): void;
  }

  interface Window {
    overlayApi: OverlayApi;
  }
}
