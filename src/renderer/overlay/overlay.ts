/**
 * Overlay renderer.
 *
 * The window is a live transcript and nothing else. The transcript itself lives
 * in ./transcript-panel.ts; this module owns the window chrome: the capture
 * indicator, the right-click menu, and hide/settings.
 */
import { TranscriptPanel } from './transcript-panel.js';
import { LookupPanel } from './lookup-panel.js';

const api = window.overlayApi;

const statusDot = document.getElementById('status') as HTMLSpanElement;
const ctxMenu = document.getElementById('ctxMenu') as HTMLDivElement;

const transcript = new TranscriptPanel((size) => {
  void api.setConfig({ transcription: { fontSize: size } });
});
const lookup = new LookupPanel();

/* --- right-click menu ------------------------------------------------------
 * Rendered inside the overlay window so it inherits capture exclusion. A native
 * Electron menu is a separate HWND and would be visible in a screen share.
 */
function hideContextMenu(): void {
  ctxMenu.hidden = true;
}

function showContextMenu(x: number, y: number): void {
  ctxMenu.hidden = false;
  // Measure after unhiding, then keep it inside the window.
  const { offsetWidth: width, offsetHeight: height } = ctxMenu;
  const maxX = window.innerWidth - width - 8;
  const maxY = window.innerHeight - height - 8;
  ctxMenu.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
  ctxMenu.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
}

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showContextMenu(event.clientX, event.clientY);
});

ctxMenu.addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLButtonElement>('.ctxitem');
  if (!item) return;
  hideContextMenu();
  api.contextAction(item.dataset.action as 'settings' | 'quit');
});

document.addEventListener('mousedown', (event) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(event.target as Node)) hideContextMenu();
});
window.addEventListener('blur', hideContextMenu);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  // Escape closes the menu first, and only hides the overlay if it was closed.
  if (!ctxMenu.hidden) {
    hideContextMenu();
    return;
  }
  api.hideOverlay();
});

document.getElementById('hide')?.addEventListener('click', () => api.hideOverlay());
document.getElementById('settings')?.addEventListener('click', () => api.openSettings());

api.onConfigChanged((config) => {
  transcript.setFontSize(config.transcription.fontSize);
  lookup.applyConfig(config.lookup);
});

/** A hotkey that failed to register is reported here, not in a modal dialog. */
api.onNotice((message) => transcript.note(message));

async function refreshStatus(): Promise<void> {
  const status = await api.getProtectionStatus();
  statusDot.classList.remove('ok', 'warn');
  if (!status) {
    statusDot.title = 'Capture protection: unknown';
    return;
  }
  statusDot.classList.add(status.applied ? 'ok' : 'warn');
  statusDot.title = status.applied
    ? `Hidden from screen capture — ${status.affinityName}`
    : `NOT hidden from capture — ${status.message}`;
}

async function init(): Promise<void> {
  const config = await api.getConfig();
  transcript.setFontSize(config.transcription.fontSize);
  lookup.applyConfig(config.lookup);
  await refreshStatus();
}

void init();
window.setInterval(() => void refreshStatus(), 5000);

export {};
