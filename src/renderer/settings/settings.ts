/** Settings renderer: opacity, hotkey, always-on-top, protection diagnostics. */
const api = window.overlayApi;

const DEFAULT_HOTKEY = 'Control+Shift+Space';
const DEFAULT_HOTKEY_TRANSCRIBE = 'Control+Shift+T';
const DEFAULT_HOTKEY_QUIT = 'Control+Shift+Q';
const DEFAULT_HOTKEY_LOOKUP = 'Control+Shift+A';
const DEFAULT_HOTKEY_PAUSE = 'Control+Shift+P';

const TS_STATE_LABELS: Record<string, string> = {
  stopped: 'stopped',
  starting: 'starting…',
  idle: 'idle',
  listening: 'listening',
  no_audio: 'no audio detected',
  model_loading: 'loading model…',
  error: 'error',
};

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dot = el<HTMLSpanElement>('dot');
const headline = el<HTMLSpanElement>('protectionHeadline');
const detail = el<HTMLParagraphElement>('protectionDetail');
const affinity = el<HTMLElement>('affinity');
const build = el<HTMLElement>('build');
const method = el<HTMLElement>('method');
const opacity = el<HTMLInputElement>('opacity');
const opacityValue = el<HTMLSpanElement>('opacityValue');
const hotkeyButton = el<HTMLButtonElement>('hotkey');
const hotkeyNote = el<HTMLParagraphElement>('hotkeyNote');
const alwaysOnTop = el<HTMLInputElement>('alwaysOnTop');
const configPath = el<HTMLDivElement>('configPath');
const hotkeyFailures = el<HTMLParagraphElement>('hotkeyFailures');

const hotkeyTranscribeButton = el<HTMLButtonElement>('hotkeyT');
const hotkeyQuitButton = el<HTMLButtonElement>('hotkeyQ');
const tsSegmentSilence = el<HTMLInputElement>('tsSegmentSilence');
const tsVadSilence = el<HTMLInputElement>('tsVadSilence');
const tsVadPad = el<HTMLInputElement>('tsVadPad');
const tsMaxSegment = el<HTMLInputElement>('tsMaxSegment');
const tsMergeWindow = el<HTMLInputElement>('tsMergeWindow');
const tsMergeMax = el<HTMLInputElement>('tsMergeMax');
const tsMergeGap = el<HTMLInputElement>('tsMergeGap');
const tsInitialPrompt = el<HTMLTextAreaElement>('tsInitialPrompt');
const tsApiKey = el<HTMLInputElement>('tsApiKey');
const tsMode = el<HTMLSelectElement>('tsMode');
const tsFilterBg = el<HTMLInputElement>('tsFilterBg');
const tsModeNote = el<HTMLParagraphElement>('tsModeNote');

const MODE_NOTES: Record<string, string> = {
  realtime:
    'Streams audio over a websocket. Text appears while the person is still talking — measured median ~1.0 s from a word being spoken to it showing up. The service does its own voice-activity detection, so the segmentation settings below do not apply.',
  batch:
    'Sends each locally-segmented sentence as a separate request. Nothing appears until the sentence ends — measured 2-3 s. Uses the segmentation settings below.',
};
const tsKeyResult = el<HTMLParagraphElement>('tsKeyResult');
const tsLatency = el<HTMLParagraphElement>('tsLatency');
const tsDot = el<HTMLSpanElement>('tsDot');
const tsState = el<HTMLSpanElement>('tsState');
const tsDetail = el<HTMLParagraphElement>('tsDetail');
const tsEngine = el<HTMLElement>('tsEngine');
const tsAudio = el<HTMLElement>('tsAudio');
const tsKind = el<HTMLElement>('tsKind');
const tsLanguage = el<HTMLSelectElement>('tsLanguage');

const hotkeyLookupButton = el<HTMLButtonElement>('hotkeyL');
const hotkeyPauseButton = el<HTMLButtonElement>('hotkeyP');
const luAuto = el<HTMLInputElement>('luAuto');
const luStatus = el<HTMLParagraphElement>('luStatus');
const luProvider = el<HTMLSelectElement>('luProvider');
const luModel = el<HTMLInputElement>('luModel');
const luBaseUrl = el<HTMLInputElement>('luBaseUrl');
const luBaseUrlRow = el<HTMLDivElement>('luBaseUrlRow');
const luApiKey = el<HTMLInputElement>('luApiKey');
const luTestResult = el<HTMLParagraphElement>('luTestResult');
const luBullets = el<HTMLInputElement>('luBullets');
const luPerHour = el<HTMLInputElement>('luPerHour');
const luSpacing = el<HTMLInputElement>('luSpacing');

type HotkeyTarget = 'overlay' | 'transcribe' | 'quit' | 'lookup' | 'pause';
let recordingTarget: HotkeyTarget | null = null;

function buttonFor(target: HotkeyTarget): HTMLButtonElement {
  if (target === 'overlay') return hotkeyButton;
  if (target === 'transcribe') return hotkeyTranscribeButton;
  if (target === 'lookup') return hotkeyLookupButton;
  if (target === 'pause') return hotkeyPauseButton;
  return hotkeyQuitButton;
}

function acceleratorOf(config: AppConfig, target: HotkeyTarget): string {
  if (target === 'overlay') return config.hotkey;
  if (target === 'transcribe') return config.hotkeyTranscribe;
  if (target === 'lookup') return config.hotkeyLookup;
  if (target === 'pause') return config.hotkeyPause;
  return config.hotkeyQuit;
}

function patchFor(target: HotkeyTarget, accelerator: string): ConfigPatch {
  if (target === 'overlay') return { hotkey: accelerator };
  if (target === 'transcribe') return { hotkeyTranscribe: accelerator };
  if (target === 'lookup') return { hotkeyLookup: accelerator };
  if (target === 'pause') return { hotkeyPause: accelerator };
  return { hotkeyQuit: accelerator };
}

function renderProtection(status: ProtectionStatus | null): void {
  dot.classList.remove('ok', 'warn');
  if (!status) {
    headline.textContent = 'unknown';
    return;
  }
  dot.classList.add(status.applied ? 'ok' : 'warn');
  headline.textContent = status.applied
    ? 'Hidden from screen capture'
    : 'NOT hidden — visible in capture';
  detail.textContent = status.message;
  affinity.textContent = status.affinityName;
  build.textContent = status.buildNumber ? String(status.buildNumber) : '—';
  method.textContent =
    status.method === 'native-ffi'
      ? 'SetWindowDisplayAffinity (direct Win32 call)'
      : status.method === 'electron-only'
        ? 'Electron setContentProtection only'
        : 'not applied';
}

function renderConfig(config: AppConfig): void {
  const percent = Math.round(config.opacity * 100);
  opacity.value = String(percent);
  opacityValue.textContent = `${percent}%`;
  alwaysOnTop.checked = config.alwaysOnTop;
  if (recordingTarget !== 'overlay') hotkeyButton.textContent = config.hotkey;
  if (recordingTarget !== 'transcribe') {
    hotkeyTranscribeButton.textContent = config.hotkeyTranscribe;
  }
  if (recordingTarget !== 'quit') hotkeyQuitButton.textContent = config.hotkeyQuit;
  if (recordingTarget !== 'lookup') hotkeyLookupButton.textContent = config.hotkeyLookup;
  if (recordingTarget !== 'pause') hotkeyPauseButton.textContent = config.hotkeyPause;

  const l = config.lookup;
  luAuto.checked = l.autoAnswer;
  luProvider.value = l.provider;
  if (document.activeElement !== luModel) luModel.value = l.model;
  if (document.activeElement !== luBaseUrl) luBaseUrl.value = l.baseUrl;
  if (document.activeElement !== luBullets) luBullets.value = l.bulletCount;
  if (document.activeElement !== luPerHour) luPerHour.value = String(l.callsPerHour);
  if (document.activeElement !== luSpacing) luSpacing.value = String(l.minSpacingMs);
  // Base URL is meaningless for the Anthropic adapter.
  luBaseUrlRow.hidden = l.provider !== 'openai_compatible';

  const t = config.transcription;
  tsMode.value = t.sttMode;
  tsFilterBg.checked = t.filterBackgroundAudio;
  tsFilterBg.disabled = t.sttMode !== 'realtime';
  tsModeNote.textContent = MODE_NOTES[t.sttMode] ?? '';
  tsLanguage.value = t.language;
  // Don't fight the user mid-edit.
  if (document.activeElement !== tsSegmentSilence) {
    tsSegmentSilence.value = String(t.segmentSilenceMs);
  }
  if (document.activeElement !== tsVadSilence) tsVadSilence.value = String(t.vadMinSilenceMs);
  if (document.activeElement !== tsVadPad) tsVadPad.value = String(t.vadSpeechPadMs);
  if (document.activeElement !== tsMaxSegment) tsMaxSegment.value = String(t.maxSegmentSeconds);
  if (document.activeElement !== tsMergeWindow) tsMergeWindow.value = String(t.mergeWindowMs);
  if (document.activeElement !== tsMergeMax) tsMergeMax.value = String(t.mergeMaxSeconds);
  if (document.activeElement !== tsMergeGap) tsMergeGap.value = String(t.mergeGapMs);
  if (document.activeElement !== tsInitialPrompt) tsInitialPrompt.value = t.vocabulary;
}

function renderTranscription(status: TranscriptionStatus): void {
  tsDot.classList.remove('ok', 'warn');
  if (status.state === 'listening') tsDot.classList.add('ok');
  else if (status.state !== 'stopped' && status.state !== 'idle') tsDot.classList.add('warn');

  tsState.textContent = TS_STATE_LABELS[status.state] ?? status.state;
  tsDetail.textContent = status.detail || '';

  tsEngine.textContent = status.device
    ? `${status.device} / ${status.computeType ?? ''}${status.deviceNote ? ` — ${status.deviceNote}` : ''}`
    : '—';
  tsAudio.textContent = status.audioDevice || '—';
  tsKind.textContent = status.sidecarAlive
    ? `running (${status.sidecarKind ?? 'unknown'})${status.connected ? '' : ', not connected'}`
    : 'not running';
}

/* --- hotkey recording ----------------------------------------------------- */

const CODE_MAP: Record<string, string> = {
  Space: 'Space',
  Escape: 'Escape',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_MAP[code] ?? null;
}

function acceleratorFrom(event: KeyboardEvent): string | null {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join('+');
}

function stopRecording(target: HotkeyTarget, text: string, note: string): void {
  const button = buttonFor(target);
  recordingTarget = null;
  button.classList.remove('recording');
  button.textContent = text;
  hotkeyNote.textContent = note;
}

function beginRecording(target: HotkeyTarget): void {
  if (recordingTarget) stopRecording(recordingTarget, '…', '');
  recordingTarget = target;
  const button = buttonFor(target);
  button.classList.add('recording');
  button.textContent = 'press keys…';
  hotkeyNote.textContent = 'Press a combination, or Esc to cancel.';
}

hotkeyButton.addEventListener('click', () => beginRecording('overlay'));
hotkeyTranscribeButton.addEventListener('click', () => beginRecording('transcribe'));
hotkeyQuitButton.addEventListener('click', () => beginRecording('quit'));
hotkeyLookupButton.addEventListener('click', () => beginRecording('lookup'));
hotkeyPauseButton.addEventListener('click', () => beginRecording('pause'));

document.addEventListener('keydown', async (event) => {
  const target = recordingTarget;
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.code === 'Escape') {
    const current = await api.getConfig();
    stopRecording(target, acceleratorOf(current, target), 'Cancelled.');
    return;
  }

  const accelerator = acceleratorFrom(event);
  if (!accelerator) return; // modifier-only or unmapped key: keep waiting

  const ok = await api.testHotkey(accelerator);
  if (!ok) {
    stopRecording(
      target,
      accelerator,
      `"${accelerator}" is already taken by another app. Try another.`,
    );
    return;
  }
  const next = await api.setConfig(patchFor(target, accelerator));
  stopRecording(target, acceleratorOf(next, target), 'Hotkey updated.');
  await renderHotkeyFailures();
});

el<HTMLButtonElement>('hotkeyReset').addEventListener('click', async () => {
  const next = await api.setConfig({ hotkey: DEFAULT_HOTKEY });
  stopRecording('overlay', next.hotkey, 'Reset to default.');
});

el<HTMLButtonElement>('hotkeyTReset').addEventListener('click', async () => {
  const next = await api.setConfig({ hotkeyTranscribe: DEFAULT_HOTKEY_TRANSCRIBE });
  stopRecording('transcribe', next.hotkeyTranscribe, 'Reset to default.');
});

el<HTMLButtonElement>('hotkeyLReset').addEventListener('click', async () => {
  const next = await api.setConfig({ hotkeyLookup: DEFAULT_HOTKEY_LOOKUP });
  stopRecording('lookup', next.hotkeyLookup, 'Reset to default.');
});

el<HTMLButtonElement>('hotkeyPReset').addEventListener('click', async () => {
  const next = await api.setConfig({ hotkeyPause: DEFAULT_HOTKEY_PAUSE });
  stopRecording('pause', next.hotkeyPause, 'Reset to default.');
});

el<HTMLButtonElement>('hotkeyQReset').addEventListener('click', async () => {
  const next = await api.setConfig({ hotkeyQuit: DEFAULT_HOTKEY_QUIT });
  stopRecording('quit', next.hotkeyQuit, 'Reset to default.');
});

/* --- other controls ------------------------------------------------------- */

opacity.addEventListener('input', () => {
  const percent = Number(opacity.value);
  opacityValue.textContent = `${percent}%`;
  void api.setConfig({ opacity: percent / 100 });
});

alwaysOnTop.addEventListener('change', () => {
  void api.setConfig({ alwaysOnTop: alwaysOnTop.checked });
});

el<HTMLButtonElement>('reapply').addEventListener('click', async () => {
  renderProtection(await api.reapplyProtection());
});

tsMode.addEventListener('change', () => {
  const sttMode = tsMode.value as SttMode;
  tsModeNote.textContent = MODE_NOTES[sttMode] ?? '';
  tsFilterBg.disabled = sttMode !== 'realtime';
  void api.setConfig({ transcription: { sttMode } });
});

tsFilterBg.addEventListener('change', () => {
  void api.setConfig({ transcription: { filterBackgroundAudio: tsFilterBg.checked } });
});

tsLanguage.addEventListener('change', () => {
  void api.setConfig({ transcription: { language: tsLanguage.value as TranscriptionLanguage } });
});

const tuningInputs: Array<[HTMLInputElement, keyof TranscriptionConfig]> = [
  [tsSegmentSilence, 'segmentSilenceMs'],
  [tsVadSilence, 'vadMinSilenceMs'],
  [tsVadPad, 'vadSpeechPadMs'],
  [tsMaxSegment, 'maxSegmentSeconds'],
  [tsMergeWindow, 'mergeWindowMs'],
  [tsMergeMax, 'mergeMaxSeconds'],
  [tsMergeGap, 'mergeGapMs'],
];

// Applies live to the next segment; no model reload.
tsInitialPrompt.addEventListener('change', () => {
  void api.setConfig({ transcription: { vocabulary: tsInitialPrompt.value } });
});

for (const [input, key] of tuningInputs) {
  input.addEventListener('change', () => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    void api.setConfig({ transcription: { [key]: value } as Partial<TranscriptionConfig> });
  });
}

// Live latency readout, averaged over the last few finalized segments.
const recentLatencies: number[] = [];
api.onTranscriptionEvent((event) => {
  if (event.type !== 'final' || typeof event.latencyMs !== 'number') return;
  recentLatencies.push(event.latencyMs);
  if (recentLatencies.length > 8) recentLatencies.shift();
  const mean = Math.round(recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length);
  tsLatency.textContent =
    `Last segment: ${event.latencyMs} ms end-of-speech to text ` +
    `(silence ${event.silenceMs} + queue ${event.queueMs} + inference ${event.inferenceMs}). ` +
    `Average of last ${recentLatencies.length}: ${mean} ms. RTF ${event.rtf ?? '—'}.`;
});

el<HTMLButtonElement>('tsRestart').addEventListener('click', () => api.restartTranscription());

// Write-only: the key goes to the main process and is never read back.
async function saveSttKey(): Promise<void> {
  const key = tsApiKey.value;
  if (!key) return;
  await api.setSttApiKey(key);
  tsApiKey.value = '';
  tsKeyResult.textContent = 'API key saved. Press Restart engine if it was already running.';
  tsKeyResult.classList.remove('warnnote');
}

el<HTMLButtonElement>('tsSaveKey').addEventListener('click', () => void saveSttKey());
tsApiKey.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void saveSttKey();
});

api.onTranscriptionStatus(renderTranscription);

el<HTMLButtonElement>('close').addEventListener('click', () => api.closeSettings());
el<HTMLButtonElement>('quit').addEventListener('click', () => api.quit());
el<HTMLButtonElement>('revealConfig').addEventListener('click', () => api.revealConfig());

api.onConfigChanged(renderConfig);

async function renderHotkeyFailures(): Promise<void> {
  const failures = await api.getHotkeyFailures();
  hotkeyFailures.hidden = failures.length === 0;
  hotkeyFailures.textContent = failures.join('\n');
}

async function init(): Promise<void> {
  renderConfig(await api.getConfig());
  renderProtection(await api.getProtectionStatus());
  renderTranscription(await api.getTranscriptionStatus());
  await renderHotkeyFailures();
  renderLookupStatus(await api.getLookupStatus());
  configPath.textContent = (await api.getPaths()).config;
}

void init();
window.setInterval(async () => {
  if (!recordingTarget) renderProtection(await api.getProtectionStatus());
}, 4000);

/* --- auto-answer ----------------------------------------------------------- */

function renderLookupStatus(status: LookupStatus): void {
  const bits: string[] = [];
  bits.push(status.enabled ? 'on' : 'off');
  bits.push(status.hasApiKey ? 'API key configured' : 'no API key — needs an LLM key, not the speech-to-text one');
  if (status.paused) bits.push(`paused ${Math.ceil(status.pausedForMs / 60000)} min`);
  bits.push(`${status.rate.remaining}/${status.rate.limit} calls left this hour`);
  bits.push(status.provider);
  luStatus.textContent = bits.join(' \u00b7 ');
  luStatus.classList.toggle('warnnote', !status.hasApiKey && status.enabled);
  luApiKey.placeholder = status.hasApiKey ? 'configured (hidden)' : 'not configured';
}

luAuto.addEventListener('change', () => {
  void api.setConfig({ lookup: { autoAnswer: luAuto.checked } });
});

luProvider.addEventListener('change', () => {
  const provider = luProvider.value as LLMProviderId;
  luBaseUrlRow.hidden = provider !== 'openai_compatible';
  void api.setConfig({ lookup: { provider } });
});

const lookupTextInputs: Array<[HTMLInputElement, keyof LookupConfig]> = [
  [luModel, 'model'],
  [luBaseUrl, 'baseUrl'],
  [luBullets, 'bulletCount'],
];
for (const [input, key] of lookupTextInputs) {
  input.addEventListener('change', () => {
    void api.setConfig({ lookup: { [key]: input.value.trim() } as Partial<LookupConfig> });
  });
}

const lookupNumberInputs: Array<[HTMLInputElement, keyof LookupConfig]> = [
  [luPerHour, 'callsPerHour'],
  [luSpacing, 'minSpacingMs'],
];
for (const [input, key] of lookupNumberInputs) {
  input.addEventListener('change', () => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    void api.setConfig({ lookup: { [key]: value } as Partial<LookupConfig> });
  });
}

// The key is write-only: it goes to the main process and is never read back.
async function saveApiKey(): Promise<void> {
  const key = luApiKey.value;
  if (!key) return;
  const status = await api.setLookupApiKey(key);
  luApiKey.value = '';
  renderLookupStatus(status);
  luTestResult.textContent = 'API key saved.';
}

el<HTMLButtonElement>('luSaveKey').addEventListener('click', () => void saveApiKey());
luApiKey.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void saveApiKey();
});

el<HTMLButtonElement>('luTest').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('luTest');
  if (luApiKey.value) await saveApiKey();
  button.disabled = true;
  luTestResult.textContent = 'testing\u2026';
  const result = await api.testLookupConnection();
  button.disabled = false;
  luTestResult.textContent = result.ok
    ? `OK in ${result.latencyMs} ms \u2014 ${result.detail}`
    : `FAILED after ${result.latencyMs} ms \u2014 ${result.detail}`;
  luTestResult.classList.toggle('warnnote', !result.ok);
});

api.onLookupStatus(renderLookupStatus);

export {};
