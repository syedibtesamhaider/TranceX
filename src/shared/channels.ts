/** IPC channel names shared by the main process and the preload bridge. */
export const CH = {
  configGet: 'config:get',
  configSet: 'config:set',
  configChanged: 'config:changed',

  protectionStatus: 'protection:status',
  protectionReapply: 'protection:reapply',

  overlayHide: 'overlay:hide',
  overlayToggle: 'overlay:toggle',
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  overlayContextAction: 'overlay:context-action',

  transcriptionStatus: 'transcription:status',
  transcriptionStatusChanged: 'transcription:status-changed',
  transcriptionEvent: 'transcription:event',
  transcriptionStart: 'transcription:start',
  transcriptionStop: 'transcription:stop',
  transcriptionRestart: 'transcription:restart',
  transcriptionToggled: 'transcription:toggled',
  transcriptionClear: 'transcription:clear',
  appNotice: 'app:notice',

  lookupStatus: 'lookup:status',
  lookupStatusChanged: 'lookup:status-changed',
  lookupStarted: 'lookup:started',
  lookupChunk: 'lookup:chunk',
  lookupDone: 'lookup:done',
  lookupError: 'lookup:error',
  lookupClear: 'lookup:clear',
  lookupManual: 'lookup:manual',
  lookupTogglePause: 'lookup:toggle-pause',
  lookupTest: 'lookup:test',
  lookupSetKey: 'lookup:set-key',
  sttSetKey: 'stt:set-key',

  clipboardWrite: 'clipboard:write',

  hotkeyTest: 'hotkey:test',
  hotkeyFailures: 'hotkey:failures',
  pathsGet: 'paths:get',
  pathsReveal: 'paths:reveal',
  appQuit: 'app:quit',
} as const;
