"""
Ring buffer + energy-based voice activity segmentation.

Whisper is not a streaming model: it transcribes a finite chunk. Cutting audio
into blind fixed-size chunks slices words in half and makes the model hallucinate
across the seams, so speech is segmented on silence instead.

This is the *first* VAD stage — it decides where a segment starts and ends.
faster-whisper's own `vad_filter` runs afterwards inside the recognizer as a
second stage that trims leading/trailing silence from the chunk this produces.
"""

from __future__ import annotations

import collections
import math
import threading
from dataclasses import dataclass
from typing import Callable

import numpy as np

from .config import (
    ABSOLUTE_SILENCE_DBFS,
    FRAME_SAMPLES,
    INTERIM_INTERVAL_S,
    MAX_SEGMENT_S,
    MIN_SEGMENT_MS,
    PRE_ROLL_MS,
    RING_SECONDS,
    SAMPLE_RATE,
    SILENCE_END_MS,
    SPEECH_ONSET_FRAMES,
)


class RingBuffer:
    """
    Fixed-size circular buffer of float32 samples, in memory only.

    If the reader falls behind by more than the buffer length the oldest audio is
    dropped rather than growing without bound — a long meeting must not turn into
    a memory leak.
    """

    def __init__(self, seconds: int = RING_SECONDS, rate: int = SAMPLE_RATE):
        self.capacity = seconds * rate
        self._buf = np.zeros(self.capacity, dtype=np.float32)
        self._write = 0
        self._read = 0
        self._available = 0
        self._dropped = 0
        self._lock = threading.Lock()
        self._data_ready = threading.Condition(self._lock)

    @property
    def dropped_samples(self) -> int:
        with self._lock:
            return self._dropped

    def write(self, samples: np.ndarray) -> None:
        if samples.size == 0:
            return
        with self._data_ready:
            n = samples.size
            if n >= self.capacity:
                samples = samples[-self.capacity :]
                n = samples.size
            end = self._write + n
            if end <= self.capacity:
                self._buf[self._write : end] = samples
            else:
                first = self.capacity - self._write
                self._buf[self._write :] = samples[:first]
                self._buf[: n - first] = samples[first:]
            self._write = end % self.capacity

            self._available += n
            if self._available > self.capacity:
                overflow = self._available - self.capacity
                self._read = (self._read + overflow) % self.capacity
                self._available = self.capacity
                self._dropped += overflow
            self._data_ready.notify_all()

    def read(self, n: int, timeout: float = 0.5) -> np.ndarray:
        """Blocks until `n` samples are available, or returns empty on timeout."""
        with self._data_ready:
            if self._available < n:
                self._data_ready.wait(timeout)
            if self._available < n:
                return np.zeros(0, dtype=np.float32)
            end = self._read + n
            if end <= self.capacity:
                out = self._buf[self._read : end].copy()
            else:
                first = self.capacity - self._read
                out = np.concatenate([self._buf[self._read :], self._buf[: n - first]])
            self._read = end % self.capacity
            self._available -= n
            return out

    def clear(self) -> None:
        with self._data_ready:
            self._read = self._write
            self._available = 0
            self._buf.fill(0.0)

    def wake(self) -> None:
        with self._data_ready:
            self._data_ready.notify_all()


def loud_half_mean(levels: list[float]) -> float:
    """Mean of the louder half of the frame levels.

    Robust to the leading and trailing quiet frames every segment carries, so it
    reflects how loud the *speech* was rather than the segment as a whole.
    """
    if not levels:
        return -120.0
    ordered = sorted(levels)
    return float(np.mean(ordered[len(ordered) // 2 :]))


def frame_dbfs(frame: np.ndarray) -> float:
    if frame.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(frame, dtype=np.float64))))
    if rms <= 1e-9:
        return -120.0
    return 20.0 * math.log10(rms)


@dataclass
class Segment:
    seq: int
    audio: np.ndarray
    started_at: float
    ended_at: float
    truncated: bool = False
    #: Wall clock of the last frame that actually contained speech. Everything
    #: after it is the silence we waited through, so this is the reference point
    #: for "end-of-speech to text on screen".
    speech_ended_at: float = 0.0
    #: Wall clock at which the segmenter closed and queued this segment.
    closed_at: float = 0.0
    #: Mean level of the louder half of this segment's frames, in dBFS. Lets the
    #: pipeline recognise background chatter *before* paying to decode it.
    mean_dbfs: float = -120.0

    @property
    def duration(self) -> float:
        return self.audio.size / SAMPLE_RATE


class Segmenter:
    """
    Consumes 30 ms frames and emits segments bounded by silence.

    A segment closes when either:
      * `SILENCE_END_MS` of silence follows speech, or
      * the segment reaches `MAX_SEGMENT_S`.

    On the hard length cut the split point is the quietest frame in the last
    400 ms, which usually lands between words instead of mid-syllable.
    """

    ONSET_MARGIN_DB = 8.0
    #: Once speaking, a pause is detected as a DROP relative to how loud this
    #: speaker actually is, not as an absolute level.
    #:
    #: This is the fix for the case that matters in a real call: the speaker
    #: stops, but their room/line noise carries on. An absolute threshold never
    #: falls below it, so end-of-speech was never detected and nothing reached
    #: the screen until the hard segment cap. A relative drop does not care how
    #: loud the background is.
    SPEECH_DROP_DB = 10.0
    #: How quickly the running speech level follows the speaker.
    SPEECH_LEVEL_ALPHA = 0.15

    def __init__(
        self,
        on_interim: Callable[[int, np.ndarray], None],
        on_final: Callable[[Segment], None],
        config=None,
        on_speech_start: Callable[[float], None] | None = None,
    ):
        self._on_interim = on_interim
        self._on_final = on_final
        #: Fired the instant speech resumes, which is far earlier than the
        #: corresponding transcription result. The merge layer needs to know
        #: whether the speaker carried on well before that text exists.
        self._on_speech_start = on_speech_start
        # Live tuning: read from RuntimeConfig on every frame so a settings
        # change takes effect on the next sentence, with no restart.
        self._config = config
        self._seq = 0

        preroll_frames = max(1, PRE_ROLL_MS // (FRAME_SAMPLES * 1000 // SAMPLE_RATE))
        self._preroll: collections.deque = collections.deque(maxlen=preroll_frames)

        self._noise_floor = -60.0
        self._in_speech = False
        self._onset_run = 0
        self._silence_run = 0
        self._frames: list[np.ndarray] = []
        self._levels: list[float] = []
        self._started_at = 0.0
        self._last_interim_len = 0
        self._loud_seen_at = 0.0
        #: Running level of the current speaker, in dBFS. Only meaningful while
        #: `_in_speech`; reset at each onset.
        self._speech_level = -60.0

    def reset(self) -> None:
        self._preroll.clear()
        self._speech_level = -60.0
        self._in_speech = False
        self._onset_run = 0
        self._silence_run = 0
        self._frames.clear()
        self._levels.clear()
        self._last_interim_len = 0

    @property
    def last_loud_at(self) -> float:
        return self._loud_seen_at

    @property
    def noise_floor(self) -> float:
        return self._noise_floor

    def push(self, frame: np.ndarray, now: float) -> None:
        level = frame_dbfs(frame)

        if self._in_speech:
            # Relative test: has the level dropped well below this speaker?
            # Independent of the absolute noise level, so constant background
            # noise no longer holds the segment open forever.
            is_speech = level > self._speech_level - self.SPEECH_DROP_DB
            if is_speech:
                self._speech_level += (level - self._speech_level) * self.SPEECH_LEVEL_ALPHA
        else:
            # Onset still uses the noise floor: we need an absolute reference
            # before there is a speaker level to compare against.
            threshold = max(
                self._noise_floor + self.ONSET_MARGIN_DB, ABSOLUTE_SILENCE_DBFS + 6.0
            )
            is_speech = level > threshold and level > ABSOLUTE_SILENCE_DBFS

        if level > ABSOLUTE_SILENCE_DBFS:
            self._loud_seen_at = now

        if not is_speech:
            # Track the noise floor only on non-speech frames; rise slowly, fall fast.
            if level < self._noise_floor:
                self._noise_floor += (level - self._noise_floor) * 0.25
            else:
                self._noise_floor += (level - self._noise_floor) * 0.02
            self._noise_floor = max(self._noise_floor, -90.0)

        if not self._in_speech:
            self._preroll.append(frame)
            self._onset_run = self._onset_run + 1 if is_speech else 0
            if self._onset_run >= SPEECH_ONSET_FRAMES:
                self._in_speech = True
                # Seed the speaker level from the frame that triggered onset.
                self._speech_level = level
                self._seq += 1
                self._silence_run = 0
                self._frames = list(self._preroll)
                self._levels = [level] * len(self._frames)
                self._preroll.clear()
                self._started_at = now - (len(self._frames) * FRAME_SAMPLES / SAMPLE_RATE)
                self._last_interim_len = 0
                if self._on_speech_start is not None:
                    self._on_speech_start(self._started_at)
            return

        self._frames.append(frame)
        self._levels.append(level)
        self._silence_run = 0 if is_speech else self._silence_run + 1

        frame_seconds = FRAME_SAMPLES / SAMPLE_RATE
        length_s = len(self._frames) * frame_seconds
        silence_s = self._silence_run * frame_seconds

        if silence_s >= self._silence_end_ms() / 1000.0:
            self._close(now, truncated=False)
            return

        if length_s >= self._max_segment_s():
            self._close_at_quiet_point(now)
            return

        pending = len(self._frames) - self._last_interim_len
        if pending * frame_seconds >= self._interim_interval_s():
            self._last_interim_len = len(self._frames)
            self._on_interim(self._seq, np.concatenate(self._frames))

    def flush(self, now: float) -> None:
        if self._in_speech:
            self._close(now, truncated=False)

    # -- internals ------------------------------------------------------------

    def _silence_end_ms(self) -> int:
        return getattr(self._config, "segment_silence_ms", SILENCE_END_MS)

    def _max_segment_s(self) -> float:
        return getattr(self._config, "max_segment_s", MAX_SEGMENT_S)

    def _interim_interval_s(self) -> float:
        return getattr(self._config, "interim_interval_s", INTERIM_INTERVAL_S)

    def _close(self, now: float, truncated: bool) -> None:
        frames = self._frames
        levels = list(self._levels)
        frame_seconds = FRAME_SAMPLES / SAMPLE_RATE
        # Everything after the last speech frame is the silence we waited out.
        speech_ended_at = now - (self._silence_run * frame_seconds)
        self._in_speech = False
        self._frames = []
        self._levels = []
        self._onset_run = 0
        self._silence_run = 0
        self._last_interim_len = 0
        if not frames:
            return

        audio = np.concatenate(frames)
        if audio.size < MIN_SEGMENT_MS * SAMPLE_RATE // 1000:
            return
        self._on_final(
            Segment(
                seq=self._seq,
                audio=audio,
                started_at=self._started_at,
                ended_at=now,
                truncated=truncated,
                speech_ended_at=speech_ended_at,
                closed_at=now,
                mean_dbfs=loud_half_mean(levels),
            )
        )

    def _close_at_quiet_point(self, now: float) -> None:
        """Hard length limit: split at the quietest frame in the last 400 ms."""
        frame_seconds = FRAME_SAMPLES / SAMPLE_RATE
        tail_frames = max(1, int(0.4 / frame_seconds))
        window_start = max(1, len(self._levels) - tail_frames)
        tail = self._levels[window_start:]
        cut = window_start + int(np.argmin(tail)) + 1 if tail else len(self._frames)
        cut = max(1, min(cut, len(self._frames)))

        head = self._frames[:cut]
        rest = self._frames[cut:]
        rest_levels = self._levels[cut:]

        audio = np.concatenate(head)
        segment_started = self._started_at
        segment_ended = now - (len(rest) * frame_seconds)
        closing_seq = self._seq

        # Carry the remainder into a new open segment: speech is still going.
        self._frames = rest
        self._levels = rest_levels
        self._started_at = segment_ended
        self._last_interim_len = 0
        self._silence_run = 0
        self._in_speech = bool(rest)
        if rest:
            self._seq += 1

        if audio.size >= MIN_SEGMENT_MS * SAMPLE_RATE // 1000:
            self._on_final(
                Segment(
                    seq=closing_seq,
                    audio=audio,
                    started_at=segment_started,
                    ended_at=segment_ended,
                    truncated=True,
                    # A length-capped cut happens *during* speech, so there is no
                    # silence wait: end-of-speech is the cut point itself.
                    speech_ended_at=segment_ended,
                    closed_at=now,
                    mean_dbfs=loud_half_mean(self._levels[:cut]),
                )
            )
