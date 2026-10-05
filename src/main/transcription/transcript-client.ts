/**
 * WebSocket client for the sidecar.
 *
 * Lives in the main process, not the renderer: the renderer keeps its
 * `default-src 'none'` CSP (it could not open a socket anyway) and never sees
 * the auth token. Transcript text reaches the UI over IPC only.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { SidecarHandshake } from './sidecar-manager';

export type SidecarEvent = Record<string, unknown> & { type: string };

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000];

export class TranscriptClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private target: SidecarHandshake | null = null;
  private attempt = 0;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(target: SidecarHandshake): void {
    this.target = target;
    this.closing = false;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.target = null;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  }

  send(message: Record<string, unknown>): void {
    if (!this.connected) return;
    try {
      this.socket!.send(JSON.stringify(message));
    } catch {
      /* the socket is going away; the reconnect path will surface it */
    }
  }

  private open(): void {
    const target = this.target;
    if (!target) return;

    const socket = new WebSocket(`ws://127.0.0.1:${target.port}`, {
      handshakeTimeout: 5000,
      perMessageDeflate: false,
    });
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      socket.send(JSON.stringify({ type: 'auth', token: target.token }));
      this.emit('open');
    });

    socket.on('message', (raw) => {
      let parsed: SidecarEvent;
      try {
        parsed = JSON.parse(raw.toString()) as SidecarEvent;
      } catch {
        return;
      }
      this.emit('event', parsed);
    });

    socket.on('error', (err: Error) => {
      this.emit('socket-error', err);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (this.socket === socket) this.socket = null;
      if (this.closing) return;
      if (code === 1008) {
        this.emit('fatal', new Error(`Sidecar rejected the connection: ${reason.toString()}`));
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closing || !this.target) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt += 1;
    if (this.attempt > RECONNECT_DELAYS_MS.length) {
      this.emit('fatal', new Error('Lost connection to the transcription sidecar.'));
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
