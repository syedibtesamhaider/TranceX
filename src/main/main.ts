/**
 * Application entry point: wires the overlay window, the transcription sidecar,
 * the global hotkeys and the settings window together.
 *
 * There is no system tray icon by design — the app leaves no trace in the
 * notification area. Settings and Quit live on the overlay's own right-click
 * menu (drawn in HTML inside the window, so it inherits capture exclusion; a
 * native Menu.popup() is a separate HWND and WOULD show up in a screen share),
 * plus a global quit hotkey.
 *
 * Deliberately offline: no network calls, no telemetry, no auto-update.
 */
import { app, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { ConfigStore } from './config-store';
import { HotkeyManager } from './hotkey';
import { OverlayWindow } from './overlay/overlay-window';
import { SettingsWindow } from './overlay/settings-window';
import {
  isCaptureExclusionSupported,
  windowsBuildNumber,
} from './overlay/capture-protection';
import { TranscriptionService } from './transcription/transcription-service';
import { LookupService } from './llm/lookup-service';
import { CH } from '../shared/channels';
import {
  DEFAULT_CONFIG,
  MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE,
  type AppConfig,
  type AppPaths,
  type ConfigPatch,
} from '../shared/types';

// Single instance: a second launch just reveals the existing overlay.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Pin userData explicitly so dev runs (package name) and the packaged build
// (product name) share one folder: %APPDATA%\PrivateOverlay.
app.setName('PrivateOverlay');
app.setPath('userData', path.join(app.getPath('appData'), 'PrivateOverlay'));
app.setAppUserModelId('local.private.overlay');
// Transparent + always-on-top windows behave more predictably with the
// compositor's background throttling disabled.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let config: ConfigStore;
let overlay: OverlayWindow;
let settings: SettingsWindow;
let hotkeys: HotkeyManager;
let transcription: TranscriptionService;
let lookup: LookupService;
/** Most recent finalized transcript line, for the manual lookup hotkey. */
let lastFinalLine = '';
let quitting = false;

/** Hotkeys that failed to register, reported in-app rather than in a dialog. */
const hotkeyFailures: string[] = [];

function paths(): AppPaths {
  return {
    config: config.path,
    userData: app.getPath('userData'),
  };
}

/**
 * The API key never leaves the main process.
 *
 * The renderer is sandboxed with a `default-src 'none'` CSP and could not
 * exfiltrate it, but there is no reason for it to hold the secret at all: it is
 * written through a dedicated channel and read back only as a boolean. Every
 * config that crosses the IPC boundary goes through here.
 */
function redact(config: AppConfig): AppConfig {
  return {
    ...config,
    lookup: { ...config.lookup, apiKey: '' },
    transcription: { ...config.transcription, apiKey: '' },
  };
}

function broadcastConfig(next: AppConfig): void {
  const safe = redact(next);
  overlay.send(CH.configChanged, safe);
  settings.send(CH.configChanged, safe);
}

/**
 * Hard requirement check. WDA_EXCLUDEFROMCAPTURE landed in Windows 10 2004
 * (build 19041). On anything older the overlay is fully visible to capture, so
 * the user is told explicitly instead of the app failing silently.
 */
function warnIfUnsupported(): void {
  if (process.platform !== 'win32') {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Capture exclusion unavailable',
      message: 'This app only hides its window from screen capture on Windows.',
      detail:
        'SetWindowDisplayAffinity is a Win32 API. On this platform the overlay WILL be visible in screen shares, recordings and screenshots.',
      buttons: ['Continue anyway'],
      noLink: true,
    });
    return;
  }

  if (isCaptureExclusionSupported()) return;

  dialog.showMessageBoxSync({
    type: 'warning',
    title: 'This Windows build cannot hide the overlay from capture',
    message: `Windows build ${windowsBuildNumber()} does not support WDA_EXCLUDEFROMCAPTURE.`,
    detail:
      `Excluding a window from screen capture requires Windows 10 build ${MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE} (version 2004) or newer.\n\n` +
      'The overlay will still work, but it WILL BE VISIBLE in Teams, Zoom, OBS, the Snipping Tool and any other capture software. ' +
      'Do not rely on it being hidden.',
    buttons: ['Continue anyway'],
    noLink: true,
  });
}

/**
 * Registers a hotkey and reports failure *in the app*, never in a modal dialog.
 *
 * A native message box blocks startup and, more importantly, is a separate
 * top-level window that does not carry WDA_EXCLUDEFROMCAPTURE — it would show up
 * in a screen share, which is exactly what this app exists to avoid.
 */
function applyHotkey(id: string, accelerator: string, handler: () => void, label: string): boolean {
  const ok = hotkeys.set(id, accelerator, handler);
  const note = `Hotkey "${accelerator}" (${label}) is already taken by another app — pick another in Settings.`;
  const index = hotkeyFailures.findIndex((entry) => entry.includes(`(${label})`));
  if (index !== -1) hotkeyFailures.splice(index, 1);
  if (!ok) {
    console.warn(`[hotkey] ${note}`);
    hotkeyFailures.push(note);
    overlay?.send(CH.appNotice, note);
  }
  return ok;
}

function toggleOverlay(): void {
  config.set({ visible: overlay.toggle() });
}

/**
 * The overlay's right-click menu is rendered in HTML by the renderer, not by
 * Electron's Menu API: a native popup is its own top-level window and would not
 * carry WDA_EXCLUDEFROMCAPTURE, so it would appear in a screen share. Main only
 * handles the actions.
 */
function openSettings(): void {
  settings.open();
}

/** Everything the sidecar needs to start: model, language and latency knobs. */
function transcriptionArgs() {
  const t = config.get().transcription;
  return {
    language: t.language,
    tuning: {
      segmentSilenceMs: t.segmentSilenceMs,
      vadMinSilenceMs: t.vadMinSilenceMs,
      vadSpeechPadMs: t.vadSpeechPadMs,
      maxSegmentSeconds: t.maxSegmentSeconds,
      mergeWindowMs: t.mergeWindowMs,
      mergeMaxSeconds: t.mergeMaxSeconds,
      mergeGapMs: t.mergeGapMs,
      vocabulary: t.vocabulary,
      apiKey: t.apiKey,
      sttMode: t.sttMode,
      filterBackgroundAudio: t.filterBackgroundAudio,
    },
  };
}

/** Start/stop transcription. Never auto-started: it always takes an explicit action. */
function toggleTranscription(): void {
  const status = transcription.getStatus();
  const active = status.state !== 'stopped' && status.state !== 'idle' && status.state !== 'error';
  if (active) {
    transcription.stop();
    overlay.send(CH.transcriptionToggled, false);
    return;
  }
  void transcription.start(transcriptionArgs());
  // Open the LLM connection now rather than on the first question, so the first
  // answer does not pay for DNS, TCP and TLS on top of generation.
  void lookup.prewarm();
  overlay.send(CH.transcriptionToggled, true);
}

function registerIpc(): void {
  ipcMain.handle(CH.configGet, () => redact(config.get()));

  ipcMain.handle(CH.configSet, (_event, patch: ConfigPatch) => {
    const previous = config.get();
    const next = config.set(patch);

    if (next.opacity !== previous.opacity) overlay.setOpacity(next.opacity);
    if (next.alwaysOnTop !== previous.alwaysOnTop) overlay.applyAlwaysOnTop(next.alwaysOnTop);
    if (next.hotkey !== previous.hotkey) {
      applyHotkey('overlay', next.hotkey, toggleOverlay, 'show/hide');
    }
    if (next.hotkeyTranscribe !== previous.hotkeyTranscribe) {
      applyHotkey('transcribe', next.hotkeyTranscribe, toggleTranscription, 'transcription');
    }
    if (next.hotkeyQuit !== previous.hotkeyQuit) {
      applyHotkey('quit', next.hotkeyQuit, quit, 'quit');
    }
    if (next.hotkeyLookup !== previous.hotkeyLookup) {
      applyHotkey('lookup', next.hotkeyLookup, () => lookup.manual(lastFinalLine), 'manual lookup');
    }
    if (next.hotkeyPause !== previous.hotkeyPause) {
      applyHotkey('pause', next.hotkeyPause, () => lookup.togglePause(), 'pause auto-answer');
    }
    if (JSON.stringify(next.lookup) !== JSON.stringify(previous.lookup)) {
      lookup.updateConfig(next.lookup);
    }
    if (next.transcription.language !== previous.transcription.language) {
      transcription.setLanguage(next.transcription.language);
    }
    if (
      next.transcription.vadMinSilenceMs !== previous.transcription.vadMinSilenceMs ||
      next.transcription.vadSpeechPadMs !== previous.transcription.vadSpeechPadMs ||
      next.transcription.segmentSilenceMs !== previous.transcription.segmentSilenceMs ||
      next.transcription.maxSegmentSeconds !== previous.transcription.maxSegmentSeconds ||
      next.transcription.mergeWindowMs !== previous.transcription.mergeWindowMs ||
      next.transcription.mergeMaxSeconds !== previous.transcription.mergeMaxSeconds ||
      next.transcription.mergeGapMs !== previous.transcription.mergeGapMs ||
      next.transcription.vocabulary !== previous.transcription.vocabulary ||
      next.transcription.apiKey !== previous.transcription.apiKey ||
      next.transcription.sttMode !== previous.transcription.sttMode ||
      next.transcription.filterBackgroundAudio !== previous.transcription.filterBackgroundAudio
    ) {
      transcription.setTuning(next.transcription);
    }

    broadcastConfig(next);
    return redact(next);
  });

  ipcMain.handle(CH.protectionStatus, () => overlay.status());
  ipcMain.handle(CH.protectionReapply, () => {
    const status = overlay.reapplyProtection();
    return status;
  });

  ipcMain.on(CH.overlayHide, () => {
    overlay.hide();
    config.set({ visible: false });
  });
  ipcMain.on(CH.overlayToggle, () => {
    config.set({ visible: overlay.toggle() });
  });
  ipcMain.on(CH.settingsOpen, () => openSettings());
  ipcMain.on(CH.settingsClose, () => settings.close());

  // Actions from the overlay's HTML right-click menu.
  ipcMain.on(CH.overlayContextAction, (_event, action: 'settings' | 'quit') => {
    if (action === 'settings') openSettings();
    else if (action === 'quit') quit();
  });

  // --- transcription -------------------------------------------------------
  ipcMain.handle(CH.transcriptionStatus, () => transcription.getStatus());
  ipcMain.on(CH.transcriptionStart, () => {
    void transcription.start(transcriptionArgs());
  });
  ipcMain.on(CH.transcriptionStop, () => transcription.stop());
  ipcMain.on(CH.transcriptionRestart, () => {
    void transcription.restart(transcriptionArgs());
  });

  // --- auto-answer ---------------------------------------------------------
  ipcMain.handle(CH.lookupStatus, () => lookup.status());
  ipcMain.handle(CH.lookupTest, () => lookup.testConnection());
  ipcMain.on(CH.lookupManual, (_event, text?: string) => {
    lookup.manual(typeof text === 'string' && text.trim() ? text : lastFinalLine);
  });
  ipcMain.on(CH.lookupTogglePause, () => lookup.togglePause());
  // Write-only path for the secret; it is never read back to the renderer.
  // Write-only path for the transcription key, mirroring the auto-answer one.
  ipcMain.handle(CH.sttSetKey, (_event, key: string) => {
    const next = config.set({
      transcription: { apiKey: typeof key === 'string' ? key : '' },
    });
    transcription.setTuning(transcriptionArgs().tuning);
    broadcastConfig(next);
    return transcription.getStatus();
  });

  ipcMain.handle(CH.lookupSetKey, (_event, key: string) => {
    const next = config.set({ lookup: { apiKey: typeof key === 'string' ? key : '' } });
    lookup.updateConfig(next.lookup);
    return lookup.status();
  });

  // The only way transcript text leaves the app, and only on an explicit press.
  ipcMain.on(CH.clipboardWrite, (_event, text: string) => {
    if (typeof text === 'string' && text.length > 0) clipboard.writeText(text);
  });

  ipcMain.handle(CH.hotkeyTest, (_event, accelerator: string) => hotkeys.test(accelerator));
  ipcMain.handle(CH.hotkeyFailures, () => [...hotkeyFailures]);
  ipcMain.handle(CH.pathsGet, () => paths());
  ipcMain.on(CH.pathsReveal, () => {
    if (path.isAbsolute(config.path)) shell.showItemInFolder(config.path);
  });
  ipcMain.on(CH.appQuit, () => quit());
}

function quit(): void {
  quitting = true;
  app.quit();
}

app.on('second-instance', () => {
  overlay.show();
  config.set({ visible: true });
});

// Registering a listener suppresses Electron's default "quit when the last
// window closes" behaviour: hiding the overlay must not end the process.
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.whenReady().then(() => {
  config = new ConfigStore();

  warnIfUnsupported();

  const initial = config.get();

  overlay = new OverlayWindow();
  settings = new SettingsWindow();
  hotkeys = new HotkeyManager();
  transcription = new TranscriptionService();
  lookup = new LookupService(initial.lookup);

  overlay.create(initial, (bounds) => config.set({ bounds }));

  // Forward sidecar output to the UI. Nothing is retained in the main process.
  transcription.on('status', (status) => {
    overlay.send(CH.transcriptionStatusChanged, status);
    settings.send(CH.transcriptionStatusChanged, status);
  });
  transcription.on('transcript', (event) => {
    overlay.send(CH.transcriptionEvent, event);

    // Feed the auto-answer trigger path. This is fire-and-forget: the lookup
    // runs on its own async path in this process and cannot block the sidecar.
    //
    // `final` is the reliable trigger, but on the realtime path it only arrives
    // once the speaker pauses long enough for the service to commit the
    // sentence. Interims are forwarded too so a question asked inside a
    // continuous stretch of speech is still answered; LookupService fires one
    // only after it has stopped changing, and de-duplicates against the commit
    // that follows.
    const id = Number(event.id);
    if (event.type === 'interim' && typeof event.text === 'string') {
      lookup.noteInterim(id, event.text);
    }
    if (event.type === 'final' && typeof event.text === 'string') {
      lastFinalLine = event.text;
      lookup.onFinal(id, event.text);
    }
  });

  lookup.on('started', (event) => overlay.send(CH.lookupStarted, event));
  lookup.on('chunk', (event) => overlay.send(CH.lookupChunk, event));
  lookup.on('done', (event) => overlay.send(CH.lookupDone, event));
  lookup.on('error', (event) => overlay.send(CH.lookupError, event));
  lookup.on('status', (status) => {
    overlay.send(CH.lookupStatusChanged, status);
    settings.send(CH.lookupStatusChanged, status);
  });
  transcription.on('notice', (message: string) => {
    if (message) overlay.send(CH.appNotice, message);
  });

  registerIpc();
  applyHotkey('overlay', initial.hotkey || DEFAULT_CONFIG.hotkey, toggleOverlay, 'show/hide');
  applyHotkey(
    'transcribe',
    initial.hotkeyTranscribe || DEFAULT_CONFIG.hotkeyTranscribe,
    toggleTranscription,
    'transcription',
  );
  applyHotkey('quit', initial.hotkeyQuit || DEFAULT_CONFIG.hotkeyQuit, quit, 'quit');
  applyHotkey(
    'lookup',
    initial.hotkeyLookup || DEFAULT_CONFIG.hotkeyLookup,
    () => lookup.manual(lastFinalLine),
    'manual lookup',
  );
  applyHotkey(
    'pause',
    initial.hotkeyPause || DEFAULT_CONFIG.hotkeyPause,
    () => lookup.togglePause(),
    'pause auto-answer',
  );

  const win = overlay.browserWindow;
  win?.once('ready-to-show', () => {
    if (initial.visible) overlay.show();

    const status = overlay.status();
    console.log(
      `[protection] ${status?.applied ? 'ON' : 'OFF'} — ${status?.affinityName} via ${status?.method} — ${status?.message}`,
    );

    // `--selftest` prints the verified protection state as JSON and exits.
    // Used by VERIFY.md as the automated half of the capture-exclusion check.
    if (process.argv.includes('--selftest')) {
      const emitReport = (extra: Record<string, unknown> = {}) => {
        const report = {
          ...status,
          hiddenFromAltTab: overlay.isHiddenFromAltTab(),
          hotkey: hotkeys.current('overlay'),
          hotkeyTranscribe: hotkeys.current('transcribe'),
          hotkeyQuit: hotkeys.current('quit'),
          hotkeyLookup: hotkeys.current('lookup'),
          hotkeyPause: hotkeys.current('pause'),
          autoAnswer: config.get().lookup.autoAnswer,
          lookupProvider: lookup.status().provider,
          lookupHasApiKey: lookup.status().hasApiKey,
          tray: false, // no notification-area icon, by design
          skipTaskbar: true,
          packaged: app.isPackaged,
          configFile: config.path,
          hotkeyFailures: [...hotkeyFailures],
          ...extra,
        };
        console.log(`SELFTEST ${JSON.stringify(report)}`);
        // A packaged Windows GUI binary has no stdout, so also drop the report on
        // disk — this is how the portable .exe gets verified. See VERIFY.md.
        const reportPath = path.join(app.getPath('temp'), 'private-overlay-selftest.json');
        try {
          writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
          console.log(`SELFTEST report written to ${reportPath}`);
        } catch (err) {
          console.error('[selftest] could not write report:', err);
        }
        setTimeout(() => quit(), 1500);
      };

      // `--with-sidecar` additionally boots the Python sidecar and records its
      // pid, so the shutdown path can be checked for orphans after the app exits.
      if (process.argv.includes('--with-sidecar')) {
        void transcription.start(transcriptionArgs());
        setTimeout(() => {
          const ts = transcription.getStatus();
          emitReport({
            sidecarPid: transcription.sidecarPid,
            sidecarAlive: ts.sidecarAlive,
            sidecarKind: ts.sidecarKind,
            transcriptionState: ts.state,
            device: ts.device,
            computeType: ts.computeType,
          });
        }, 20000);
      } else {
        emitReport();
      }
    }
  });
});

app.on('before-quit', () => {
  quitting = true;
  overlay?.prepareForQuit();
  hotkeys?.disposeAll();
  config?.flush();
  // Privacy: the transcript only ever lived in renderer memory; drop it before
  // the window is torn down so it cannot survive into a reload.
  overlay?.send(CH.transcriptionClear, null);
  overlay?.send(CH.lookupClear, null);
  lookup?.dispose();
  lastFinalLine = '';
  void transcription?.shutdown();
});

// Last line of defence: `will-quit` runs after `before-quit` and cannot await,
// so kill the sidecar tree synchronously rather than risk an orphan holding the
// audio device.
app.on('will-quit', () => {
  transcription?.shutdownSync();
});
