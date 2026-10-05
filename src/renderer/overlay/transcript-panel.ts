/**
 * Transcript panel.
 *
 * Self-contained view layer for live speech-to-text. It owns the transcript DOM
 * and nothing else — the window and capture-exclusion logic are untouched by
 * anything in here.
 *
 * Privacy: `lines` is the only copy of the transcript anywhere in the app. It is
 * plain in-memory state, never persisted, never sent anywhere. The Copy button
 * is the single route by which this text leaves the process.
 */

interface Line {
  id: number;
  text: string;
  at: number;
  final: boolean;
  element: HTMLDivElement;
}

const STATE_LABELS: Record<TranscriptionState, string> = {
  stopped: 'stopped',
  starting: 'starting…',
  idle: 'idle',
  listening: 'listening',
  no_audio: 'no audio detected',
  model_loading: 'loading model…',
  error: 'error',
};

/** How close to the bottom still counts as "at the bottom", in px. */
const STICKY_SLOP = 24;

/**
 * How many trailing words of a partial are treated as unsettled.
 *
 * The realtime service reports `max_tokens_to_recompute: 5` in its session
 * config — it will only ever revise roughly that many tokens at the end of a
 * partial. Everything before them is effectively final, so dimming the whole
 * line is misleading: it made a live transcript look permanently provisional,
 * and the text only turned solid when the speaker paused and the sentence was
 * committed. Only the tail is dimmed now.
 */
const VOLATILE_TAIL_WORDS = 5;

/** Splits partial text into the settled head and the part still in flux. */
function splitVolatile(text: string): { settled: string; volatile: string } {
  const parts = text.split(/(\s+)/); // keep the separators
  const wordIndices: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i]!.trim()) wordIndices.push(i);
  }
  if (wordIndices.length <= VOLATILE_TAIL_WORDS) {
    return { settled: '', volatile: text };
  }
  const cut = wordIndices[wordIndices.length - VOLATILE_TAIL_WORDS]!;
  return { settled: parts.slice(0, cut).join(''), volatile: parts.slice(cut).join('') };
}

function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export class TranscriptPanel {
  private readonly api = window.overlayApi;

  private readonly log: HTMLDivElement;
  private readonly jump: HTMLButtonElement;
  private readonly dot: HTMLElement;
  private readonly stateText: HTMLElement;
  private readonly behind: HTMLElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly progress: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly foot: HTMLElement;

  private lines: Line[] = [];
  private interim: Line | null = null;
  private stickToBottom = true;
  private running = false;
  private fontSize = 12;

  constructor(private readonly onFontSize: (size: number) => void) {
    const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.log = byId<HTMLDivElement>('tLog');
    this.jump = byId<HTMLButtonElement>('tJump');
    this.dot = byId('tDot');
    this.stateText = byId('tStateText');
    this.behind = byId('tBehind');
    this.toggleButton = byId<HTMLButtonElement>('tToggle');
    this.progress = byId('tProgress');
    this.progressFill = byId('tProgressFill');
    this.progressLabel = byId('tProgressLabel');
    this.errorBox = byId('tError');
    this.errorText = byId('tErrorText');
    this.foot = byId('tFoot');

    this.bind();
  }

  setFontSize(size: number): void {
    this.fontSize = size;
    this.log.style.setProperty('--transcript-font', `${size}px`);
  }

  private bind(): void {
    // Auto-scroll lock: scrolling up detaches, returning to the bottom re-attaches.
    this.log.addEventListener('scroll', () => {
      const distance = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight;
      const atBottom = distance <= STICKY_SLOP;
      if (atBottom !== this.stickToBottom) {
        this.stickToBottom = atBottom;
        this.jump.hidden = atBottom;
      }
    });

    this.jump.addEventListener('click', () => {
      this.stickToBottom = true;
      this.jump.hidden = true;
      this.scrollToEnd();
    });

    this.toggleButton.addEventListener('click', () => {
      if (this.running) this.api.stopTranscription();
      else this.api.startTranscription();
    });

    (document.getElementById('tClear') as HTMLButtonElement).addEventListener('click', () =>
      this.clear(),
    );
    (document.getElementById('tCopy') as HTMLButtonElement).addEventListener('click', () =>
      this.copyVisible(),
    );
    (document.getElementById('tRestart') as HTMLButtonElement).addEventListener('click', () => {
      this.errorBox.hidden = true;
      this.api.restartTranscription();
    });
    (document.getElementById('tFontUp') as HTMLButtonElement).addEventListener('click', () =>
      this.onFontSize(this.fontSize + 1),
    );
    (document.getElementById('tFontDown') as HTMLButtonElement).addEventListener('click', () =>
      this.onFontSize(this.fontSize - 1),
    );

    this.api.onTranscriptionEvent((event) => this.onEvent(event));
    this.api.onTranscriptionStatus((status) => this.onStatus(status));
    this.api.onTranscriptClear(() => this.clear());
  }

  // -- transcript events ----------------------------------------------------

  private onEvent(event: TranscriptEvent): void {
    if (event.type === 'interim') {
      this.renderInterim(event.id, event.text ?? '');
      return;
    }
    if (event.type === 'drop') {
      // The segment turned out to be noise; retract the interim we showed.
      if (this.interim && this.interim.id === event.id) this.removeInterim();
      return;
    }
    this.renderFinal(event);
  }

  private renderInterim(id: number, text: string): void {
    if (!text.trim()) return;
    if (this.interim && this.interim.id !== id) this.removeInterim();

    if (!this.interim) {
      const element = this.createLine(Date.now(), text, false);
      this.log.appendChild(element);
      this.interim = { id, text, at: Date.now(), final: false, element };
    } else {
      this.interim.text = text;
      const head = this.interim.element.querySelector('.tline-settled');
      const tail = this.interim.element.querySelector('.tline-volatile');
      const { settled, volatile } = splitVolatile(text);
      if (head && tail) {
        head.textContent = settled;
        tail.textContent = volatile;
      }
    }
    this.afterAppend();
  }

  private renderFinal(event: TranscriptEvent): void {
    const text = (event.text ?? '').trim();
    const at = event.startedAt ?? Date.now();
    if (!text) {
      if (this.interim && this.interim.id === event.id) this.removeInterim();
      return;
    }

    // The interim line for this segment becomes the final line — never both.
    if (this.interim && this.interim.id === event.id) {
      const line = this.interim;
      this.interim = null;
      line.final = true;
      line.text = text;
      line.at = at;
      line.element.classList.remove('interim');
      const stamp = line.element.querySelector('.tline-time');
      const body = line.element.querySelector('.tline-text');
      if (stamp) stamp.textContent = clockTime(at);
      // Committed: the whole line settles, tail included.
      if (body) body.textContent = text;
      this.lines.push(line);
    } else {
      if (this.interim) this.removeInterim();
      const element = this.createLine(at, text, true);
      this.log.appendChild(element);
      this.lines.push({ id: event.id, text, at, final: true, element });
    }
    this.afterAppend();
  }

  private createLine(at: number, text: string, final: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.className = final ? 'tline' : 'tline interim';

    const stamp = document.createElement('span');
    stamp.className = 'tline-time';
    stamp.textContent = final ? clockTime(at) : '';

    const body = document.createElement('span');
    body.className = 'tline-text';
    if (final) {
      body.textContent = text;
    } else {
      const { settled, volatile } = splitVolatile(text);
      const head = document.createElement('span');
      head.className = 'tline-settled';
      head.textContent = settled;
      const tail = document.createElement('span');
      tail.className = 'tline-volatile';
      tail.textContent = volatile;
      body.append(head, tail);
    }

    row.append(stamp, body);
    return row;
  }

  private removeInterim(): void {
    this.interim?.element.remove();
    this.interim = null;
  }

  private afterAppend(): void {
    if (this.stickToBottom) this.scrollToEnd();
    else this.jump.hidden = false;
  }

  private scrollToEnd(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }

  // -- status ---------------------------------------------------------------

  private onStatus(status: TranscriptionStatus): void {
    this.running =
      status.state === 'listening' ||
      status.state === 'no_audio' ||
      status.state === 'model_loading' ||
      status.state === 'starting';

    this.toggleButton.textContent = this.running ? 'Stop' : 'Start';
    this.toggleButton.classList.toggle('active', this.running);
    this.stateText.textContent = STATE_LABELS[status.state] ?? status.state;
    this.dot.className = `tdot ${status.state}`;
    this.behind.hidden = !status.behind;

    if (status.download && status.download.total > 0) {
      this.progress.hidden = false;
      this.progressFill.style.width = `${Math.min(100, status.download.percent)}%`;
      this.progressLabel.textContent = `${status.model ?? 'model'} ${status.download.percent.toFixed(0)}% · ${formatBytes(status.download.downloaded)} / ${formatBytes(status.download.total)}`;
    } else if (status.download) {
      this.progress.hidden = false;
      this.progressFill.style.width = '0%';
      this.progressLabel.textContent = `downloading ${status.model ?? 'model'}…`;
    } else {
      this.progress.hidden = true;
    }

    if (status.state === 'error' && status.detail) {
      this.errorBox.hidden = false;
      this.errorText.textContent = status.detail;
    } else if (status.state !== 'error') {
      this.errorBox.hidden = true;
    }

    const bits: string[] = [];
    if (status.device) bits.push(`${status.device}/${status.computeType ?? ''}`);
    if (status.model) bits.push(status.model);
    if (status.language) bits.push(status.englishOnly ? 'en (model is English-only)' : status.language);
    if (status.audioDevice) bits.push(status.audioDevice);
    this.foot.textContent = bits.join(' · ');
  }

  /** Inline notice line — device changes, hotkey failures, etc. */
  note(message: string): void {
    const row = document.createElement('div');
    row.className = 'tnote';
    row.textContent = message;
    this.log.appendChild(row);
    this.afterAppend();
  }

  // -- actions --------------------------------------------------------------

  clear(): void {
    this.lines = [];
    this.interim = null;
    this.log.replaceChildren();
    this.stickToBottom = true;
    this.jump.hidden = true;
  }

  private copyVisible(): void {
    const text = this.lines.map((line) => `[${clockTime(line.at)}] ${line.text}`).join('\n');
    if (!text) return;
    this.api.copyToClipboard(text);
    const previous = this.foot.textContent;
    this.foot.textContent = `copied ${this.lines.length} line${this.lines.length === 1 ? '' : 's'}`;
    window.setTimeout(() => {
      this.foot.textContent = previous;
    }, 1500);
  }
}
