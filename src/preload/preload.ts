/**
 * Context-isolated bridge. The renderer gets a narrow, explicit API surface and
 * has no access to Node, the filesystem or Electron internals.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/channels';
import type { AppConfig, AppPaths, ConfigPatch, ProtectionStatus } from '../shared/types';

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(CH.configGet),
  setConfig: (patch: ConfigPatch): Promise<AppConfig> => ipcRenderer.invoke(CH.configSet, patch),
  onConfigChanged: (cb: (config: AppConfig) => void): void => {
    ipcRenderer.on(CH.configChanged, (_event, config: AppConfig) => cb(config));
  },

  getProtectionStatus: (): Promise<ProtectionStatus | null> =>
    ipcRenderer.invoke(CH.protectionStatus),
  reapplyProtection: (): Promise<ProtectionStatus | null> =>
    ipcRenderer.invoke(CH.protectionReapply),

  hideOverlay: (): void => ipcRenderer.send(CH.overlayHide),
  openSettings: (): void => ipcRenderer.send(CH.settingsOpen),
  closeSettings: (): void => ipcRenderer.send(CH.settingsClose),
  contextAction: (action: 'settings' | 'quit'): void =>
    ipcRenderer.send(CH.overlayContextAction, action),

  // --- transcription ---------------------------------------------------------
  getTranscriptionStatus: (): Promise<unknown> => ipcRenderer.invoke(CH.transcriptionStatus),
  startTranscription: (): void => ipcRenderer.send(CH.transcriptionStart),
  stopTranscription: (): void => ipcRenderer.send(CH.transcriptionStop),
  restartTranscription: (): void => ipcRenderer.send(CH.transcriptionRestart),
  onTranscriptionStatus: (cb: (status: unknown) => void): void => {
    ipcRenderer.on(CH.transcriptionStatusChanged, (_event, status) => cb(status));
  },
  onTranscriptionEvent: (cb: (event: unknown) => void): void => {
    ipcRenderer.on(CH.transcriptionEvent, (_event, payload) => cb(payload));
  },
  onTranscriptionToggled: (cb: (running: boolean) => void): void => {
    ipcRenderer.on(CH.transcriptionToggled, (_event, running: boolean) => cb(running));
  },
  /** General in-app notices: device changes, hotkey registration failures. */
  onNotice: (cb: (message: string) => void): void => {
    ipcRenderer.on(CH.appNotice, (_event, message: string) => cb(message));
  },
  onTranscriptClear: (cb: () => void): void => {
    ipcRenderer.on(CH.transcriptionClear, () => cb());
  },

  // --- auto-answer -----------------------------------------------------------
  // The API key never crosses this boundary: requests are made in the main
  // process and only the resulting text chunks are forwarded here.
  getLookupStatus: (): Promise<unknown> => ipcRenderer.invoke(CH.lookupStatus),
  testLookupConnection: (): Promise<unknown> => ipcRenderer.invoke(CH.lookupTest),
  /** Write-only: the key is never sent back to the renderer. */
  setLookupApiKey: (key: string): Promise<unknown> => ipcRenderer.invoke(CH.lookupSetKey, key),
  /** Write-only: the transcription key is never sent back to the renderer. */
  setSttApiKey: (key: string): Promise<unknown> => ipcRenderer.invoke(CH.sttSetKey, key),
  manualLookup: (text?: string): void => ipcRenderer.send(CH.lookupManual, text),
  toggleLookupPause: (): void => ipcRenderer.send(CH.lookupTogglePause),
  onLookupStatus: (cb: (status: unknown) => void): void => {
    ipcRenderer.on(CH.lookupStatusChanged, (_event, status) => cb(status));
  },
  onLookupStarted: (cb: (event: unknown) => void): void => {
    ipcRenderer.on(CH.lookupStarted, (_event, payload) => cb(payload));
  },
  onLookupChunk: (cb: (event: unknown) => void): void => {
    ipcRenderer.on(CH.lookupChunk, (_event, payload) => cb(payload));
  },
  onLookupDone: (cb: (event: unknown) => void): void => {
    ipcRenderer.on(CH.lookupDone, (_event, payload) => cb(payload));
  },
  onLookupError: (cb: (event: unknown) => void): void => {
    ipcRenderer.on(CH.lookupError, (_event, payload) => cb(payload));
  },
  onLookupClear: (cb: () => void): void => {
    ipcRenderer.on(CH.lookupClear, () => cb());
  },

  /** The only route by which transcript text leaves the app. */
  copyToClipboard: (text: string): void => ipcRenderer.send(CH.clipboardWrite, text),

  testHotkey: (accelerator: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.hotkeyTest, accelerator),
  getHotkeyFailures: (): Promise<string[]> => ipcRenderer.invoke(CH.hotkeyFailures),
  getPaths: (): Promise<AppPaths> => ipcRenderer.invoke(CH.pathsGet),
  revealConfig: (): void => ipcRenderer.send(CH.pathsReveal),
  quit: (): void => ipcRenderer.send(CH.appQuit),
};

contextBridge.exposeInMainWorld('overlayApi', api);

export type OverlayApi = typeof api;
