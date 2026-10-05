/* ===========================================================================
 * CAPTURE EXCLUSION — what this module does and why
 * ===========================================================================
 *
 * Windows lets a process tell the desktop compositor (DWM) how one of its
 * top-level windows should be treated by anything that captures the screen:
 *
 *     SetWindowDisplayAffinity(hwnd, affinity)
 *
 * The affinity values that matter here:
 *
 *   WDA_NONE               0x00000000  Default. The window is captured normally.
 *
 *   WDA_MONITOR            0x00000001  The window is rendered to the monitor but
 *                                      capture APIs get a BLACK RECTANGLE where
 *                                      the window is. The window's *content* is
 *                                      protected, but its existence, position and
 *                                      size are obvious to anyone watching the
 *                                      share — a black box on the screen.
 *
 *   WDA_EXCLUDEFROMCAPTURE 0x00000011  The window is rendered to the monitor and
 *                                      is omitted from the captured frame
 *                                      ENTIRELY. Capture consumers see whatever
 *                                      is behind the window, as if it were not
 *                                      there. No black box, no artefact.
 *                                      Requires Windows 10 build 19041 (2004) or
 *                                      newer; on older builds the call fails and
 *                                      the window stays fully visible in capture.
 *
 * This app wants WDA_EXCLUDEFROMCAPTURE (0x11) and nothing else. It is applied
 * to every window the app creates, and it is *verified by reading the value
 * back* with GetWindowDisplayAffinity rather than trusting the setter.
 *
 * Why the flag is set through the Win32 API directly instead of relying only on
 * Electron's `BrowserWindow.setContentProtection(true)`:
 *
 *   - Electron's implementation has historically used WDA_MONITOR, and which
 *     flag a given Electron version passes is an implementation detail that can
 *     change between releases. A black rectangle in a Teams share is exactly the
 *     failure mode this app exists to avoid, so the flag is pinned here.
 *   - `setContentProtection(true)` is still called first, because Electron
 *     re-applies its own value on some internal window rebuilds; the explicit
 *     native call then runs afterwards and wins. `verify()` reports the value
 *     actually in effect, so a regression is visible instead of silent.
 *
 * The affinity is bound to the HWND, and Windows can drop or reset it when a
 * window's native handle is rebuilt (show/hide cycles, moving between monitors
 * with different DPI, display topology changes). Every such event re-runs
 * `protectWindow()`, which is idempotent and cheap.
 *
 * Reference: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity
 * =========================================================================== */

import os from 'node:os';
import type { BrowserWindow } from 'electron';
import {
  getDisplayAffinity,
  getExStyle,
  hwndFromBuffer,
  isNativeAvailable,
  lastError,
  nativeLoadError,
  setDisplayAffinity,
  applyToolWindowStyle,
  WS_EX_TOOLWINDOW,
} from '../win32/user32';
import {
  MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE,
  type ProtectionStatus,
} from '../../shared/types';

export const WDA_NONE = 0x00000000;
export const WDA_MONITOR = 0x00000001;
export const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

export function affinityName(value: number | null): string {
  switch (value) {
    case WDA_EXCLUDEFROMCAPTURE:
      return 'WDA_EXCLUDEFROMCAPTURE (0x11)';
    case WDA_MONITOR:
      return 'WDA_MONITOR (0x01)';
    case WDA_NONE:
      return 'WDA_NONE (0x00)';
    case null:
      return 'unreadable';
    default:
      return `unknown (0x${value.toString(16)})`;
  }
}

/** Windows build number parsed from `os.release()` ("10.0.26200" -> 26200). */
export function windowsBuildNumber(): number {
  if (process.platform !== 'win32') return 0;
  const parts = os.release().split('.');
  const build = Number.parseInt(parts[2] ?? '', 10);
  return Number.isFinite(build) ? build : 0;
}

export function isCaptureExclusionSupported(): boolean {
  return windowsBuildNumber() >= MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE;
}

function hwndOf(win: BrowserWindow): number | null {
  try {
    return hwndFromBuffer(win.getNativeWindowHandle());
  } catch {
    return null;
  }
}

/**
 * Applies WDA_EXCLUDEFROMCAPTURE to the window and reports what actually stuck.
 * Safe to call repeatedly; it is a no-op once the affinity already reads 0x11.
 */
export function protectWindow(win: BrowserWindow): ProtectionStatus {
  const buildNumber = windowsBuildNumber();
  const supported = isCaptureExclusionSupported();

  if (process.platform !== 'win32') {
    return {
      supported: false,
      applied: false,
      affinity: null,
      affinityName: affinityName(null),
      buildNumber,
      method: 'none',
      message: 'Capture exclusion is a Windows-only feature; this platform is unprotected.',
    };
  }

  // Ask Electron first. Harmless, and it keeps Electron's internal state in sync
  // so its own re-application (if any) does not later clear our flag.
  try {
    win.setContentProtection(true);
  } catch {
    /* ignore — the native call below is the one that counts */
  }

  const hwnd = hwndOf(win);
  if (hwnd === null) {
    return {
      supported,
      applied: false,
      affinity: null,
      affinityName: affinityName(null),
      buildNumber,
      method: 'electron-only',
      message: 'Could not read the native window handle; falling back to Electron only.',
    };
  }

  let method: ProtectionStatus['method'] = 'electron-only';
  if (isNativeAvailable()) {
    method = 'native-ffi';
    const ok = setDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    if (!ok) {
      const code = lastError();
      const affinity = getDisplayAffinity(hwnd);
      return {
        supported,
        applied: affinity === WDA_EXCLUDEFROMCAPTURE,
        affinity,
        affinityName: affinityName(affinity),
        buildNumber,
        method,
        message: supported
          ? `SetWindowDisplayAffinity failed (GetLastError=${code}).`
          : `This Windows build (${buildNumber}) is older than ${MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE}; WDA_EXCLUDEFROMCAPTURE is not available.`,
      };
    }
  }

  const affinity = getDisplayAffinity(hwnd);
  const applied = affinity === WDA_EXCLUDEFROMCAPTURE;

  let message: string;
  if (applied) {
    message = 'Window is excluded from screen capture (WDA_EXCLUDEFROMCAPTURE).';
  } else if (!supported) {
    message = `Windows build ${buildNumber} is older than ${MIN_BUILD_FOR_EXCLUDE_FROM_CAPTURE}. The window WILL be visible in screen capture.`;
  } else if (affinity === WDA_MONITOR) {
    message =
      'Affinity is WDA_MONITOR: capture tools will show a BLACK RECTANGLE instead of hiding the window.';
  } else if (affinity === null) {
    message = `Affinity could not be read back${nativeLoadError() ? ` (${nativeLoadError()})` : ''}. Assume the window is NOT protected.`;
  } else {
    message = `Unexpected affinity ${affinityName(affinity)}. Assume the window is NOT protected.`;
  }

  return { supported, applied, affinity, affinityName: affinityName(affinity), buildNumber, method, message };
}

/** Reads the current affinity without changing it. */
export function readProtection(win: BrowserWindow): number | null {
  const hwnd = hwndOf(win);
  if (hwnd === null) return null;
  return getDisplayAffinity(hwnd);
}

/** Hides the window from the Alt+Tab switcher via WS_EX_TOOLWINDOW. */
export function hideFromAltTab(win: BrowserWindow): boolean {
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  return applyToolWindowStyle(hwnd);
}

/** True when the window currently carries WS_EX_TOOLWINDOW (no Alt+Tab entry). */
export function isHiddenFromAltTab(win: BrowserWindow): boolean {
  const hwnd = hwndOf(win);
  if (hwnd === null) return false;
  const ex = getExStyle(hwnd);
  return ex !== null && (ex & WS_EX_TOOLWINDOW) !== 0;
}
