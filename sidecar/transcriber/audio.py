"""
WASAPI loopback capture.

Captures what the *default output device* is playing — i.e. the other people in
a Teams call — never the microphone. The loopback device is looked up at runtime
and re-looked-up whenever Windows changes the default output device (headphones
plugged in, Teams switching to a comms device, etc.), so a device change
reconfigures the stream instead of killing the session.

Loopback streams run at the device's mix format, typically 48 kHz stereo int16.
Everything is downmixed to mono and resampled to 16 kHz float32 here, because
that is what the recognizer expects.

Nothing is ever written to disk.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

import numpy as np

try:
    import pyaudiowpatch as pyaudio
except ImportError as exc:  # pragma: no cover - surfaced to the UI as an error
    raise RuntimeError(
        "pyaudiowpatch is required for WASAPI loopback capture (pip install PyAudioWPatch)"
    ) from exc

from .config import SAMPLE_RATE

_log = logging.getLogger("transcriber.audio")

DeviceInfo = dict


def _windowed_sinc(num_taps: int, cutoff_norm: float) -> np.ndarray:
    """Low-pass FIR, cutoff normalised to the source sample rate (0..0.5)."""
    n = np.arange(num_taps, dtype=np.float64) - (num_taps - 1) / 2.0
    h = 2.0 * cutoff_norm * np.sinc(2.0 * cutoff_norm * n)
    h *= np.hamming(num_taps)
    h /= np.sum(h)
    return h.astype(np.float32)


class Resampler:
    """
    Anti-aliased rate conversion to 16 kHz, streaming and stateful.

    A windowed-sinc low-pass runs at the source rate, then linear interpolation
    lands on the target grid. Filter state and the fractional read position carry
    across blocks so there are no clicks at block boundaries. Deliberately
    numpy-only: scipy would add ~35 MB to the packaged sidecar for this one job.
    """

    def __init__(self, src_rate: int, dst_rate: int = SAMPLE_RATE, num_taps: int = 65):
        self.src_rate = int(src_rate)
        self.dst_rate = int(dst_rate)
        self.step = self.src_rate / float(self.dst_rate)
        self._passthrough = self.src_rate == self.dst_rate

        if not self._passthrough:
            cutoff = min(0.45 * self.dst_rate, 0.45 * self.src_rate) / self.src_rate
            self._h = _windowed_sinc(num_taps, cutoff)
            self._tail = np.zeros(num_taps - 1, dtype=np.float32)
            self._prev = np.zeros(0, dtype=np.float32)
            self._pos = 0.0

    def process(self, mono: np.ndarray) -> np.ndarray:
        if self._passthrough or mono.size == 0:
            return mono.astype(np.float32, copy=False)

        x = np.concatenate([self._tail, mono])
        self._tail = x[-(self._h.size - 1) :]
        y = np.convolve(x, self._h, mode="valid")  # same length as `mono`

        if self._prev.size:
            y = np.concatenate([self._prev, y])
        base = float(len(self._prev))  # index of the first *new* sample
        self._prev = y[-1:].copy()

        available = len(y) - 1
        if available <= self._pos:
            return np.zeros(0, dtype=np.float32)

        count = int(np.floor((available - self._pos) / self.step)) + 1
        idx = self._pos + self.step * np.arange(count, dtype=np.float64)
        out = np.interp(idx, np.arange(len(y), dtype=np.float64), y).astype(np.float32)

        # Re-base the position onto the next block, whose index 0 is this y[-1].
        self._pos = (self._pos + self.step * count) - available
        del base
        return out


def _iter_loopback_devices(pa: "pyaudio.PyAudio"):
    try:
        yield from pa.get_loopback_device_info_generator()
    except Exception:
        return


def find_loopback_device(pa: "pyaudio.PyAudio") -> tuple[DeviceInfo | None, str]:
    """
    Resolve the loopback device matching the current default output device.

    Returns (device_info, note). `note` explains a fallback when the exact
    default could not be matched.
    """
    try:
        wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
    except OSError:
        return None, "WASAPI host API is not available on this system"

    default_index = wasapi.get("defaultOutputDevice", -1)
    default_out = None
    if default_index is not None and default_index >= 0:
        try:
            default_out = pa.get_device_info_by_index(default_index)
        except Exception:
            default_out = None

    if default_out and default_out.get("isLoopbackDevice"):
        return default_out, ""

    if default_out:
        name = str(default_out.get("name", ""))
        for loopback in _iter_loopback_devices(pa):
            if name and name in str(loopback.get("name", "")):
                return loopback, ""

    for loopback in _iter_loopback_devices(pa):
        return loopback, "default output device could not be matched; using the first loopback device"

    return None, "no WASAPI loopback device found — is any audio device enabled?"


def default_output_index(pa: "pyaudio.PyAudio") -> int:
    try:
        return int(pa.get_host_api_info_by_type(pyaudio.paWASAPI).get("defaultOutputDevice", -1))
    except Exception:
        return -1


#: Read sizes to try, smallest first, as a fraction of a second.
#:
#: The blocking read returns only once a whole block has been captured, so the
#: block size is dead time ahead of everything else in the pipeline and shorter
#: is better. But a WASAPI loopback endpoint only accepts buffer sizes it can
#: align to its own period: asking for 20 ms on a device that will not do it
#: fails the open with PortAudio's paUnanticipatedHostError (-9999), which
#: surfaces to the user as "Unanticipated host error". Which sizes a driver
#: accepts cannot be known in advance, so they are tried in turn and the first
#: that opens wins. 100 ms is last because it is the one known to work broadly.
#:
#: 100 ms is deliberately first, even though a shorter block would shave dead
#: time off the front of the pipeline. Shorter blocks were tried and reverted:
#: 20 ms and then 40 ms opened cleanly but failed at read time on a real headset
#: endpoint with paUnanticipatedHostError, because WASAPI shared mode runs one
#: engine period per endpoint and a second client asking for an incompatible
#: alignment is refused. The saving was never worth it either — measured against
#: ground-truth word timings the service's own emission cadence (~1.25 s median)
#: dominates and did not move at all between 20, 50 and 100 ms blocks.
#:
#: The larger sizes exist so a device that cannot hold even 100 ms still starts
#: rather than failing outright.
BUFFER_CANDIDATES_S = (0.1, 0.2)


def is_host_error(exc: BaseException) -> bool:
    """PortAudio's paUnanticipatedHostError, however the backend wraps it."""
    return isinstance(exc, OSError) and getattr(exc, "errno", None) == -9999


def open_input_stream(pa, device, rate: int, channels: int, floor: int = 0):
    """
    Opens the loopback stream at the shortest block size the device accepts.

    `floor` skips candidates already known to fail on this device, so a driver
    that opens at 20 ms but cannot sustain reads there is not tried at 20 ms
    again on every reconnect.
    """
    index = int(device["index"])
    errors: list[str] = []
    for position, seconds in enumerate(BUFFER_CANDIDATES_S):
        if position < floor:
            continue
        frames = max(256, int(rate * seconds))
        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                frames_per_buffer=frames,
                input=True,
                input_device_index=index,
            )
        except Exception as exc:  # noqa: BLE001 - driver errors vary by backend
            errors.append(f"{int(seconds * 1000)}ms: {exc}")
            continue
        _log.info("capture block %d ms (%d frames)", int(seconds * 1000), frames)
        return stream, frames, position
    raise RuntimeError("could not open the loopback stream - " + "; ".join(errors))


class LoopbackCapture:
    """
    Background thread: opens the loopback stream, converts to 16 kHz mono
    float32, and hands blocks to `on_audio`.

    The default output device is polled while streaming; when it changes, the
    stream is torn down and reopened against the new device. PyAudio snapshots
    the device list at construction time, so re-enumeration always uses a fresh
    PyAudio instance.
    """

    DEVICE_POLL_S = 1.0

    def __init__(
        self,
        on_audio: Callable[[np.ndarray], None],
        on_event: Callable[[str, dict], None],
    ):
        self._on_audio = on_audio
        self._on_event = on_event
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._device_name = ""
        #: Index into BUFFER_CANDIDATES_S below which this device has already
        #: failed. Raised when a read fails with a host error, so each reconnect
        #: starts from a size the hardware has not already rejected.
        self._block_floor = 0

    @property
    def device_name(self) -> str:
        return self._device_name

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="loopback-capture", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=3.0)
        self._thread = None
        self._device_name = ""

    # -- internals ------------------------------------------------------------

    def _run(self) -> None:
        backoff = 0.5
        while not self._stop.is_set():
            try:
                self._session()
                backoff = 0.5
            except Exception as exc:  # noqa: BLE001 - reported, then retried
                # The loop below retries, and a host error escalates the block
                # size first, so this is a setback rather than a dead end. Say
                # so, otherwise the UI parks on a terminal error while capture
                # is in fact coming back.
                self._on_event(
                    "capture_error",
                    {
                        "message": f"{type(exc).__name__}: {exc}",
                        "recovering": not self._stop.is_set(),
                        "hostError": is_host_error(exc),
                    },
                )
                if self._stop.wait(backoff):
                    break
                backoff = min(backoff * 2, 5.0)

    def _session(self) -> None:
        pa = pyaudio.PyAudio()
        stream = None
        try:
            device, note = find_loopback_device(pa)
            if device is None:
                raise RuntimeError(note or "no loopback device")

            rate = int(device["defaultSampleRate"])
            channels = int(device["maxInputChannels"]) or 2
            watched_index = default_output_index(pa)
            self._device_name = str(device.get("name", "unknown"))

            self._on_event(
                "device",
                {
                    "name": self._device_name,
                    "rate": rate,
                    "channels": channels,
                    "note": note,
                },
            )

            resampler = Resampler(rate)
            stream, frames_per_buffer, position = open_input_stream(
                pa, device, rate, channels, self._block_floor
            )

            last_device_check = time.monotonic()
            while not self._stop.is_set():
                try:
                    raw = stream.read(frames_per_buffer, exception_on_overflow=False)
                except OSError as exc:
                    # A host error here means the endpoint stopped delivering at
                    # this block size - a shorter block leaves less slack when
                    # the device is busy or is being switched. Step up to the
                    # next candidate permanently rather than reopening at a size
                    # this device has just shown it cannot hold.
                    if is_host_error(exc) and position + 1 < len(BUFFER_CANDIDATES_S):
                        self._block_floor = position + 1
                        _log.warning(
                            "capture failed at %d ms (%s); retrying at %d ms",
                            int(BUFFER_CANDIDATES_S[position] * 1000),
                            exc,
                            int(BUFFER_CANDIDATES_S[self._block_floor] * 1000),
                        )
                    raise
                samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                if channels > 1:
                    usable = (samples.size // channels) * channels
                    samples = samples[:usable].reshape(-1, channels).mean(axis=1)
                block = resampler.process(samples)
                if block.size:
                    self._on_audio(block)

                now = time.monotonic()
                if now - last_device_check >= self.DEVICE_POLL_S:
                    last_device_check = now
                    if default_output_index(pa) != watched_index:
                        self._on_event(
                            "device_changed",
                            {"previous": self._device_name},
                        )
                        return  # reopen against the new default on the next loop
        finally:
            if stream is not None:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            try:
                pa.terminate()
            except Exception:
                pass


def list_devices() -> list[dict]:
    """Diagnostic helper used by `--list-devices`."""
    pa = pyaudio.PyAudio()
    try:
        out = []
        for loopback in _iter_loopback_devices(pa):
            out.append(
                {
                    "index": int(loopback["index"]),
                    "name": str(loopback["name"]),
                    "rate": int(loopback["defaultSampleRate"]),
                    "channels": int(loopback["maxInputChannels"]),
                }
            )
        chosen, note = find_loopback_device(pa)
        return [
            {
                "loopback_devices": out,
                "selected": None if chosen is None else str(chosen["name"]),
                "note": note,
            }
        ]
    finally:
        pa.terminate()
