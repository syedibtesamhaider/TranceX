# Private Overlay

A frameless, always-on-top overlay for Windows that is **excluded from screen
capture** — visible on the physical monitor, absent from Teams/Zoom shares, OBS
captures and the Snipping Tool.

It shows a **live transcript of your system audio** — what the other people in a
call are saying — transcribed by the ElevenLabs Scribe API, and can optionally
**auto-answer questions** it hears by streaming a reply from an LLM.

**Transcription is not local.** Captured audio is uploaded to the ElevenLabs API,
one request per sentence. Auto-answer, if enabled, additionally sends the detected
question to an LLM provider. No telemetry, no analytics, no auto-update. See
[PROVIDERS.md](PROVIDERS.md) and the Privacy section below.

---

## Requirements

- Windows 10 build **19041** (version 2004) or newer — this is where
  `WDA_EXCLUDEFROMCAPTURE` was introduced. On older builds the app starts, shows a
  warning dialog, and the overlay **will be visible in capture**.
- Node.js 20+ and npm (for development / building only).
- **Python 3.11** for the audio-capture sidecar in development (PyAudioWPatch has
  no wheels for 3.12+). The packaged build needs no Python at all.
- An **ElevenLabs API key** — transcription does not work without one.
- No GPU required.

## Run in dev mode

```bash
npm install
npm run setup:sidecar   # once — creates sidecar/.venv on Python 3.11
npm run dev
```

`setup:sidecar` uses [uv](https://docs.astral.sh/uv/) when it is on PATH and falls
back to the `py` launcher. Without it the app still runs and reports the missing
sidecar in the transcript panel.

`npm run dev` compiles TypeScript and launches Electron with devtools enabled and
renderer console output forwarded to the terminal.

Plain `npm start` does the same without dev extras.

> The launcher (`scripts/start.mjs`) strips `ELECTRON_RUN_AS_NODE` from the
> environment before spawning Electron. Some hosts (VS Code's integrated terminal,
> certain CI runners) export that variable, which makes `electron.exe` boot as a
> plain Node process and crash on startup.

## Build a portable .exe

```bash
sidecar\.venv\Scripts\python.exe -m pip install -r sidecar/requirements-build.txt  # once
npm run build:sidecar   # PyInstaller bundle of the Python sidecar (~300 MB)
npm run dist            # portable .exe containing the overlay + sidecar
```

Produces `release/PrivateOverlay-1.0.0-portable.exe` — a single self-contained
file, no installer, no admin rights, no Python needed on the target machine.

Other targets:

| Command | Output | When |
| --- | --- | --- |
| `npm run dist` | one portable `.exe` | handing it to someone else |
| `npm run dist:dir` | `release/win-unpacked/` folder | **day-to-day use** |
| `npm run dist:app-only` | portable `.exe`, no sidecar | overlay shell only |

**Use `dist:dir` for yourself.** A portable `.exe` re-extracts its entire payload
to `%TEMP%` on *every* launch; with the sidecar inside that is ~350 MB and a
10–30 second cold start each time. The unpacked folder starts instantly.

Whisper models are never bundled — they download on first use into
`%APPDATA%\PrivateOverlay\models\`.

The `koffi` native module is unpacked out of the asar archive
(`asarUnpack` in `package.json`) so its `.node` binary can be loaded at runtime.

## Verifying the capture exclusion

```bash
npm run selftest
```

Starts the app, reads the display affinity back from Windows, prints it as JSON
and exits. A healthy result contains `"affinity":17` (0x11) and `"applied":true`.

The same flag works on the packaged binary, which writes its report to
`%TEMP%\private-overlay-selftest.json` because a Windows GUI .exe has no stdout:

```powershell
.\release\PrivateOverlay-1.0.0-portable.exe --selftest
Get-Content "$env:TEMP\private-overlay-selftest.json"
```

For the manual end-to-end checks (Teams, OBS, Win+Shift+S), see **[VERIFY.md](VERIFY.md)**.

---

## Using it

| Action | How |
| --- | --- |
| Show / hide | `Ctrl+Shift+Space` (configurable) |
| Start / stop transcription | `Ctrl+Shift+T` (configurable), or the Start button |
| Look up the last line | `Ctrl+Shift+A` (configurable) |
| Pause auto-answer 5 min | `Ctrl+Shift+P` (configurable) |
| Quit | `Ctrl+Shift+Q` (configurable), or right-click → Quit |
| Right-click menu | Settings… and Quit, on the overlay itself |
| Move | Drag the title strip |
| Resize | Drag the window edges (minimum 250×200) |
| Hide | `Esc`, or the `✕` in the overlay title strip |
| Settings | `⚙` in the overlay, or right-click → Settings… |

**There is no tray icon.** The app does not appear in the notification area at all,
which also means there is no visible way back if you forget the hotkey. Two
escape hatches: `Ctrl+Shift+Space` shows it, and launching a second copy reveals
the running one rather than starting another.

The right-click menu is drawn in HTML inside the overlay rather than using
Electron's native `Menu.popup()`. A native popup is its own top-level window and
would not carry `WDA_EXCLUDEFROMCAPTURE` — it would appear in a screen share.

The overlay does not appear in the taskbar or in Alt+Tab. Position, size,
visibility, opacity, hotkeys, always-on-top and the transcription settings are
saved to `%APPDATA%\PrivateOverlay\config.json` and restored on the next launch.
That file is the **only** thing this app writes, apart from downloaded models.

The small dot in the overlay's title strip is the live protection indicator:
green = excluded from capture, amber = **not** excluded. It re-checks every few
seconds. Settings shows the raw affinity value, the Windows build and how the flag
was applied.

## Live transcription

Captures **system audio** — the remote participants in a Teams/Zoom call, a video,
anything coming out of your speakers — via WASAPI loopback on the default output
device. **Your microphone is never opened.** Nothing you say is transcribed.

### Using it

Press **Start**, or use the global hotkey `Ctrl+Shift+T`. Transcription never
starts by itself: there is deliberately
no persisted "was running" flag, so launching the app never begins capturing audio
without an explicit action.

| Control | Effect |
| --- | --- |
| Start / Stop | opens or releases the audio device |
| Copy | copies the whole visible transcript to the clipboard |
| Clear | wipes the in-memory transcript |
| A− / A+ | transcript text size |
| `Ctrl+Shift+T` | start/stop from anywhere (configurable) |

Scrolling up pins the view and stops auto-scroll; a **Jump to latest** button
appears. Scrolling back to the bottom re-arms it.

The status dot reads: `stopped`, `starting`, `loading model…`, `listening`,
`no audio detected` (nothing above the silence floor for 10s), or `error`. If the
sidecar dies, the error and its last stderr lines appear in the panel with a
**Restart engine** button — it never fails silently.

### Recognition engine

All transcription runs through the **ElevenLabs Scribe API**. There is no local
model: the faster-whisper engine, ctranslate2, onnxruntime, the CUDA runtime and
the model weights were all removed, which took the sidecar's dependency tree from
**2.3 GB to 4.2 MB**.

What that costs, measured rather than assumed:

| | value |
| --- | --- |
| Round trip, 4 s segment | **1.6–1.9 s** |
| End-of-speech to text, observed | **3.4–4.1 s** |
| Works offline | **no** |
| Billing | per request, previews included |
| GPU required | none |

**There is no streaming endpoint** — the REST API is batch only. Every preview and
every final is a separate round trip, so ~2.5 s is the floor on how quickly text
can appear and no tuning moves it. If you need text faster than that, the only
answer is a local model, which is what was removed.

There is also **no fallback**. A network failure or a rejected key means no
transcript, reported as an error with a Restart button rather than silence.

### Domain vocabulary

Settings → Transcription → **Domain vocabulary** is sent to the API as
`keyterms`, which biases recognition toward those spellings. This is the single
most effective fix for domain-word errors — it is what stops "scalable
application" arriving as "SK label". Add your own project and service names;
comma-separated, up to about a hundred terms. Applies live.

### Language

`en` (default), `ur`, `hi`, or `auto` for Whisper's own detection. Switchable at
runtime — no restart, no model reload.

### Live text while someone is still speaking

The panel updates *during* an utterance rather than only when it ends. Dim
italic text is a preview of the sentence in progress; it is replaced in place by
the finalized line.

Three mechanisms make that hold up in a noisy call:

**End of speech is detected as a relative drop, not an absolute level.** Once
someone is speaking, the segment closes when the level falls well below *that
speaker* (`SPEECH_DROP_DB`, 10 dB). An absolute threshold never falls below a
noisy line, which is why a caller with a fan or an open office used to produce
nothing at all until they muted — the segment stayed open until the 12-second
cap.

**Preview frequency adapts to the machine, by time not ratio.** An interim pass
may run once the gap since the last one is at least as long as one inference
(`INTERIM_DUTY_CYCLE`), so finals always keep half the worker. A slow machine
previews less often rather than not at all.

> This replaced a real-time-factor gate, which was measuring the wrong thing.
> Inference cost is per *call*, not per second of audio — Whisper always encodes
> a fixed 30-second window — so a 0.7-second segment reported an "RTF" of 5 and
> silently disabled previews on hardware that was comfortably fast enough.

**Stale work is discarded, not processed.** A segment that has waited longer than
`STALE_SEGMENT_S` (8 s) is dropped undecoded: text that arrives 20 seconds late is
not merely useless, decoding it blocks the sentence being spoken now. Together
with a shallow queue this bounds worst-case latency however noisy the room gets.

Background murmur that is both short and much quieter than the current speaker
(`BACKGROUND_MAX_S`, `BACKGROUND_DROP_DB`) is rejected *before* inference, since
decoding costs the same whatever the audio contains.

**What this does not fix:** another person talking clearly in the background is
speech, and it will be transcribed. No voice-activity detector can separate two
speakers — that needs diarization, which is a different model.

### Latency: where the time goes

Every finalized segment reports its own breakdown, both to the sidecar log and to
Settings → Latency tuning:

```
final seq=4 audio=3.10s | silence=352ms queue=8ms infer=980ms => total=1344ms | rtf=0.32
```

- **silence** — the segmenter waiting out `segmentSilenceMs` after the last speech
  frame. This is the floor: you cannot get text before the app has decided the
  sentence ended.
- **queue** — how long the closed segment waited for the worker. Non-zero means
  something else was decoding; persistent values here mean you are falling behind.
- **infer** — the ElevenLabs round trip. Network-bound, ~1.6-1.9 s for a 4 s segment.
- **total** — end of speech to text on screen. The number that matters.

`segmentSilenceMs` is the only VAD setting that moves `total` directly. The two
`vad*` settings only trim silence *inside* an already-cut chunk, which shortens
the upload slightly but cannot reduce `silence`. This trips people up constantly,
hence both being exposed separately.

### Privacy

**Transcription sends your call audio to a third party. This is not optional any
more** — the local engine was removed, so ElevenLabs receives one WAV per spoken
sentence (~130 KB per 4 seconds). Silence is never uploaded: the local VAD cuts it
out first, so a meeting costs far less audio-time than its wall-clock duration.

**Auto-answer changes this app's privacy posture too, so read this before enabling it.**

With auto-answer **off** (the default), nothing leaves the machine after the
model download. With it **on**, each detected question — one transcript segment,
4 to 30 words of somebody else's speech — is sent to the provider you configured,
under their terms and retention policy. Never the whole transcript, never audio,
never window content. If you want the capability without a third party, point it
at a local Ollama (see PROVIDERS.md).

The API key is the single exception to the in-memory-only rule: stored in plain
text in `config.json` unless you set `OVERLAY_LLM_API_KEY` instead. It is never
sent to the renderer — Settings writes it through a dedicated channel and reads
back only a boolean.

Answers themselves are in-memory only, capped at 5 entries, and cleared on quit.

- The transcript exists **only in the renderer's memory**. It is never written to
  disk, never logged, never cached, and is not kept in the main process either.
- Audio is held in a 30-second rolling in-memory ring buffer and never written
  anywhere.
- **Copy** is the only route by which transcript text leaves the app.
- The transcript is cleared on quit and when you press Clear.
- The sidecar's stdout carries exactly one line — its port. Recognized text never
  goes near it.
- The sidecar listens on `127.0.0.1` on a random free port and requires a 32-byte
  token that is passed through the environment, not argv (command lines are
  readable by other processes on Windows). Unauthenticated connections are closed
  with code 1008.

Recording or transcribing other people may require their consent depending on
where you are; that call is yours.

### Diagnostics

```bash
npm run sidecar:probe     # compute path + loopback device selection
npm run sidecar:devices   # every WASAPI loopback device it can see
```

## Auto-answer

When someone in the call finishes a question, the answer streams into the panel
above the transcript. **Off by default** — enable it in Settings → Auto-answer,
and configure a provider first ([PROVIDERS.md](PROVIDERS.md)).

### How a question is detected

Entirely locally, with no API call, so the filter costs nothing and can never slow
transcription down. A segment qualifies when it:

- ends with `?`, **or**
- opens with an interrogative (`what/where/who/when/which/how/why/is/are/do/does/
  did/can/...`) or a phrase like `name the`, `tell me`, `list the`, **or**
- contains a superlative followed by a noun (`biggest`, `highest`, `fastest`, ...).

And is rejected when it is under 4 words, over 30 words, or arrives within 2
seconds of the last accepted one.

**Every rejection is logged with its reason**, which is how you tune it:

```
[lookup] rejected (too-short: 3 words (minimum 4)): what is that
[lookup] rejected (not-a-question: no question mark, interrogative opener or superlative pattern): we shipped it yesterday
[lookup] accepted (opens with "what"): What is the population of Norway
```

Known false positives, kept deliberately: `can/are/is` openers match real
questions but also call noise ("Can you hear me", "Are you still there"). Those
burn rate limit. Watch the log for a few calls and tighten
`src/main/llm/question-filter.ts` to taste.

### Trigger timing

The sidecar emits `segment_closed` the moment the VAD detects end of speech —
*before* transcription of that segment finishes. The lookup fires off the interim
text at that point, so the API call overlaps with the final transcription. When
the final arrives and differs materially from the interim (word-level overlap
below 80%, so punctuation and casing changes do not count), the in-flight request
is **cancelled and re-issued**.

> This only helps when interim passes are actually running. They are skipped
> whenever decoding is slower than ~0.6x real time — which on a CPU setup is
> almost always. There the fallback path runs instead: fire when the final
> arrives. You get the parallelism on a GPU, or with `tiny`.

### Rate limits

Hard caps, and over them calls are **skipped, never queued** — a question answered
two minutes late is worse than no answer:

- 1 call per 8 seconds
- 20 calls per hour

Remaining count shows in the panel's status strip and in Settings. Both limits are
configurable. `Ctrl+Shift+P` pauses auto-answer for 5 minutes.

### Reliability

- 10 second timeout, configurable.
- On failure, a one-line error appears on that entry. **No auto-retry.**
- A new question cancels the in-flight one rather than stacking.
- Every entry shows **first token ms** and **total ms**, so you can compare
  providers empirically.

### Manual lookup

`Ctrl+Shift+A` sends the most recent finalized transcript line, bypassing the
question filter, the auto-answer toggle and the pause. It is still rate-limited —
queuing it would violate the never-queue rule.

### Swapping providers

`LLMProvider` in [`src/main/llm/provider.ts`](src/main/llm/provider.ts) is a
one-method interface:

```ts
stream(systemPrompt: string, userText: string, signal: AbortSignal): AsyncIterable<string>
```

Everything above it — filter, rate limiter, trigger path, UI — is
provider-agnostic. A new backend is one file plus one line in
`provider-factory.ts`. The two shipped adapters are `anthropic` (native Messages
API) and `openai_compatible` (any `/v1/chat/completions` endpoint).

## How the capture exclusion works

`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` tells the Windows
compositor to render the window to the monitor but omit it from any captured
frame. The long-form explanation — including why `WDA_MONITOR` (0x01) is the wrong
flag and what goes wrong if it is used — is in the comment block at the top of
[`src/main/overlay/capture-protection.ts`](src/main/overlay/capture-protection.ts).

Two details worth knowing:

1. **The flag is set through the Win32 API directly**, not only via Electron's
   `setContentProtection(true)`. Electron is called first (so its internal state
   agrees), then the native call runs and pins `0x11`. The value is then *read back*
   with `GetWindowDisplayAffinity` — the app reports what is actually in effect
   rather than trusting the setter.
2. **It is re-applied continuously.** Display affinity is attached to the HWND and
   can be lost when the window is shown, restored, focused, moved, resized, or when
   the display topology changes. Every one of those events re-verifies it.

## Project layout

```
src/
  main/
    main.ts                      app wiring: windows, hotkeys, IPC (no tray)
    config-store.ts              JSON config in userData (atomic writes)
    hotkey.ts                    global shortcut registration (show, transcribe, quit)
    overlay/
      capture-protection.ts      WDA_EXCLUDEFROMCAPTURE — read this first
      overlay-window.ts          the overlay window; geometry + re-protection
      settings-window.ts         settings window (also capture-excluded)
    win32/
      user32.ts                  koffi FFI bindings to user32.dll
    llm/
      provider.ts                LLMProvider interface  <-- the swap point
      anthropic-provider.ts      native Messages API adapter
      openai-compatible-provider.ts  /v1/chat/completions, any base URL
      provider-factory.ts        config -> provider
      question-filter.ts         local question detection, logged rejections
      rate-limiter.ts            per-hour + spacing caps, skip never queue
      lookup-service.ts          trigger, cancellation, streaming
    transcription/
      sidecar-manager.ts         spawn / handshake / kill the Python process
      transcript-client.ts       WebSocket client (main process, not renderer)
      transcription-service.ts   status + event fan-out to the UI
  preload/preload.ts             context-isolated IPC bridge
  renderer/
    overlay/                     transcript + auto-answer panels, context menu
    settings/                    settings UI
  shared/                        types and IPC channel names

sidecar/                         Python 3.11 speech-to-text sidecar
  transcriber/
    __main__.py                  entry point, stdout handshake, stdin lifeline
    server.py                    WebSocket server + protocol
    pipeline.py                  orchestration, threading, backpressure
    audio.py                     WASAPI loopback, device monitor, resampler
    vad.py                       ring buffer + silence segmentation
    config.py                    tuning constants
  build.py                       PyInstaller packaging
```

### Why a separate process

WASAPI loopback capture needs PyAudioWPatch, which is native and Python-only.
Keeping it in a child process means a wedged audio device kills the sidecar, not
the overlay: the UI shows the error and offers a restart. It also keeps the
Electron main process free of any audio dependency.

Since recognition moved to the API the sidecar is small — capture, VAD,
segmentation and an HTTP client.

The WebSocket client lives in the **main** process rather than the renderer, so
the renderer keeps its `default-src 'none'` CSP and never holds the auth token.

## Swapping the transcript source

The same separation applies to speech. The renderer only receives
`interim` / `final` / `drop` events over IPC and knows nothing about Whisper,
WASAPI, or the sidecar. Anything that emits those three message types on the
WebSocket — a different recognizer, a remote box on your LAN, a captions feed —
drops in without touching the UI or the window code.

The protocol, in full:

| Direction | Message | Meaning |
| --- | --- | --- |
| app → sidecar | `{type:'auth', token}` | Required first frame; anything else is closed with 1008. |
| app → sidecar | `{type:'start'\|'stop'}` | Open / release the audio device. |
| app → sidecar | `{type:'config', language?, model?, tuning?}` | Runtime change; no restart. |
| app → sidecar | `{type:'shutdown'}` | Graceful exit. |
| sidecar → app | `{type:'ready'\|'state', …}` | Full state snapshot. |
| sidecar → app | `{type:'status', state, detail}` | `idle`/`listening`/`no_audio`/`model_loading`/`error`. |
| sidecar → app | `{type:'model_progress', percent, downloaded, total}` | Download progress. |
| sidecar → app | `{type:'interim', id, text}` | Provisional text for open segment `id`. |
| sidecar → app | `{type:'final', id, text, startedAt, silenceMs, queueMs, inferenceMs, latencyMs, rtf}` | Replaces the interim with the same `id`, and carries the latency breakdown. |
| sidecar → app | `{type:'drop', id}` | Segment was noise; retract its interim. |
| sidecar → app | `{type:'backlog', pending, behind}` | Decode is falling behind real time. |

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every window.
- The renderer talks to the main process only through the narrow preload API.
- Strict CSP (`default-src 'none'`) on both HTML files — nothing can be loaded
  from the network even accidentally. The transcript arrives over IPC, not a socket
  the renderer opens.
- The preload is bundled with esbuild because sandboxed preloads cannot `require`
  relative modules at runtime.
- The sidecar binds `127.0.0.1` only, on a random free port, and requires a
  32-byte token delivered through the environment rather than argv.

## Notes and limits

### Transcription

- **Latency is a few seconds by design.** A segment is only sent to the recognizer
  after 600 ms of silence, then decoded. Interim text softens this but does not
  remove it.
- **Mixed Urdu-English in one sentence transcribes badly.** That is a Whisper
  limitation, not a configuration problem. Use `en` for meetings.
- Speaker labels ("who said that") are not supported — that needs diarization,
  which is a different model.
- The capture is of the output *mix*. If two apps are making sound, both are
  transcribed.
- A virtual audio driver (FxSound, VoiceMeeter, Nvidia Broadcast) inserts itself
  as the default output device. The sidecar follows whatever Windows reports as
  default, which is usually right — `npm run sidecar:devices` shows what it picked.

### Capture exclusion

- The exclusion is enforced by the desktop compositor. It covers the normal capture
  paths (DXGI desktop duplication, Windows Graphics Capture, BitBlt, the Snipping
  Tool). It is **not** a defence against a camera pointed at your monitor, a
  hardware capture card on the display output, or a kernel-level capture driver.
- Windows may drop the affinity if the window's native handle is rebuilt. The app
  re-applies and re-verifies on every relevant event; the indicator dot is the
  ground truth.
- If the global hotkey is already owned by another app, registration fails and you
  get a dialog — pick another combination in Settings.
