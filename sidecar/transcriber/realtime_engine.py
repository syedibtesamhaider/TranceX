"""
ElevenLabs Scribe realtime (streaming) engine.

A persistent websocket that audio is pushed into continuously and transcripts
come back from as they are recognised, instead of cutting the audio into
segments and POSTing each one.

Protocol (from the published AsyncAPI spec, verified against the live service):

    connect  wss://api.elevenlabs.io/v1/speech-to-text/realtime?<config>
    server   {"message_type":"session_started","config":{...}}
    client   {"message_type":"input_audio_chunk","audio_base_64":...,"commit":false}
    server   {"message_type":"partial_transcript","text":...}      # may change
    server   {"message_type":"committed_transcript","text":...}    # stable

Everything is configured through query parameters, including `keyterms` (repeated,
each at most 20 characters), `commit_strategy` (`vad` or `manual`) and
`filter_background_audio`.

Measured end-to-end latency, word first appearing on screen after being spoken:
**median ~1.0 s, p90 ~1.5 s**. The "150 ms" ElevenLabs quotes is the model's own
inference time; the rest is partial-emission cadence and the look-ahead the model
needs before it will commit to a word. Lower than the batch path's 2-3 s, but not
150 ms, and worth knowing before tuning for something unreachable.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
import time
from typing import Callable
from urllib.parse import urlencode

import numpy as np

from .config import SAMPLE_RATE
from .recognition import EngineUnavailable

_log = logging.getLogger("transcriber.realtime")

WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
DEFAULT_MODEL = "scribe_v2_realtime"

#: Audio is pushed in chunks this size.
#:
#: Measured against ground-truth word timings, 20/50/100 ms chunks all give the
#: same median latency (1275/1245/1281 ms) — the service's partial cadence, not
#: the chunk rate, sets the floor. 40 ms is kept anyway because it bounds how
#: long a finished word can sit in the local buffer waiting to be sent, which is
#: latency the measurement above could not see.
CHUNK_MS = 40
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000

#: Each keyterm is capped by the API.
MAX_KEYTERM_CHARS = 20
MAX_KEYTERMS = 100


def build_url(
    model: str,
    language: str | None,
    keyterms: list[str],
    filter_background_audio: bool,
    vad_silence_secs: float,
) -> str:
    params: list[tuple[str, str]] = [
        ("model_id", model),
        ("audio_format", "pcm_16000"),
        ("commit_strategy", "vad"),
        ("vad_silence_threshold_secs", f"{vad_silence_secs:.2f}"),
        ("filter_background_audio", "true" if filter_background_audio else "false"),
    ]
    if language:
        params.append(("language_code", language))
    for term in keyterms[:MAX_KEYTERMS]:
        trimmed = term.strip()[:MAX_KEYTERM_CHARS]
        if trimmed:
            params.append(("keyterms", trimmed))
    return f"{WS_URL}?{urlencode(params)}"


class RealtimeEngine:
    """
    Owns the websocket and its event loop on a private thread.

    `feed()` is called from the audio consumer thread and never blocks on the
    network: samples go into a queue that the loop drains.
    """

    def __init__(
        self,
        on_partial: Callable[[str], None],
        on_committed: Callable[[str], None],
        on_status: Callable[[str, dict], None],
    ):
        self._on_partial = on_partial
        self._on_committed = on_committed
        self._on_status = on_status

        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue | None = None
        self._stop = threading.Event()
        self._connected = threading.Event()
        self._error: str | None = None
        #: Set when the service ends the session for a reason retrying cannot
        #: fix (quota, auth). Reported to the user instead of failing quietly.
        self._fatal: str | None = None
        self._pending = np.zeros(0, dtype=np.float32)
        self._first_chunk = True

        # Configuration, set before start().
        self.api_key = ""
        self.model = DEFAULT_MODEL
        self.language: str | None = "eng"
        self.keyterms: list[str] = []
        self.filter_background_audio = True
        self.vad_silence_secs = 0.7

        self.device = "cloud"
        self.compute_type = "elevenlabs-realtime"
        self.device_note = "ElevenLabs Scribe realtime — audio is streamed to a third-party API"

    # -- lifecycle ------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    @property
    def loaded(self) -> bool:
        """Mirrors ScribeEngine.loaded so either engine can be used through `_active`."""
        return self._connected.is_set()

    @property
    def last_error(self) -> str | None:
        return self._error

    def start(self) -> None:
        if not self.api_key:
            raise EngineUnavailable(
                "no ElevenLabs API key — add one in Settings -> Transcription, "
                "or set the ELEVENLABS_API_KEY environment variable"
            )
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._error = None
        self._fatal = None
        self._first_chunk = True
        self._thread = threading.Thread(target=self._run, name="scribe-realtime", daemon=True)
        self._thread.start()

        # Surface a connection failure at start-up rather than on first speech.
        if not self._connected.wait(timeout=12.0):
            self.stop()
            raise EngineUnavailable(self._error or "could not open the realtime connection")

        _log.info("realtime session open (%s)", self.model)
        self._on_status(
            "model_ready",
            {
                "model": self.model,
                "device": self.device,
                "compute_type": self.compute_type,
                "note": self.device_note,
                "english_only": False,
            },
        )

    def stop(self) -> None:
        self._stop.set()
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(lambda: None)  # wake the loop
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=5.0)
        self._thread = None
        self._connected.clear()
        self._pending = np.zeros(0, dtype=np.float32)

    # -- audio in -------------------------------------------------------------

    def feed(self, samples: np.ndarray) -> None:
        """
        Queues float32 mono 16 kHz audio. Never blocks.

        Audio is accumulated into fixed-size chunks so the websocket sees a
        steady cadence regardless of how the capture thread happens to deliver.
        """
        if not self._connected.is_set() or samples.size == 0:
            return
        self._pending = (
            samples if self._pending.size == 0 else np.concatenate([self._pending, samples])
        )
        while self._pending.size >= CHUNK_SAMPLES:
            chunk = self._pending[:CHUNK_SAMPLES]
            self._pending = self._pending[CHUNK_SAMPLES:]
            self._submit(chunk)

    def _submit(self, chunk: np.ndarray) -> None:
        loop, queue = self._loop, self._queue
        if loop is None or queue is None or loop.is_closed():
            return
        pcm = (np.clip(chunk, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        try:
            loop.call_soon_threadsafe(queue.put_nowait, pcm)
        except RuntimeError:
            pass

    # -- the loop -------------------------------------------------------------

    def _run(self) -> None:
        was_connected = False
        try:
            asyncio.run(self._session())
        except Exception as exc:  # noqa: BLE001
            self._error = f"{type(exc).__name__}: {exc}"
            _log.warning("realtime session ended: %s", self._error)
        finally:
            was_connected = self._connected.is_set()
            self._connected.clear()

        if self._stop.is_set():
            return
        # The session ended on its own. Until now that was silent: audio kept
        # being fed into a closed socket and the transcript simply stopped,
        # which looks identical to nobody talking.
        detail = self._fatal or self._error or "the transcription service closed the connection"
        if not was_connected and not self._fatal:
            detail = f"could not start transcription - {detail}"
        _log.warning("realtime session down: %s", detail)
        self._on_status("engine_error", {"message": detail, "fatal": bool(self._fatal)})

    async def _session(self) -> None:
        import websockets

        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=256)

        url = build_url(
            self.model,
            self.language,
            self.keyterms,
            self.filter_background_audio,
            self.vad_silence_secs,
        )

        async with websockets.connect(
            url,
            additional_headers={"xi-api-key": self.api_key},
            ping_interval=20,
            max_queue=64,
        ) as socket:
            sender = asyncio.create_task(self._send_loop(socket))
            receiver = asyncio.create_task(self._receive_loop(socket))
            done, pending = await asyncio.wait(
                {sender, receiver}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc:
                    raise exc

    async def _send_loop(self, socket) -> None:
        assert self._queue is not None
        while not self._stop.is_set():
            try:
                pcm = await asyncio.wait_for(self._queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                continue
            message = {
                "message_type": "input_audio_chunk",
                "audio_base_64": base64.b64encode(pcm).decode("ascii"),
                "commit": False,
            }
            if self._first_chunk:
                self._first_chunk = False
                message["sample_rate"] = SAMPLE_RATE
            await socket.send(json.dumps(message))

    async def _receive_loop(self, socket) -> None:
        async for raw in socket:
            if self._stop.is_set():
                return
            try:
                message = json.loads(raw)
            except (TypeError, ValueError):
                continue

            kind = message.get("message_type")
            if kind == "session_started":
                self._connected.set()
                _log.debug("session config: %s", message.get("config"))
            elif kind == "partial_transcript":
                text = (message.get("text") or "").strip()
                if text:
                    self._on_partial(text)
            elif kind == "committed_transcript":
                text = (message.get("text") or "").strip()
                if text:
                    self._on_committed(text)
            elif kind == "quota_exceeded":
                # Credits are out. Retrying cannot help, and the socket is
                # closed by the service immediately after this.
                self._fatal = (
                    "ElevenLabs quota exceeded - the account is out of credits. "
                    "Transcription will not work until it is topped up or resets."
                )
                _log.warning("realtime: %s", self._fatal)
                return
            elif kind in ("input_error", "invalid_request", "error"):
                detail = message.get("error") or message.get("message") or str(message)
                self._error = str(detail)[:200]
                _log.warning("realtime error: %s", self._error)
                if kind == "invalid_request":
                    self._fatal = f"the transcription service rejected the request - {self._error}"
                    return


def probe(api_key: str, model: str = DEFAULT_MODEL) -> dict:
    """Opens a session and reports how quickly it becomes usable."""
    if not api_key:
        return {"ok": False, "detail": "no API key"}

    ready = threading.Event()
    engine = RealtimeEngine(
        on_partial=lambda _t: None,
        on_committed=lambda _t: None,
        on_status=lambda _k, _p: ready.set(),
    )
    engine.api_key = api_key
    engine.model = model
    started = time.monotonic()
    try:
        engine.start()
        return {
            "ok": True,
            "model": model,
            "connectMs": round((time.monotonic() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    finally:
        engine.stop()
