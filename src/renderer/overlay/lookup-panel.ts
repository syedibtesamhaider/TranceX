/**
 * Auto-answer panel.
 *
 * Stacks the last N answers, newest on top, each with the detected question in
 * dim text above it so you can see what the filter thought was asked. Tokens are
 * appended as they stream in — nothing waits for the full response.
 *
 * Privacy: `entries` is the only copy of these answers anywhere in the app.
 * In-memory only, never persisted, cleared on quit.
 */

interface Entry {
  id: string;
  question: string;
  at: number;
  text: string;
  firstTokenMs: number | null;
  totalMs: number | null;
  error: string | null;
  source: 'auto' | 'manual';
  element: HTMLDivElement;
  bodyEl: HTMLDivElement;
  metaEl: HTMLDivElement;
  interpretedEl: HTMLDivElement;
  /** True once the INTERPRETED: first line has been split off. */
  interpretedDone: boolean;
  fadeTimer: number | null;
  hovered: boolean;
}

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class LookupPanel {
  private readonly api = window.overlayApi;
  private readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly emptyEl: HTMLDivElement;

  private entries: Entry[] = [];
  private maxEntries = 5;
  private fadeSeconds = 45;

  constructor() {
    const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.root = byId<HTMLDivElement>('lookupPanel');
    this.list = byId<HTMLDivElement>('lookupList');
    this.statusEl = byId<HTMLSpanElement>('lookupStatus');
    this.emptyEl = byId<HTMLDivElement>('lookupEmpty');

    this.api.onLookupStarted((event) => this.onStarted(event));
    this.api.onLookupChunk((event) => this.onChunk(event));
    this.api.onLookupDone((event) => this.onDone(event));
    this.api.onLookupError((event) => this.onError(event));
    this.api.onLookupStatus((status) => this.renderStatus(status));
    this.api.onLookupClear(() => this.clear());

    byId<HTMLButtonElement>('lookupPause').addEventListener('click', () =>
      this.api.toggleLookupPause(),
    );
    byId<HTMLButtonElement>('lookupClear').addEventListener('click', () => this.clear());

    void this.api.getLookupStatus().then((status) => this.renderStatus(status));
  }

  applyConfig(config: LookupConfig): void {
    this.maxEntries = config.maxEntries;
    this.fadeSeconds = config.fadeSeconds;
    this.trim();
  }

  /** The panel only takes space once it has something to show. */
  private updateVisibility(): void {
    const hasEntries = this.entries.length > 0;
    this.root.classList.toggle('active', hasEntries);
    this.emptyEl.hidden = hasEntries;
  }

  private renderStatus(status: LookupStatus): void {
    const bits: string[] = [];
    if (!status.enabled) bits.push('auto-answer off');
    else if (!status.hasApiKey) bits.push('auto-answer: no API key');
    else if (status.paused) {
      bits.push(`paused ${Math.ceil(status.pausedForMs / 60000)}m`);
    } else bits.push('auto-answer on');

    bits.push(`${status.rate.remaining}/${status.rate.limit} left`);
    this.statusEl.textContent = bits.join(' · ');
    this.statusEl.classList.toggle('warn', !status.hasApiKey || status.paused);
  }

  // -- streaming ------------------------------------------------------------

  private onStarted(event: LookupStartedEvent): void {
    const element = document.createElement('div');
    element.className = 'lentry';

    const head = document.createElement('div');
    head.className = 'lquestion';
    head.textContent = `${clockTime(event.at)}  ${event.question}`;

    // What the model thinks was actually asked, shown dim above the answer so a
    // misheard question is obvious rather than silently answered.
    const interpreted = document.createElement('div');
    interpreted.className = 'linterpreted';
    interpreted.hidden = true;

    const body = document.createElement('div');
    body.className = 'lanswer';

    const meta = document.createElement('div');
    meta.className = 'lmeta';
    meta.textContent = `${event.source} · ${event.provider} · waiting…`;

    element.append(head, interpreted, body, meta);

    // Hovering holds an entry open; the fade resumes when the pointer leaves.
    element.addEventListener('mouseenter', () => {
      const entry = this.entries.find((candidate) => candidate.id === event.id);
      if (!entry) return;
      entry.hovered = true;
      element.classList.remove('faded');
      if (entry.fadeTimer !== null) {
        window.clearTimeout(entry.fadeTimer);
        entry.fadeTimer = null;
      }
    });
    element.addEventListener('mouseleave', () => {
      const entry = this.entries.find((candidate) => candidate.id === event.id);
      if (!entry) return;
      entry.hovered = false;
      this.scheduleFade(entry);
    });

    this.list.prepend(element); // newest on top
    this.entries.unshift({
      id: event.id,
      question: event.question,
      at: event.at,
      text: '',
      firstTokenMs: null,
      totalMs: null,
      error: null,
      source: event.source,
      element,
      bodyEl: body,
      metaEl: meta,
      interpretedEl: interpreted,
      interpretedDone: false,
      fadeTimer: null,
      hovered: false,
    });
    this.trim();
    this.updateVisibility();
  }

  private find(id: string): Entry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  private onChunk(event: LookupChunkEvent): void {
    const entry = this.find(event.id);
    if (!entry) return;
    if (event.firstTokenMs !== undefined && entry.firstTokenMs === null) {
      entry.firstTokenMs = event.firstTokenMs;
    }
    entry.text += event.text;
    this.render(entry);
    this.renderMeta(entry);
  }

  /**
   * Splits the model's leading `INTERPRETED:` line off the answer body.
   *
   * Done on every chunk because the text arrives token by token: until the first
   * newline lands the whole thing is still the interpretation line.
   */
  private render(entry: Entry): void {
    const marker = 'INTERPRETED:';
    if (!entry.text.startsWith(marker)) {
      // Model ignored the format, or replied with a bare "unclear".
      entry.bodyEl.textContent = entry.text;
      entry.element.classList.toggle('unclear', entry.text.trim().toLowerCase() === 'unclear');
      return;
    }

    const newline = entry.text.indexOf('\n');
    if (newline === -1) {
      entry.interpretedEl.hidden = false;
      entry.interpretedEl.textContent = entry.text.slice(marker.length).trim();
      entry.bodyEl.textContent = '';
      return;
    }

    entry.interpretedEl.hidden = false;
    entry.interpretedEl.textContent = entry.text.slice(marker.length, newline).trim();
    entry.bodyEl.textContent = entry.text.slice(newline + 1).replace(/^\n+/, '');
    entry.interpretedDone = true;
  }

  private onDone(event: LookupDoneEvent): void {
    const entry = this.find(event.id);
    if (!entry) return;
    entry.totalMs = event.totalMs;
    if (event.cancelled && !entry.text) {
      entry.error = 'cancelled — superseded by a newer question';
    }
    this.renderMeta(entry);
    this.scheduleFade(entry);
  }

  private onError(event: LookupErrorEvent): void {
    const entry = this.find(event.id);
    if (!entry) {
      // An error with no started entry (e.g. missing API key) still needs to be
      // visible rather than swallowed.
      this.onStarted({
        id: event.id,
        question: '(lookup)',
        source: 'auto',
        at: Date.now(),
        provider: '',
      });
      const created = this.find(event.id);
      if (created) {
        created.error = event.message;
        this.renderMeta(created);
        this.scheduleFade(created);
      }
      return;
    }
    entry.error = event.message;
    entry.element.classList.add('failed');
    this.renderMeta(entry);
    this.scheduleFade(entry);
  }

  private renderMeta(entry: Entry): void {
    const bits: string[] = [entry.source];
    if (entry.firstTokenMs !== null) bits.push(`first token ${entry.firstTokenMs} ms`);
    if (entry.totalMs !== null) bits.push(`total ${entry.totalMs} ms`);
    if (entry.error) bits.push(`error: ${entry.error}`);
    entry.metaEl.textContent = bits.join(' · ');
    entry.metaEl.classList.toggle('error', Boolean(entry.error));
  }

  private scheduleFade(entry: Entry): void {
    if (entry.hovered) return;
    if (entry.fadeTimer !== null) window.clearTimeout(entry.fadeTimer);
    entry.fadeTimer = window.setTimeout(() => {
      entry.fadeTimer = null;
      if (!entry.hovered) entry.element.classList.add('faded');
    }, this.fadeSeconds * 1000);
  }

  private trim(): void {
    while (this.entries.length > this.maxEntries) {
      const dropped = this.entries.pop();
      if (!dropped) break;
      if (dropped.fadeTimer !== null) window.clearTimeout(dropped.fadeTimer);
      dropped.element.remove();
    }
  }

  clear(): void {
    for (const entry of this.entries) {
      if (entry.fadeTimer !== null) window.clearTimeout(entry.fadeTimer);
    }
    this.entries = [];
    this.list.replaceChildren();
    this.updateVisibility();
  }
}
