"""Runtime configuration for the transcription sidecar."""

from __future__ import annotations

from dataclasses import dataclass, field

# --- audio -------------------------------------------------------------------

SAMPLE_RATE = 16000
"""Everything downstream of the resampler runs at 16 kHz mono float32."""

FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000

RING_SECONDS = 30
"""Rolling in-memory buffer. Audio is never written to disk."""

# --- segmentation ------------------------------------------------------------

PRE_ROLL_MS = 300
"""Audio kept before speech onset so the first phoneme is not clipped."""

SPEECH_ONSET_FRAMES = 3
MIN_SEGMENT_MS = 260

# Latency defaults. These are the shipped values; the app overrides them live
# through the `config` message, so the settings UI is the source of truth.
#
# SILENCE_END_MS is the single biggest lever on end-of-speech latency: it is how
# long we wait after the last speech frame before deciding the sentence is over.
# faster-whisper's own `vad_*` values below do NOT affect this — they only trim
# silence inside the chunk we already cut.
# Raised from 350: a 350 ms threshold splits ordinary mid-sentence pauses, which
# both fragments the transcript and robs Whisper of the context it needs to get
# domain words right ("scalable application" -> "SK label").
SILENCE_END_MS = 700
# Matched to the merge cap below so the segmenter stops cutting mid-sentence and
# the merge layer only has to handle genuine pause-separated fragments.
MAX_SEGMENT_S = 12.0
INTERIM_INTERVAL_S = 0.7
VAD_MIN_SILENCE_MS = 700
VAD_SPEECH_PAD_MS = 100

# --- sentence merge ----------------------------------------------------------
# A finalized segment is held briefly before being published. If the next segment
# arrives inside the window and the held text has no terminal punctuation, the two
# are joined and re-transcribed *from the combined audio* — re-running the
# recognizer on the whole sentence is the point; concatenating the two text
# results would keep the same bad guesses.
MERGE_WINDOW_MS = 900
MERGE_MAX_S = 12.0
TERMINAL_PUNCTUATION = ".?!"

# Whisper punctuates almost every segment it returns, adding a full stop whether
# or not the speaker had finished — measured: a deliberate mid-sentence pause
# yields "We need a scalable application." / "That can handle the throughput.",
# both with terminal punctuation. So absent punctuation is a usable *positive*
# signal for continuation, but its presence proves nothing.
#
# The reliable signal is the silence between the two utterances. Anything shorter
# than this is treated as a mid-sentence breath rather than a sentence boundary.
MERGE_GAP_MS = 1500

DEFAULT_VOCABULARY = (
    "Azure, Kubernetes, Docker, API, endpoint, latency, scalable, scalability, "
    "microservices, deployment, pipeline, repository, database, authentication, "
    "middleware, throughput, caching, load balancer."
)
"""
Domain-vocabulary bias, sent to the API as `keyterms`. Makes these spellings far
likelier than acoustically similar alternatives — this is what stops "scalable
application" arriving as "SK label". Editable in settings; add your own project
and service names.
"""

# Interim passes compete with finals for the single worker. Above this real-time
# factor (inference seconds per audio second) they are skipped entirely, because
# a running interim delays the final that actually matters.
#
# Worth knowing: Whisper always encodes a fixed 30-second mel window, so a single
# inference costs roughly the same whether the segment is 1 second or 6. An
# interim is therefore just as expensive as the final it delays — which is why
# this guard exists at all, and why interims are measured against finals rather
# than assumed to be cheap.
# Every preview is a billable round trip of ~1.6-1.9 s, so previews are spaced by
# wall clock rather than by any measure of local compute. Lower = more live but
# more expensive; 0 disables previews entirely and only finals are shown.
INTERIM_DUTY_CYCLE = 0.5

# A preview is only worth its cost once there is enough speech to be readable.
FIRST_INTERIM_AFTER_S = 1.0

# Minimum wall-clock spacing between interim passes when a *paid* cloud engine is
# active. Each interim is a separate billable request, so they are throttled well
# below the local rate.
CLOUD_INTERIM_MIN_SPACING_S = 1.5

NO_AUDIO_AFTER_S = 10.0
"""Report 'no audio detected' after this long below the silence floor."""

ABSOLUTE_SILENCE_DBFS = -72.0

# --- recognition -------------------------------------------------------------



LANGUAGES = ("en", "ur", "hi", "auto")

SCRIBE_MODEL = "scribe_v1"
REALTIME_MODEL = "scribe_v2_realtime"

# Streaming vs one request per sentence.
#
#   realtime  a persistent websocket; text appears while the person is still
#             talking. Measured median ~1.0 s from word spoken to word on screen.
#   batch     POST each VAD-cut segment. Measured 2-3 s, and nothing appears
#             until the sentence is over.
#
# Realtime also runs its own voice-activity detection and sentence commitment,
# so the local segmenter, merge layer and background rejection are bypassed
# entirely on that path.
STT_MODES = ("realtime", "batch")
DEFAULT_STT_MODE = "realtime"

MAX_NO_SPEECH_PROB = 0.62
MIN_AVG_LOGPROB = -1.0
MAX_COMPRESSION_RATIO = 2.5

QUEUE_WARN_DEPTH = 3
# Deep queues are worse than dropped audio here: a segment decoded 30 s late is
# useless, and while it decodes it blocks the sentence the user is waiting for.
QUEUE_MAX_DEPTH = 6

# --- background-chatter rejection -------------------------------------------
# Decoding costs ~2 s whatever the segment contains, so background murmur must be
# rejected BEFORE inference, not by the confidence filter afterwards. Otherwise a
# noisy caller fills the worker with junk and the real question queues behind it.
#
# A segment is dropped undecoded when it is both short AND much quieter than the
# speaker we have been hearing.
# A segment that has been waiting longer than this is discarded undecoded. In a
# live overlay, text that arrives 20 s late is not merely useless — decoding it
# blocks the sentence being spoken right now. Bounding the age bounds the worst
# case latency no matter how noisy the room gets.
STALE_SEGMENT_S = 8.0

BACKGROUND_DROP_DB = 12.0
BACKGROUND_MAX_S = 1.4
# The speaker level tracks the PEAK of recent speech and decays slowly, rather
# than averaging. Averaging lets quiet background chatter drag the reference down
# to its own level, after which nothing is ever classified as background.
SPEAKER_DECAY_DB_PER_S = 0.5

# Phrases Whisper emits over silence or music. Only dropped when the segment is
# also short or low-confidence, so a genuine "thank you" survives.
HALLUCINATION_PHRASES = {
    "thank you.",
    "thank you",
    "thanks for watching!",
    "thanks for watching.",
    "thank you for watching.",
    "you",
    "bye.",
    "bye bye.",
    ".",
    "subtitles by the amara.org community",
    "subs by www.zeoranger.co.uk",
    "please subscribe to my channel",
    "شکریہ",
    "धन्यवाद",
}


@dataclass
class RuntimeConfig:
    """Settings the app can change at runtime over the WebSocket."""

    language: str = "en"
    running: bool = False
    scribe_model: str = SCRIBE_MODEL
    realtime_model: str = REALTIME_MODEL
    stt_mode: str = DEFAULT_STT_MODE
    #: Passed to the service's own VAD when streaming.
    filter_background_audio: bool = True
    #: Set from the app's settings. The ELEVENLABS_API_KEY environment variable
    #: takes precedence when both are present.
    api_key: str = ""

    # Live-tunable latency knobs (see the comments on the constants above).
    segment_silence_ms: int = SILENCE_END_MS
    max_segment_s: float = MAX_SEGMENT_S
    interim_interval_s: float = INTERIM_INTERVAL_S
    vad_min_silence_ms: int = VAD_MIN_SILENCE_MS
    vad_speech_pad_ms: int = VAD_SPEECH_PAD_MS
    merge_window_ms: int = MERGE_WINDOW_MS
    merge_max_s: float = MERGE_MAX_S
    merge_gap_ms: int = MERGE_GAP_MS
    vocabulary: str = DEFAULT_VOCABULARY

    extra: dict = field(default_factory=dict)

    def update_tuning(self, payload: dict) -> bool:
        """Applies a tuning patch; returns True if anything changed."""
        mapping = {
            "segmentSilenceMs": ("segment_silence_ms", int, 150, 1500),
            "vadMinSilenceMs": ("vad_min_silence_ms", int, 100, 1500),
            "vadSpeechPadMs": ("vad_speech_pad_ms", int, 0, 500),
            "maxSegmentSeconds": ("max_segment_s", float, 2.0, 15.0),
            "interimIntervalSeconds": ("interim_interval_s", float, 0.3, 5.0),
            "mergeWindowMs": ("merge_window_ms", int, 0, 5000),
            "mergeMaxSeconds": ("merge_max_s", float, 2.0, 60.0),
            "mergeGapMs": ("merge_gap_ms", int, 0, 5000),
        }
        changed = False
        for key, (attr, cast, low, high) in mapping.items():
            if key not in payload or payload[key] is None:
                continue
            try:
                value = cast(payload[key])
            except (TypeError, ValueError):
                continue
            value = max(low, min(high, value))
            if getattr(self, attr) != value:
                setattr(self, attr, value)
                changed = True
        if payload.get("sttMode") in STT_MODES and self.stt_mode != payload["sttMode"]:
            self.stt_mode = payload["sttMode"]
            changed = True
        if isinstance(payload.get("filterBackgroundAudio"), bool):
            if self.filter_background_audio != payload["filterBackgroundAudio"]:
                self.filter_background_audio = payload["filterBackgroundAudio"]
                changed = True
        if "apiKey" in payload and isinstance(payload["apiKey"], str):
            if self.api_key != payload["apiKey"]:
                self.api_key = payload["apiKey"]
                changed = True
        if "vocabulary" in payload and isinstance(payload["vocabulary"], str):
            value = payload["vocabulary"].strip()
            if value != self.vocabulary:
                self.vocabulary = value
                changed = True
        return changed

    def effective_language(self) -> str | None:
        """None asks the API to detect the language."""
        return None if self.language == "auto" else self.language

    def sanitized(self) -> "RuntimeConfig":
        if self.language not in LANGUAGES:
            self.language = "en"
        return self
