"""
ElevenLabs Scribe speech-to-text — the only recognition engine.

The local faster-whisper engine was removed at the user's request, which takes
ctranslate2, onnxruntime, the CUDA runtime and ~2 GB of model weights with it.
What remains is a thin HTTP client.

Consequences worth keeping in mind, all measured rather than assumed:

  * There is no streaming endpoint; the REST API is batch only. Every preview
    and every final costs a full round trip, measured at **1.6-1.9 s** for a
    4-second segment. That is the floor on how quickly text can appear, and no
    amount of tuning moves it.
  * Every request is billable, so previews are throttled separately from finals.
  * There is no offline path any more. A network failure means no transcript,
    surfaced as an error with a Restart button rather than silence.
  * `keyterms` is the domain-vocabulary bias, equivalent to what `initial_prompt`
    did for Whisper. The settings field feeds it.
  * Per-word `logprob` comes back, which is what the confidence gate uses.

PRIVACY: the captured audio — other people's speech from your call — is uploaded
to a third party, one request per speech segment.
"""

from __future__ import annotations

import io
import logging
import math
import os
import time
import wave
from typing import Callable

import numpy as np

from .config import SAMPLE_RATE
from .recognition import (
    EngineUnavailable,
    Recognition,
    compression_ratio,
    is_noise,
)

_log = logging.getLogger("transcriber.scribe")

ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text"
API_KEY_ENV = "ELEVENLABS_API_KEY"
DEFAULT_MODEL = "scribe_v1"

#: Scribe wants ISO 639-3.
LANGUAGE_CODES = {"en": "eng", "ur": "urd", "hi": "hin"}


def api_key(configured: str = "") -> str:
    """Environment first, settings second — so a key can stay off disk."""
    return (os.environ.get(API_KEY_ENV) or configured or "").strip()


def encode_wav(audio: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    """float32 mono -> 16-bit PCM WAV, in memory. Nothing touches the disk."""
    clipped = np.clip(audio, -1.0, 1.0)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((clipped * 32767).astype(np.int16).tobytes())
    return buffer.getvalue()


def keyterms_from(vocabulary: str) -> list[str]:
    """
    Turns the free-text vocabulary setting into the array the API wants.

    The field stays comma-separated prose so it reads naturally in settings.
    """
    if not vocabulary:
        return []
    terms = [part.strip(" .;\n\t") for part in vocabulary.split(",")]
    return [t for t in terms if t][:100]


class ScribeEngine:
    """Stateless apart from configuration; every call is an independent request."""

    def __init__(
        self,
        on_status: Callable[[str, dict], None],
        model: str = DEFAULT_MODEL,
        timeout_s: float = 20.0,
    ):
        self._on_status = on_status
        #: Key from settings; the environment variable still wins.
        self.configured_key = ""
        self._model = model
        self._timeout = timeout_s
        self._ready = False
        self.device = "cloud"
        self.compute_type = "elevenlabs"
        self.device_note = "ElevenLabs Scribe — audio is uploaded to a third-party API"

    @property
    def model_name(self) -> str | None:
        return self._model if self._ready else None

    @property
    def loaded(self) -> bool:
        return self._ready

    def ensure_model(self, name: str) -> None:
        """
        No download; validates configuration.

        Surfacing a missing key here means it is reported when transcription
        starts, rather than on the first thing somebody says.
        """
        if name:
            self._model = name
        if not api_key(self.configured_key):
            raise EngineUnavailable(
                "no ElevenLabs API key — add one in Settings -> Transcription, "
                f"or set the {API_KEY_ENV} environment variable"
            )
        self._ready = True
        _log.info("ElevenLabs %s ready", self._model)
        self._on_status(
            "model_ready",
            {
                "model": self._model,
                "device": self.device,
                "compute_type": self.compute_type,
                "note": self.device_note,
                "english_only": False,
            },
        )

    def transcribe(
        self,
        audio: np.ndarray,
        language: str | None,
        interim: bool = False,
        vocabulary: str = "",
    ) -> Recognition | None:
        if audio.size == 0:
            return None
        if not self._ready:
            raise EngineUnavailable(
                "ElevenLabs engine not configured — see the error above"
            )

        import requests

        duration = audio.size / SAMPLE_RATE
        form: list[tuple[str, str]] = [
            ("model_id", self._model),
            ("diarize", "false"),
            ("timestamps_granularity", "word"),
        ]
        code = LANGUAGE_CODES.get(language or "", "")
        if code:
            form.append(("language_code", code))
        for term in keyterms_from(vocabulary):
            form.append(("keyterms", term))

        started = time.monotonic()
        response = requests.post(
            ENDPOINT,
            headers={"xi-api-key": api_key(self.configured_key)},
            data=form,
            files=[("file", ("segment.wav", encode_wav(audio), "audio/wav"))],
            timeout=self._timeout,
        )
        elapsed = time.monotonic() - started

        if response.status_code == 401:
            raise EngineUnavailable(f"ElevenLabs rejected the API key: {response.text[:160]}")
        if not response.ok:
            raise RuntimeError(f"ElevenLabs HTTP {response.status_code}: {response.text[:160]}")

        payload = response.json()
        text = (payload.get("text") or "").strip()
        if not text:
            return None

        word_logprobs = [
            float(w["logprob"])
            for w in payload.get("words", [])
            if w.get("type") == "word" and w.get("logprob") is not None
        ]
        avg_logprob = float(np.mean(word_logprobs)) if word_logprobs else 0.0

        _log.debug(
            "%s %.2fs audio in %dms, %d words",
            "preview" if interim else "final",
            duration,
            round(elapsed * 1000),
            len(word_logprobs),
        )

        if is_noise(text, avg_logprob, compression_ratio(text), duration):
            return None

        return Recognition(
            text=text,
            language=payload.get("language_code", language or "") or "",
            avg_logprob=avg_logprob,
            # Scribe reports no no-speech probability; an empty result is the
            # equivalent signal and is handled above.
            no_speech_prob=0.0,
            duration=duration,
        )


def probe() -> dict:
    """Diagnostic for `--probe`: does the key work, and how fast is the round trip."""
    if not api_key():
        return {"ok": False, "detail": f"{API_KEY_ENV} is not set"}
    import requests

    tone = (0.05 * np.sin(2 * math.pi * 440 * np.arange(SAMPLE_RATE) / SAMPLE_RATE)).astype(
        np.float32
    )
    started = time.monotonic()
    try:
        response = requests.post(
            ENDPOINT,
            headers={"xi-api-key": api_key()},
            data=[("model_id", DEFAULT_MODEL), ("language_code", "eng")],
            files=[("file", ("probe.wav", encode_wav(tone), "audio/wav"))],
            timeout=20,
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    return {
        "ok": response.ok,
        "status": response.status_code,
        "latencyMs": round((time.monotonic() - started) * 1000),
        "detail": "" if response.ok else response.text[:200],
    }
