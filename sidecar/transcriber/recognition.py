"""
Engine-independent recognition types and the output quality gate.

These used to live in the faster-whisper engine. That engine is gone — the app
transcribes exclusively through the ElevenLabs API now — so the parts that are
not Whisper-specific live here.
"""

from __future__ import annotations

import re
import zlib
from dataclasses import dataclass

from .config import (
    HALLUCINATION_PHRASES,
    MAX_COMPRESSION_RATIO,
    MIN_AVG_LOGPROB,
)

PUNCT_ONLY = re.compile(r"^[\s\.\,\!\?\-–—…\"'`~]*$")


@dataclass
class Recognition:
    text: str
    language: str
    avg_logprob: float
    no_speech_prob: float
    duration: float


class EngineUnavailable(RuntimeError):
    """Configuration problem: no key, unknown model, rejected credentials."""


def compression_ratio(text: str) -> float:
    """
    Repetition detector.

    A looping recognizer produces highly compressible text, which is a reliable
    tell that the output is garbage rather than speech.
    """
    if not text:
        return 0.0
    raw = text.encode("utf-8")
    return len(raw) / max(1, len(zlib.compress(raw)))


def is_noise(text: str, avg_logprob: float, ratio: float, duration: float) -> bool:
    """
    Rejects output that is silence, hum, or a known hallucination.

    Runs after recognition because confidence is only known then; the cheap
    energy-based rejection happens earlier, in the pipeline.
    """
    if PUNCT_ONLY.match(text):
        return True
    if avg_logprob < MIN_AVG_LOGPROB:
        return True
    if ratio > MAX_COMPRESSION_RATIO:
        return True

    normalized = text.strip().lower()
    if normalized in HALLUCINATION_PHRASES:
        # Only drop these when the evidence is weak, so a real "thank you"
        # spoken clearly still comes through.
        return duration < 1.5 or avg_logprob < -0.5
    return False
