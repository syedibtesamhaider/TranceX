/**
 * The overlay window itself: geometry, visibility, persistence and — most
 * importantly — keeping the capture-exclusion flag applied.
 *
 * See ./capture-protection.ts for what WDA_EXCLUDEFROMCAPTURE does and why the
 * flag is re-applied so aggressively. This module knows nothing about *what* is
 * displayed inside the window; that lives behind the ContentSource interface.
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  type AppConfig,
  type Bounds,
  type ProtectionStatus,
} from '../../shared/types';
import {
  hideFromAltTab,
  isHiddenFromAltTab,
  protectWindow,
  readProtection,
  WDA_EXCLUDEFROMCAPTURE,
} from './capture-protection';

const DEFAULT_SIZE = { width: 380, height: 420 };
const REPROTECT_DEBOUNCE_MS = 200;

export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private reprotectTimer: NodeJS.Timeout | null = null;
  private lastStatus: ProtectionStatus | null = null;
  private saveBounds: (bounds: Bounds) => void = () => {};
  private allowClose = false;

  create(config: AppConfig, onBoundsChanged: (bounds: Bounds) => void): BrowserWindow {
    this.saveBounds = onBoundsChanged;
    const bounds = this.resolveBounds(config.bounds);

    this.win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false, // the shadow is drawn in CSS so it sits inside the transparent margin
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: config.alwaysOnTop,
      show: false,
      paintWhenInitiallyHidden: true,
      title: 'Overlay',
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: process.argv.includes('--dev'),
      },
    });

    this.win.setMenuBarVisibility(false);
    this.applyAlwaysOnTop(config.alwaysOnTop);
    this.win.setOpacity(config.opacity);

    // Apply protection before the window is ever composited on screen.
    this.lastStatus = protectWindow(this.win);
    hideFromAltTab(this.win);

    if (process.argv.includes('--dev')) {
      // Surface renderer console output in the terminal during development.
      this.win.webContents.on(
        'console-message',
        (...args: unknown[]) => console.log('[renderer]', ...args.slice(1, 4)),
      );
    }

    void this.win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'overlay', 'index.html'));

    // The display affinity is attached to the HWND and can be dropped when the
    // window is re-shown, restored, or moved onto another monitor.
    this.win.on('show', () => this.ensureProtected());
    this.win.on('restore', () => this.ensureProtected());
    this.win.on('focus', () => this.ensureProtected());
    this.win.on('ready-to-show', () => this.ensureProtected());
    this.win.on('move', () => this.scheduleEnsure());
    this.win.on('moved', () => {
      this.scheduleEnsure();
      this.persistBounds();
    });
    this.win.on('resize', () => this.scheduleEnsure());
    this.win.on('resized', () => this.persistBounds());
    // Alt+F4 must hide, not destroy: with no tray icon there would otherwise be
    // no window left for the show hotkey to bring back.
    this.win.on('close', (event) => {
      if (this.allowClose) return;
      event.preventDefault();
      this.hide();
    });
    this.win.on('closed', () => {
      this.win = null;
    });

    const reprotectAll = () => this.ensureProtected();
    screen.on('display-added', reprotectAll);
    screen.on('display-removed', reprotectAll);
    screen.on('display-metrics-changed', reprotectAll);

    return this.win;
  }

  get browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** Re-applies the flag only when the read-back value is not already 0x11. */
  ensureProtected(): ProtectionStatus | null {
    const win = this.browserWindow;
    if (!win) return null;
    if (readProtection(win) === WDA_EXCLUDEFROMCAPTURE) return this.lastStatus;
    this.lastStatus = protectWindow(win);
    return this.lastStatus;
  }

  /** Forces a full re-apply and returns the verified status. */
  reapplyProtection(): ProtectionStatus | null {
    const win = this.browserWindow;
    if (!win) return null;
    this.lastStatus = protectWindow(win);
    hideFromAltTab(win);
    return this.lastStatus;
  }

  status(): ProtectionStatus | null {
    const win = this.browserWindow;
    if (!win) return this.lastStatus;
    const affinity = readProtection(win);
    if (this.lastStatus) {
      return {
        ...this.lastStatus,
        affinity,
        applied: affinity === WDA_EXCLUDEFROMCAPTURE,
      };
    }
    return null;
  }

  /** True when the window carries WS_EX_TOOLWINDOW, i.e. no Alt+Tab entry. */
  isHiddenFromAltTab(): boolean {
    const win = this.browserWindow;
    return win ? isHiddenFromAltTab(win) : false;
  }

  isVisible(): boolean {
    return this.browserWindow?.isVisible() ?? false;
  }

  show(): void {
    const win = this.browserWindow;
    if (!win) return;
    // Protect first, then show: the window must never be composited unprotected.
    this.ensureProtected();
    win.show();
    win.setAlwaysOnTop(win.isAlwaysOnTop(), 'screen-saver');
    win.focus();
    this.ensureProtected();
  }

  hide(): void {
    this.browserWindow?.hide();
  }

  toggle(): boolean {
    if (this.isVisible()) {
      this.hide();
      return false;
    }
    this.show();
    return true;
  }

  setOpacity(value: number): void {
    this.browserWindow?.setOpacity(value);
  }

  applyAlwaysOnTop(enabled: boolean): void {
    // 'screen-saver' keeps the overlay above full-screen apps and other topmost windows.
    this.browserWindow?.setAlwaysOnTop(enabled, 'screen-saver');
  }

  send(channel: string, payload: unknown): void {
    this.browserWindow?.webContents.send(channel, payload);
  }

  /** Lets the window actually close on the next quit. */
  prepareForQuit(): void {
    this.allowClose = true;
  }

  destroy(): void {
    if (this.reprotectTimer) clearTimeout(this.reprotectTimer);
    this.allowClose = true;
    this.browserWindow?.destroy();
    this.win = null;
  }

  private scheduleEnsure(): void {
    if (this.reprotectTimer) clearTimeout(this.reprotectTimer);
    this.reprotectTimer = setTimeout(() => {
      this.reprotectTimer = null;
      this.ensureProtected();
    }, REPROTECT_DEBOUNCE_MS);
  }

  private persistBounds(): void {
    const win = this.browserWindow;
    if (!win) return;
    this.saveBounds(win.getBounds());
  }

  /** Clamps saved bounds back onto a currently connected display. */
  private resolveBounds(saved: Bounds | null): Bounds {
    const primary = screen.getPrimaryDisplay().workArea;
    if (!saved) {
      return {
        width: DEFAULT_SIZE.width,
        height: DEFAULT_SIZE.height,
        x: Math.round(primary.x + primary.width - DEFAULT_SIZE.width - 40),
        y: Math.round(primary.y + 60),
      };
    }

    const width = Math.max(MIN_WIDTH, saved.width);
    const height = Math.max(MIN_HEIGHT, saved.height);
    const area = screen.getDisplayMatching({ ...saved, width, height }).workArea;

    const visible =
      saved.x + width > area.x &&
      saved.x < area.x + area.width &&
      saved.y + height > area.y &&
      saved.y < area.y + area.height;

    if (visible) return { x: saved.x, y: saved.y, width, height };
    return {
      width,
      height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
    };
  }
}
