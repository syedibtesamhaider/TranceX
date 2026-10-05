"""
Orchestration: capture -> ring buffer -> segmenter -> recognizer -> events.

Three threads:
  * capture   (audio.LoopbackCapture) writes 16 kHz mono into the ring buffer
  * consumer  reads 30 ms frames out of the ring and drives the segmenter
  * worker    runs the model; one job at a time

Backpressure matters here. On CPU, `medium`/`large-v3` transcribe slower than
real time, so a naive queue grows for the whole meeting and the transcript ends
up minutes behind. Interim jobs are therefore a single replaceable slot (latest
wins, skipped entirely while a final is pending) and finals are bounded — the UI
is told when it is falling behind instead of silently drifting.
"""

from __future__ import annotations

import collections
import threading
import time
from typing import Callable

import numpy as np

import logging

from .config import (
    FRAME_SAMPLES,
    SAMPLE_RATE,
    BACKGROUND_DROP_DB,
    BACKGROUND_MAX_S,
    CLOUD_INTERIM_MIN_SPACING_S,
    SPEAKER_DECAY_DB_PER_S,
    STALE_SEGMENT_S,
    FIRST_INTERIM_AFTER_S,
    INTERIM_DUTY_CYCLE,
    NO_AUDIO_AFTER_S,
    QUEUE_MAX_DEPTH,
    QUEUE_WARN_DEPTH,
    TERMINAL_PUNCTUATION,
    RuntimeConfig,
)

log = logging.getLogger("transcriber.latency")
from .audio import LoopbackCapture
from .recognition import EngineUnavailable
from .realtime_engine import RealtimeEngine
from .scribe_engine import ScribeEngine, keyterms_from
from .vad import RingBuffer, Segment, Segmenter

Emit = Callable[[dict], None]


class Pipeline:
    def __init__(self, emit: Emit, models_dir: str):
        self._emit = emit
        self.config = RuntimeConfig()
        self.ring = RingBuffer()
        self._models_dir = models_dir
        self.engine = ScribeEngine(on_status=self._engine_status)
        self.realtime = RealtimeEngine(
            on_partial=self._on_realtime_partial,
            on_committed=self._on_realtime_committed,
            on_status=self._engine_status,
        )
        #: Sequence number for realtime results, so the UI replaces a partial
        #: with its committed text exactly as it does on the batch path.
        self._realtime_seq = 0
        self._realtime_started_at = 0.0
        self.capture = LoopbackCapture(self._on_audio, self._on_capture_event)
        self.segmenter = Segmenter(
            self._on_interim,
            self._on_final,
            self.config,
            on_speech_start=self._on_speech_start,
        )

        self._running = False
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._consumer: threading.Thread | None = None
        self._worker: threading.Thread | None = None
        self._wake = threading.Event()

        self._interim_job: tuple[int, np.ndarray] | None = None
        self._final_jobs: collections.deque[Segment] = collections.deque()
        self._model_dirty = True
        self._model_failures = 0
        self._last_model_error = ""
        self._interim_running = False
        #: Sentence-merge buffer. A finalized segment waits here briefly in case
        #: the speaker was only pausing mid-sentence.
        self._pending: dict | None = None
        #: Wall clock of the most recent speech onset, from the segmenter.
        self._last_onset = 0.0
        #: Wall clock of the last interim pass, for cloud throttling.
        self._last_interim_at = 0.0
        #: Running level of whoever we are actually listening to, in dBFS.
        self._speaker_dbfs: float | None = None
        self._speaker_dbfs_at = 0.0
        self._rtf = 0.0  # smoothed inference seconds per audio second, for display
        self._rtf_known = False
        #: Smoothed duration of ONE inference call, in seconds. This, not a
        #: real-time factor, is what determines whether an interim is affordable.
        self._inference_s = 0.0
        self._interim_finished_at = 0.0
        self._state = "idle"
        self._state_detail = ""
        self._no_audio = False
        self._behind = False

    @property
    def _streaming(self) -> bool:
        return self.config.stt_mode == "realtime"

    @property
    def _active(self):
        return self.realtime if self._streaming else self.engine

    # -- realtime callbacks ---------------------------------------------------

    def _on_realtime_partial(self, text: str) -> None:
        """Interim text, arriving while the person is still speaking."""
        self._emit({"type": "interim", "id": self._realtime_seq, "text": text})
        if self._state != "listening":
            self._set_state("listening")

    def _on_realtime_committed(self, text: str) -> None:
        """
        A sentence the service considers stable.

        Published in the same shape the batch path uses so the transcript panel,
        the question filter and the auto-answer trigger all work unchanged. The
        service performed the segmentation, so there is no local silence wait or
        queue time to report.
        """
        now = time.time()
        seq = self._realtime_seq
        self._realtime_seq += 1
        self._emit(
            {
                "type": "final",
                "id": seq,
                "text": text,
                "startedAt": round(self._realtime_started_at * 1000),
                "endedAt": round(now * 1000),
                "language": self.config.language,
                "avgLogprob": 0.0,
                "audioSeconds": max(0.0, now - self._realtime_started_at),
                "truncated": False,
                "fragments": 1,
                "mergeReason": "realtime commit",
                "silenceMs": 0,
                "queueMs": 0,
                "inferenceMs": 0,
                "latencyMs": 0,
                "rtf": 0.0,
            }
        )
        self._realtime_started_at = now

    # -- public API -----------------------------------------------------------

    @property
    def running(self) -> bool:
        return self._running

    def describe(self) -> dict:
        return {
            "running": self._running,
            "state": self._state,
            "language": self.config.language,
            "model": self.config.scribe_model,
            "englishOnly": False,
            "sttMode": self.config.stt_mode,
            "device": self._active.device,
            "computeType": self._active.compute_type,
            "deviceNote": self._active.device_note,
            "audioDevice": self.capture.device_name,
            "modelLoaded": self.engine.loaded,
        }

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
            self.config.running = True
            self._stop.clear()
            self._no_audio = False
            self.segmenter.reset()
            self.ring.clear()

            self._consumer = threading.Thread(target=self._consume, name="vad-consumer", daemon=True)
            self._worker = threading.Thread(target=self._work, name="asr-worker", daemon=True)
            self._consumer.start()
            self._worker.start()
            self.capture.start()

        self._set_state("model_loading")
        self._emit({"type": "state", **self.describe()})

    def stop(self) -> None:
        with self._lock:
            if not self._running:
                return
            self._running = False
            self.config.running = False
            self._stop.set()
            self._wake.set()
            self.ring.wake()

        self.realtime.stop()
        self.capture.stop()
        for thread in (self._consumer, self._worker):
            if thread and thread.is_alive():
                thread.join(timeout=4.0)
        self._consumer = None
        self._worker = None

        with self._lock:
            self._interim_job = None
            self._final_jobs.clear()
            self._pending = None
        self.segmenter.reset()
        self.ring.clear()
        self._set_state("idle")
        self._emit({"type": "state", **self.describe()})

    def apply_config(
        self,
        language: str | None,
        model: str | None,
        tuning: dict | None = None,
    ) -> None:
        changed_model = False
        if language:
            self.config.language = language
        if model and model != self.config.model:
            self.config.model = model
            changed_model = True
        if tuning and "apiKey" in tuning:
            # A new key deserves an immediate retry rather than waiting for the
            # user to find the Restart button.
            self._model_failures = 0
            self._model_dirty = True
            self._wake.set()
        if tuning and self.config.update_tuning(tuning):
            log.info(
                "tuning: segment_silence=%dms max_segment=%.1fs interim_every=%.2fs "
                "vad_min_silence=%dms vad_speech_pad=%dms merge_window=%dms",
                self.config.segment_silence_ms,
                self.config.max_segment_s,
                self.config.interim_interval_s,
                self.config.vad_min_silence_ms,
                self.config.vad_speech_pad_ms,
                self.config.merge_window_ms,
            )
        self.config.sanitized()

        if changed_model:
            with self._lock:
                self._model_dirty = True
                self._model_failures = 0
                self._interim_job = None
                self._final_jobs.clear()
                # A different model has a different cost; re-measure before
                # deciding whether interims are affordable again.
                self._rtf = 0.0
                self._rtf_known = False
            if self._running:
                self._set_state("model_loading")
            self._wake.set()

        self._emit({"type": "state", **self.describe()})

    def shutdown(self) -> None:
        self.stop()

    # -- callbacks ------------------------------------------------------------

    def _on_audio(self, block: np.ndarray) -> None:
        self.ring.write(block)

    def _on_speech_start(self, at: float) -> None:
        """
        Speech resumed. This is the signal the merge layer actually needs, and it
        arrives seconds before the corresponding transcription: by the time a
        held fragment's text exists we already know whether the speaker carried
        on, so the decision costs no extra waiting.
        """
        self._last_onset = at
        pending = self._pending
        if pending is None or pending.get("awaiting"):
            return
        if (at - pending["speech_ended_at"]) * 1000.0 <= self.config.merge_gap_ms:
            pending["awaiting"] = True

    def _on_capture_event(self, kind: str, payload: dict) -> None:
        if kind == "device":
            self._emit({"type": "audio_device", **payload})
            if self._state in ("idle", "no_audio", "error"):
                # `_active`, not `engine`: in realtime mode the batch engine is
                # never loaded, which would strand the state on model_loading.
                self._set_state("listening" if self._active.loaded else "model_loading")
        elif kind == "device_changed":
            self._emit(
                {
                    "type": "notice",
                    "message": "Default output device changed; reopening the loopback stream.",
                }
            )
            self.segmenter.reset()
            self.ring.clear()
        elif kind == "capture_error":
            message = payload.get("message", "audio capture failed")
            if payload.get("recovering"):
                # A reopen is already on its way; the "device" branch above puts
                # the state back to listening once it succeeds.
                detail = (
                    "The audio device rejected the current block size; "
                    "reopening with a larger one."
                    if payload.get("hostError")
                    else f"Audio capture hiccup ({message}); reopening."
                )
                self._emit({"type": "notice", "message": detail})
            else:
                self._set_state("error", message)

    def _engine_status(self, kind: str, payload: dict) -> None:
        if kind == "model_progress":
            self._emit({"type": "model_progress", **payload})
        elif kind == "model_loading":
            self._set_state("model_loading", payload.get("detail", payload.get("stage", "")))
            self._emit({"type": "model_loading", **payload})
        elif kind == "model_ready":
            self._emit({"type": "model_ready", **payload})
            if self._running:
                self._set_state("no_audio" if self._no_audio else "listening")
        elif kind == "engine_error":
            # Without this the UI sat on "listening" while the connection was
            # gone, so an exhausted quota looked exactly like silence.
            self._set_state("error", payload.get("message", "transcription failed"))

    def _on_interim(self, seq: int, audio: np.ndarray) -> None:
        with self._lock:
            if self._final_jobs:
                log.debug("interim skip seq=%d: final pending", seq)
                # A final is more valuable than an interim; skip rather than queue.
                return
            if self._interim_running:
                log.debug("interim skip seq=%d: previous still running", seq)
                # Never queue interims: if the previous pass is still decoding,
                # this one is dropped outright. Queuing them would push the next
                # final further behind for no benefit.
                return
            segment_seconds = audio.size / SAMPLE_RATE

            if segment_seconds < FIRST_INTERIM_AFTER_S:
                # Short phrases finalize shortly anyway; no point paying for a
                # preview. Long utterances must never wait, which is the case
                # this whole path exists for.
                return

            # Duty cycle: an interim may run only once at least one inference's
            # worth of time has passed since the last one finished. Finals
            # therefore always keep at least half the worker to themselves, and
            # a slow machine simply previews less often instead of not at all.
            gap = time.time() - self._interim_finished_at
            budget = self._inference_s * (1.0 / INTERIM_DUTY_CYCLE - 1.0)
            if self._inference_s > 0.0 and gap < budget:
                return

            # Every preview is a billable round trip; space them out.
            if time.time() - self._last_interim_at < CLOUD_INTERIM_MIN_SPACING_S:
                return

            self._last_interim_at = time.time()
            self._interim_job = (seq, audio)
        self._wake.set()

    def _is_background(self, segment: Segment) -> bool:
        """Short and much quieter than the speaker: background chatter."""
        if self._speaker_dbfs is None:
            return False
        if segment.duration > BACKGROUND_MAX_S:
            return False
        return segment.mean_dbfs < self._speaker_dbfs - BACKGROUND_DROP_DB

    def _note_speaker_level(self, segment: Segment) -> None:
        """Peak-with-decay, not an average: see SPEAKER_DECAY_DB_PER_S."""
        now = time.time()
        if self._speaker_dbfs is None:
            self._speaker_dbfs = segment.mean_dbfs
        else:
            decayed = self._speaker_dbfs - SPEAKER_DECAY_DB_PER_S * (now - self._speaker_dbfs_at)
            self._speaker_dbfs = max(decayed, segment.mean_dbfs)
        self._speaker_dbfs_at = now

    def _on_final(self, segment: Segment) -> None:
        # End-of-speech, emitted before inference starts so the app can kick off
        # work that overlaps with transcription. This runs on the consumer
        # thread and is a queue put — it adds no work to the inference worker.
        self._emit(
            {
                "type": "segment_closed",
                "id": segment.seq,
                "speechEndedAt": round(segment.speech_ended_at * 1000),
            }
        )
        if self._is_background(segment):
            log.info(
                "dropped undecoded seq=%d %.2fs at %.0f dBFS (speaker %.0f dBFS): background",
                segment.seq,
                segment.duration,
                segment.mean_dbfs,
                self._speaker_dbfs or -120.0,
            )
            self._emit({"type": "drop", "id": segment.seq})
            return

        # Long or loud enough to be the person we are listening to.
        if segment.duration > BACKGROUND_MAX_S:
            self._note_speaker_level(segment)

        with self._lock:
            self._final_jobs.append(segment)
            depth = len(self._final_jobs)
            if depth > QUEUE_MAX_DEPTH:
                self._final_jobs.popleft()
            self._interim_job = None
        self._wake.set()
        self._update_backlog(depth)

    # -- threads --------------------------------------------------------------

    def _consume(self) -> None:
        while not self._stop.is_set():
            frame = self.ring.read(FRAME_SAMPLES, timeout=0.25)
            now = time.time()
            if frame.size == 0:
                self._check_silence(now)
                self._check_merge_deadline(now)
                continue
            if self._streaming:
                # Straight to the websocket. The service runs its own VAD and
                # decides sentence boundaries, so none of the local segmentation
                # applies on this path.
                self.realtime.feed(frame)
                self._check_silence(now)
                continue

            self.segmenter.push(frame, now)
            self._check_silence(now)
            self._check_merge_deadline(now)
        self.segmenter.flush(time.time())
        self._flush_pending("shutdown")

    def _check_silence(self, now: float) -> None:
        last_loud = self.segmenter.last_loud_at
        silent = last_loud == 0.0 or (now - last_loud) > NO_AUDIO_AFTER_S
        if silent and not self._no_audio:
            self._no_audio = True
            if self._state == "listening":
                self._set_state("no_audio")
        elif not silent and self._no_audio:
            self._no_audio = False
            if self._state == "no_audio":
                self._set_state("listening")

    def _work(self) -> None:
        while not self._stop.is_set():
            if self._model_dirty:
                if not self._load_model():
                    # Back off, and stop retrying after a few attempts rather
                    # than looping on a broken download forever. Changing the
                    # model in settings or pressing Restart clears this.
                    self._model_failures += 1
                    if self._model_failures >= 3:
                        self._model_dirty = False
                        self._set_state(
                            "error",
                            f"{self._last_model_error}\n\n"
                            "Giving up after 3 attempts. Pick another model, or press "
                            "Restart engine to try again.",
                        )
                        continue
                    if self._stop.wait(min(2.0 * self._model_failures, 15.0)):
                        break
                    continue

            if self._streaming:
                # All recognition happens on the websocket thread.
                if self._stop.wait(0.25):
                    break
                continue

            if not self.engine.loaded:
                # Initialisation gave up (no key, rejected key, no network).
                # Draining here keeps the original, useful error on screen:
                # running jobs against an unconfigured engine only replaced it
                # with a meaningless "engine not initialised".
                with self._lock:
                    dropped = list(self._final_jobs)
                    self._final_jobs.clear()
                    self._interim_job = None
                for segment in dropped:
                    self._emit({"type": "drop", "id": segment.seq})
                if self._stop.wait(0.5):
                    break
                continue

            job_final: Segment | None = None
            job_interim: tuple[int, np.ndarray] | None = None
            with self._lock:
                # Skip anything that has gone stale while we were busy; the
                # conversation has moved on and decoding it only delays what is
                # being said now.
                while self._final_jobs:
                    candidate = self._final_jobs.popleft()
                    age = time.time() - candidate.closed_at
                    if age <= STALE_SEGMENT_S:
                        job_final = candidate
                        break
                    log.info(
                        "dropped stale seq=%d after %.1fs in the queue",
                        candidate.seq,
                        age,
                    )
                    self._emit({"type": "drop", "id": candidate.seq})
                if job_final is None and self._interim_job is not None:
                    job_interim = self._interim_job
                    self._interim_job = None
                    self._interim_running = True

            if job_final is None and job_interim is None:
                self._wake.wait(0.2)
                self._wake.clear()
                continue

            try:
                if job_final is not None:
                    self._run_final(job_final)
                elif job_interim is not None:
                    self._run_interim(*job_interim)
            except Exception as exc:  # noqa: BLE001
                # There is no local fallback any more: a failed request costs
                # that segment and is reported, rather than silently vanishing.
                log.warning("transcription failed: %s", exc)
                self._set_state("error", f"{type(exc).__name__}: {exc}")
            finally:
                if job_interim is not None:
                    with self._lock:
                        self._interim_running = False
                        self._interim_finished_at = time.time()

            with self._lock:
                depth = len(self._final_jobs)
            self._update_backlog(depth)

    def _load_model(self) -> bool:
        try:
            if self._streaming:
                from .scribe_engine import api_key as resolve_key

                self.realtime.stop()
                self.realtime.api_key = resolve_key(self.config.api_key)
                self.realtime.model = self.config.realtime_model
                self.realtime.language = {"en": "eng", "ur": "urd", "hi": "hin"}.get(
                    self.config.language or "", ""
                ) or None
                self.realtime.keyterms = keyterms_from(self.config.vocabulary)
                self.realtime.filter_background_audio = self.config.filter_background_audio
                self.realtime.vad_silence_secs = self.config.segment_silence_ms / 1000.0
                self._realtime_started_at = time.time()
                self.realtime.start()
                self._model_dirty = False
                self._model_failures = 0
                self._set_state("listening")
                return True

            self.engine.configured_key = self.config.api_key
            self.engine.ensure_model(self.config.scribe_model)
            self._model_dirty = False
            self._model_failures = 0
            return True
        except EngineUnavailable as exc:
            self._last_model_error = str(exc)
        except Exception as exc:  # noqa: BLE001
            self._last_model_error = f"engine unavailable: {type(exc).__name__}: {exc}"
        self._set_state("error", self._last_model_error)
        return False

    def _observe_inference(self, inference_seconds: float) -> None:
        """Smoothed cost of a single inference call, the interim budget basis."""
        if inference_seconds <= 0:
            return
        self._inference_s = (
            inference_seconds
            if self._inference_s == 0.0
            else 0.7 * self._inference_s + 0.3 * inference_seconds
        )

    def _observe_rtf(
        self,
        audio_seconds: float,
        inference_seconds: float,
        is_final: bool = True,
    ) -> None:
        """
        Exponentially smoothed inference-seconds-per-audio-second.

        Only finals set `_rtf_known`: an interim's own cost should not be what
        unlocks interims.
        """
        if audio_seconds <= 0:
            return
        self._observe_inference(inference_seconds)
        sample = inference_seconds / audio_seconds
        self._rtf = sample if self._rtf == 0.0 else (0.7 * self._rtf + 0.3 * sample)
        if is_final:
            self._rtf_known = True

    def _run_interim(self, seq: int, audio: np.ndarray) -> None:
        started = time.monotonic()
        result = self.engine.transcribe(
            audio,
            language=self.config.effective_language(),
            interim=True,
            vocabulary=self.config.vocabulary,
        )
        inference = time.monotonic() - started
        self._observe_rtf(audio.size / SAMPLE_RATE, inference, is_final=False)
        log.info(
            "interim seq=%d audio=%.2fs infer=%dms rtf=%.2f",
            seq,
            audio.size / SAMPLE_RATE,
            round(inference * 1000),
            self._rtf,
        )
        if result is None:
            log.debug("interim seq=%d dropped by the confidence filter", seq)
            return
        self._emit({"type": "interim", "id": seq, "text": result.text})

    def _run_final(self, segment: Segment) -> None:
        """
        Runs the final pass and reports the full latency breakdown.

        The three components, measured from the last frame that contained speech:
          silence  — the segmenter waiting out `segment_silence_ms`
          queue    — time the closed segment spent waiting for the worker
          infer    — faster-whisper itself
        `total` is what the user actually experiences: end of speech to text.
        """
        inference_started = time.monotonic()
        queue_wait = max(0.0, time.time() - segment.closed_at)

        result = self.engine.transcribe(
            segment.audio,
            language=self.config.effective_language(),
            interim=False,
            vocabulary=self.config.vocabulary,
        )

        inference = time.monotonic() - inference_started
        now = time.time()
        silence_wait = max(0.0, segment.closed_at - segment.speech_ended_at)
        total = max(0.0, now - segment.speech_ended_at)
        audio_seconds = segment.audio.size / SAMPLE_RATE
        self._observe_rtf(audio_seconds, inference)

        log.info(
            "final seq=%d audio=%.2fs | silence=%dms queue=%dms infer=%dms "
            "=> total=%dms | rtf=%.2f %s",
            segment.seq,
            audio_seconds,
            round(silence_wait * 1000),
            round(queue_wait * 1000),
            round(inference * 1000),
            round(total * 1000),
            self._rtf,
            "(dropped)" if result is None else "",
        )

        if result is None:
            # Nothing usable in this segment — retract any interim shown for it.
            self._emit({"type": "drop", "id": segment.seq})
            return

        fresh = {
            "seq": segment.seq,
            "audio": segment.audio,
            "text": result.text,
            "language": result.language,
            "avg_logprob": result.avg_logprob,
            "started_at": segment.started_at,
            "ended_at": segment.ended_at,
            "speech_ended_at": segment.speech_ended_at,
            "truncated": segment.truncated,
            "fragments": 1,
            "first_result_at": now,
            "silence_ms": round(silence_wait * 1000),
            "queue_ms": round(queue_wait * 1000),
            "inference_ms": round(inference * 1000),
        }

        pending = self._pending
        if pending is None:
            self._publish_or_hold(fresh)
            return

        if not self._is_continuation(pending, fresh):
            # Genuinely a new sentence: publish the held one and start again.
            self._flush_pending("new sentence")
            self._publish_or_hold(fresh)
            return

        self._merge(pending, fresh)

    def _merge(self, pending: dict, fresh: dict) -> None:
        """
        Joins a held fragment with the one that followed it.

        The combined *audio* is re-transcribed rather than the two text results
        being concatenated: the whole point is to give Whisper the full sentence
        as context. Stitching the strings together would preserve exactly the
        mistakes the merge exists to fix.
        """
        combined_audio = np.concatenate([pending["audio"], fresh["audio"]])
        combined_seconds = combined_audio.size / SAMPLE_RATE
        started = time.monotonic()

        result = self.engine.transcribe(
            combined_audio,
            language=self.config.effective_language(),
            interim=False,
            vocabulary=self.config.vocabulary,
        )
        inference = time.monotonic() - started
        self._observe_rtf(combined_seconds, inference)

        if result is None:
            # The re-run found nothing usable; keep the fragments we already had
            # rather than losing them.
            merged_text = f"{pending['text'].rstrip()} {fresh['text'].lstrip()}".strip()
            language = pending["language"]
            avg_logprob = min(pending["avg_logprob"], fresh["avg_logprob"])
        else:
            merged_text = result.text
            language = result.language
            avg_logprob = result.avg_logprob

        log.info(
            "merge seq=%d+%d audio=%.2fs infer=%dms -> %s",
            pending["seq"],
            fresh["seq"],
            combined_seconds,
            round(inference * 1000),
            merged_text[:80],
        )

        merged = {
            **pending,
            "audio": combined_audio,
            "text": merged_text,
            "language": language,
            "avg_logprob": avg_logprob,
            "ended_at": fresh["ended_at"],
            "speech_ended_at": fresh["speech_ended_at"],
            "truncated": pending["truncated"] or fresh["truncated"],
            "fragments": pending["fragments"] + 1,
            "inference_ms": pending["inference_ms"] + round(inference * 1000),
            "silence_ms": fresh["silence_ms"],
            "queue_ms": fresh["queue_ms"],
            "awaiting": False,
        }
        self._publish_or_hold(merged)


    # -- sentence merge -------------------------------------------------------

    def _ends_sentence(self, text: str) -> bool:
        return text.rstrip().endswith(tuple(TERMINAL_PUNCTUATION))

    def _is_continuation(self, pending: dict, fresh: dict) -> bool:
        """
        Decides whether `fresh` continues the sentence held in `pending`.

        Punctuation alone does not work here. Whisper adds a full stop to nearly
        every segment it returns, including ones cut mid-sentence — measured on
        this machine, a deliberate one-second pause produced "We need a scalable
        application." and "That can handle the throughput.", both punctuated. So
        missing punctuation implies continuation, but its presence proves nothing.

        The silence between the two utterances is the signal that actually
        separates a breath from a sentence boundary.
        """
        if not self._ends_sentence(pending["text"]):
            return True
        gap = max(0.0, fresh["started_at"] - pending["speech_ended_at"])
        return gap * 1000.0 <= self.config.merge_gap_ms

    def _check_merge_deadline(self, now: float) -> None:
        """
        Publishes a held sentence once it is certain no continuation is coming.

        Two clocks, and the distinction matters:

          * `merge_gap_ms` after end of speech we know whether the speaker
            resumed — the segmenter tells us at onset, long before that audio has
            been transcribed. If nobody resumed, publish.
          * if somebody did resume, wait for that fragment's text to arrive and
            merge it. `merge_max_s` is the safety net for the case where the
            continuation is dropped as noise and no result ever comes.
        """
        pending = self._pending
        if pending is None:
            return

        if pending.get("awaiting"):
            if now >= pending["speech_ended_at"] + self.config.merge_max_s:
                self._flush_pending("continuation never arrived")
            return

        if now * 1000.0 >= pending["deadline_ms"]:
            self._flush_pending("no continuation")

    def _flush_pending(self, reason: str) -> None:
        """Emits the held sentence as a single final result."""
        pending = self._pending
        if pending is None:
            return
        self._pending = None

        audio_seconds = pending["audio"].size / SAMPLE_RATE
        now = time.time()
        total = max(0.0, now - pending["speech_ended_at"])
        log.info(
            "merged seq=%d fragments=%d audio=%.2fs (%s) => total=%dms",
            pending["seq"],
            pending["fragments"],
            audio_seconds,
            reason,
            round(total * 1000),
        )

        self._emit(
            {
                "type": "final",
                "id": pending["seq"],
                "text": pending["text"],
                "startedAt": round(pending["started_at"] * 1000),
                "endedAt": round(pending["ended_at"] * 1000),
                "language": pending["language"],
                "avgLogprob": round(pending["avg_logprob"], 3),
                "audioSeconds": round(audio_seconds, 2),
                "truncated": pending["truncated"],
                "fragments": pending["fragments"],
                "mergeReason": reason,
                "silenceMs": pending["silence_ms"],
                "queueMs": pending["queue_ms"],
                "inferenceMs": pending["inference_ms"],
                "mergeMs": round(max(0.0, now - pending["first_result_at"]) * 1000),
                "latencyMs": round(total * 1000),
                "rtf": round(self._rtf, 2),
            }
        )

    def _hold(self, pending: dict) -> None:
        """Holds the sentence and shows its text as provisional."""
        # Measured from end of speech, not from now: the question is whether the
        # speaker resumed, which is a fact about the audio timeline.
        pending["deadline_ms"] = (
            pending["speech_ended_at"] + self.config.merge_gap_ms / 1000.0
        ) * 1000.0
        # A continuation may already have started while this was being decoded.
        # Recomputed every time, never inherited: after a merge the relevant gap
        # is the one after the *new* end of speech. Carrying the old value over
        # left merged sentences waiting for the safety timeout.
        gap_ms = (self._last_onset - pending["speech_ended_at"]) * 1000.0
        pending["awaiting"] = 0 < gap_ms <= self.config.merge_gap_ms
        log.debug(
            "hold seq=%d gap_to_next_onset=%dms threshold=%dms awaiting=%s",
            pending["seq"],
            round(gap_ms),
            self.config.merge_gap_ms,
            pending["awaiting"],
        )
        self._pending = pending
        # Provisional: the panel replaces this with the merged final on flush, so
        # the text is visible immediately rather than after the merge window.
        self._emit({"type": "interim", "id": pending["seq"], "text": pending["text"]})

    def _publish_or_hold(self, pending: dict) -> None:
        """
        Decides whether a fresh result can be published straight away.

        Everything is held for the merge window, even text that looks complete —
        see `_is_continuation` for why trailing punctuation cannot be trusted as
        an end-of-sentence signal. A zero merge window disables the feature.

        Holding costs no *visible* latency: the text is shown immediately as
        provisional and replaced in place when the window closes.
        """
        if self.config.merge_window_ms <= 0:
            self._pending = pending
            self._flush_pending("merging disabled")
            return
        if pending["audio"].size / SAMPLE_RATE >= self.config.merge_max_s:
            self._pending = pending
            self._flush_pending("hard cap")
            return
        self._hold(pending)

    # -- status ---------------------------------------------------------------

    def _set_state(self, state: str, detail: str = "") -> None:
        # Deduplicated on (state, detail): a model that fails to download retries
        # on a timer, and repeating the same error every two seconds would just
        # spam the UI.
        if state == self._state and detail == self._state_detail:
            return
        self._state = state
        self._state_detail = detail
        self._emit({"type": "status", "state": state, "detail": detail})

    def _update_backlog(self, depth: int) -> None:
        behind = depth >= QUEUE_WARN_DEPTH
        if behind != self._behind:
            self._behind = behind
            self._emit({"type": "backlog", "pending": depth, "behind": behind})
