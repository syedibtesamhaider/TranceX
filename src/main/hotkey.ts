/**
 * Global hotkeys. Electron accelerator strings ("Control+Shift+Space").
 *
 * Registration can fail if another process already owns the combination, so the
 * result is reported back to the caller rather than swallowed.
 */
import { globalShortcut } from 'electron';

interface Binding {
  accelerator: string;
  handler: () => void;
}

export class HotkeyManager {
  private readonly bindings = new Map<string, Binding>();

  /** Binds `id` to `accelerator`. Returns false if the combination is taken. */
  set(id: string, accelerator: string, handler: () => void): boolean {
    this.clear(id);
    if (!accelerator) return false;
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (ok) this.bindings.set(id, { accelerator, handler });
      return ok;
    } catch (err) {
      console.error(`[hotkey] registration failed for ${id}:`, err);
      return false;
    }
  }

  /**
   * Checks whether an accelerator is available, without keeping it.
   * All current bindings are released first so re-picking the same combination
   * a hotkey already owns does not read as "taken", then restored either way.
   */
  test(accelerator: string): boolean {
    const saved = [...this.bindings.entries()];
    for (const [id] of saved) this.clear(id);

    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => {});
    } catch {
      ok = false;
    }
    if (ok) globalShortcut.unregister(accelerator);

    for (const [id, binding] of saved) this.set(id, binding.accelerator, binding.handler);
    return ok;
  }

  current(id: string): string | null {
    return this.bindings.get(id)?.accelerator ?? null;
  }

  clear(id: string): void {
    const binding = this.bindings.get(id);
    if (!binding) return;
    try {
      globalShortcut.unregister(binding.accelerator);
    } catch {
      /* ignore */
    }
    this.bindings.delete(id);
  }

  disposeAll(): void {
    this.bindings.clear();
    globalShortcut.unregisterAll();
  }
}
