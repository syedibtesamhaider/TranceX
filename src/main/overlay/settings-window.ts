/**
 * Settings window. Also capture-excluded — it is part of the private overlay and
 * should not show up in a share either.
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { hideFromAltTab, protectWindow } from './capture-protection';

export class SettingsWindow {
  private win: BrowserWindow | null = null;

  /**
   * Deliberately not a child of the overlay window: a child of a hidden parent
   * does not display, and Settings must stay reachable while the overlay is
   * hidden.
   */
  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }

    this.win = new BrowserWindow({
      width: 420,
      height: 560,
      minWidth: 380,
      minHeight: 460,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'Overlay settings',
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
    protectWindow(this.win);
    hideFromAltTab(this.win);

    void this.win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'settings', 'index.html'));

    this.win.once('ready-to-show', () => {
      protectWindow(this.win!);
      this.win?.show();
    });
    this.win.on('show', () => this.win && protectWindow(this.win));
    this.win.on('closed', () => {
      this.win = null;
    });
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}
