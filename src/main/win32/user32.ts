/**
 * Thin FFI binding to the handful of user32.dll entry points this app needs.
 *
 * koffi is loaded lazily and defensively: if the native module is missing or the
 * platform is not Windows, every export here degrades to a no-op that reports
 * failure instead of throwing, so the app still starts and can warn the user.
 */

/** Minimal structural types for koffi so we do not depend on its .d.ts shape. */
interface KoffiLib {
  func(prototype: string): (...args: unknown[]) => unknown;
}
interface Koffi {
  load(name: string): KoffiLib;
}

export const GWL_EXSTYLE = -20;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_APPWINDOW = 0x00040000;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

interface Bindings {
  setWindowDisplayAffinity: (hwnd: number, affinity: number) => boolean;
  getWindowDisplayAffinity: (hwnd: number, out: number[]) => boolean;
  getWindowLongPtr: (hwnd: number, index: number) => number;
  setWindowLongPtr: (hwnd: number, index: number, value: number) => number;
  setWindowPos: (
    hwnd: number,
    after: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number,
  ) => boolean;
  getLastError: () => number;
}

let bindings: Bindings | null = null;
let loadAttempted = false;
let loadError: string | null = null;

function loadBindings(): Bindings | null {
  if (loadAttempted) return bindings;
  loadAttempted = true;

  if (process.platform !== 'win32') {
    loadError = 'not running on Windows';
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as Koffi;
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const setAffinity = user32.func(
      'bool __stdcall SetWindowDisplayAffinity(uintptr_t hWnd, uint32_t dwAffinity)',
    );
    const getAffinity = user32.func(
      'bool __stdcall GetWindowDisplayAffinity(uintptr_t hWnd, _Out_ uint32_t *pdwAffinity)',
    );
    const getLongPtr = user32.func(
      'intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int nIndex)',
    );
    const setLongPtr = user32.func(
      'intptr_t __stdcall SetWindowLongPtrW(uintptr_t hWnd, int nIndex, intptr_t dwNewLong)',
    );
    const setPos = user32.func(
      'bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)',
    );
    const lastError = kernel32.func('uint32_t __stdcall GetLastError()');

    bindings = {
      setWindowDisplayAffinity: (hwnd, affinity) => Boolean(setAffinity(hwnd, affinity)),
      getWindowDisplayAffinity: (hwnd, out) => Boolean(getAffinity(hwnd, out)),
      getWindowLongPtr: (hwnd, index) => Number(getLongPtr(hwnd, index)),
      setWindowLongPtr: (hwnd, index, value) => Number(setLongPtr(hwnd, index, value)),
      setWindowPos: (hwnd, after, x, y, cx, cy, flags) =>
        Boolean(setPos(hwnd, after, x, y, cx, cy, flags)),
      getLastError: () => Number(lastError()),
    };
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    bindings = null;
  }

  return bindings;
}

export function isNativeAvailable(): boolean {
  return loadBindings() !== null;
}

export function nativeLoadError(): string | null {
  loadBindings();
  return loadError;
}

/**
 * Electron hands out the HWND as a little-endian buffer (8 bytes on x64).
 * Window handles are small, so the value always fits in a JS number.
 */
export function hwndFromBuffer(handle: Buffer): number | null {
  try {
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0));
    if (handle.length >= 4) return handle.readUInt32LE(0);
  } catch {
    /* fall through */
  }
  return null;
}

export function setDisplayAffinity(hwnd: number, affinity: number): boolean {
  const api = loadBindings();
  if (!api) return false;
  return api.setWindowDisplayAffinity(hwnd, affinity);
}

export function getDisplayAffinity(hwnd: number): number | null {
  const api = loadBindings();
  if (!api) return null;
  const out: number[] = [0];
  if (!api.getWindowDisplayAffinity(hwnd, out)) return null;
  return out[0] ?? null;
}

export function lastError(): number {
  const api = loadBindings();
  return api ? api.getLastError() : 0;
}

export function getExStyle(hwnd: number): number | null {
  const api = loadBindings();
  if (!api) return null;
  return api.getWindowLongPtr(hwnd, GWL_EXSTYLE);
}

/**
 * Adds WS_EX_TOOLWINDOW / removes WS_EX_APPWINDOW so the window disappears from
 * the Alt+Tab switcher (Electron's `skipTaskbar` only covers the taskbar button).
 */
export function applyToolWindowStyle(hwnd: number): boolean {
  const api = loadBindings();
  if (!api) return false;
  const current = api.getWindowLongPtr(hwnd, GWL_EXSTYLE);
  const next = (current | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
  if (next === current) return true;
  api.setWindowLongPtr(hwnd, GWL_EXSTYLE, next);
  api.setWindowPos(
    hwnd,
    0,
    0,
    0,
    0,
    0,
    SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
  );
  return api.getWindowLongPtr(hwnd, GWL_EXSTYLE) === next;
}
