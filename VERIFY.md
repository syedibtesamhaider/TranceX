# VERIFY.md — confirming the overlay is really invisible to capture

Work through these in order. Steps 0–1 take a minute and catch most problems;
steps 2–4 are the real end-to-end proof.

**Pass condition, everywhere below: you can see the overlay on your monitor, and
the capture shows what is *behind* it — no overlay, and no black rectangle.**

A black rectangle where the overlay sits is a **failure**: it means the affinity
got set to `WDA_MONITOR` (0x01) instead of `WDA_EXCLUDEFROMCAPTURE` (0x11).

---

## 0. Automated check (30 seconds)

```bash
npm run selftest
```

Expected output:

```
[protection] ON — WDA_EXCLUDEFROMCAPTURE (0x11) via native-ffi — Window is excluded from screen capture (WDA_EXCLUDEFROMCAPTURE).
SELFTEST {"supported":true,"applied":true,"affinity":17,"affinityName":"WDA_EXCLUDEFROMCAPTURE (0x11)","buildNumber":26200,"method":"native-ffi",...,"hiddenFromAltTab":true,...}
```

What to check:

| Field | Must be | Meaning |
| --- | --- | --- |
| `affinity` | `17` | 17 decimal = 0x11 = `WDA_EXCLUDEFROMCAPTURE`. **`1` means `WDA_MONITOR` — black box, fail.** `0` means no protection at all. |
| `applied` | `true` | The value was read back from Windows, not just written. |
| `hotkeyTranscribe` | non-null | The transcription hotkey registered (default `Control+Shift+T`). |
| `hotkeyQuit` | non-null | The quit hotkey registered (default `Control+Shift+Q`). |
| `hotkeyFailures` | `[]` | Any entry names a hotkey another app already owns. It is reported in the overlay and in Settings, never as a modal dialog. |
| `tray` | `false` | No notification-area icon exists, by design. |
| `supported` | `true` | Your build is ≥ 19041. |
| `method` | `native-ffi` | The flag was pinned by the direct Win32 call. `electron-only` means koffi failed to load and the flag is whatever Electron chose — investigate. |
| `hiddenFromAltTab` | `true` | `WS_EX_TOOLWINDOW` is set. |

This reads the value back with `GetWindowDisplayAffinity`, so it reflects what
Windows actually holds for that window — but it does not prove a real capture
pipeline honours it. That is what the rest of this file is for.

### Sidecar check

```bash
npm run sidecar:probe
```

Expected: the compute path (`cuda`/`float16` or `cpu`/`int8`), and a `selected`
loopback device that matches the output device actually playing sound. If
`selected` is `null`, transcription has nothing to listen to.

### Same check against the portable .exe

A packaged Windows GUI binary has no stdout, so the self-test also writes its
report to a file:

```powershell
.\release\PrivateOverlay-1.0.0-portable.exe --selftest
Get-Content "$env:TEMP\private-overlay-selftest.json"
```

Expect the same values, plus `"packaged": true`. This is the one that matters
before you trust the .exe — it proves the native `koffi` module survived being
packed into the app archive.

The unpacked build (`npm run dist:dir`) takes the same flag:

```powershell
.\release\win-unpacked\PrivateOverlay.exe --selftest
```

> If you run either from a shell that exports `ELECTRON_RUN_AS_NODE` (VS Code's
> integrated terminal does), the .exe boots as plain Node and reports
> `bad option: --selftest`. Clear the variable first.

## 1. Live indicator

Start the app (`npm run dev`, or run the portable .exe). In the overlay's title
strip, the small dot on the left must be **green**. Hover it: the tooltip reads
`Hidden from screen capture — WDA_EXCLUDEFROMCAPTURE (0x11)`.

Open **Settings** (⚙ or right-click → Settings…) and confirm:

- `Affinity: WDA_EXCLUDEFROMCAPTURE (0x11)`
- `Applied via: SetWindowDisplayAffinity (direct Win32 call)`
- `Windows build:` ≥ 19041

Leave the app running for the checks below. Get some recognisable text into the
transcript, e.g. play a video saying something recognisable.

---

## 2. Windows Snipping Tool (`Win`+`Shift`+`S`)

1. Make sure the overlay is visible on screen, over some recognisable background
   (a browser window, the desktop, anything).
2. Press `Win`+`Shift`+`S`, choose **Rectangular** or **Fullscreen**, and drag a
   selection that fully covers the overlay.
3. Open the resulting snip (it opens automatically, or paste into Paint).

**Pass:** the snip shows the window/desktop that was behind the overlay. The panel,
its border, its shadow and your text are all absent.
**Fail:** the overlay appears, or a black rectangle appears where it was.

Also try `PrtScn` → paste into Paint, and `Win`+`PrtScn` (saves to
`Pictures\Screenshots`). Same expectation.

> Note: the overlay stays visible on your physical screen the whole time. That is
> correct — only the *captured frame* omits it.

---

## 3. OBS Studio — Display Capture

1. Open OBS. Add a source: **+ → Display Capture**.
   - If OBS offers a **Capture Method** dropdown, test **both**: `Automatic` /
     `Windows 10 (1903 and up)` (Windows Graphics Capture) *and* `DXGI Desktop
     Duplication` / `BitBlt`. The exclusion must hold in all of them.
2. Position the overlay so it sits over something recognisable on the captured
   display.
3. Look at the OBS preview/canvas.

**Pass:** the OBS preview shows the desktop with the overlay missing entirely —
you see straight through to whatever is behind it, with no seam, no black box.
**Fail:** the overlay is visible, or a black rectangle appears.

4. Hit **Start Recording**, move the overlay around while lines arrive for ~10
   seconds, then **Stop Recording**. Play the file back in a media player. The overlay must
   be absent for the whole clip, including while it is being dragged.

Also worth testing, since it uses a different capture path:

- **OBS → Window Capture**, pointed at the overlay window itself. The overlay is
  hidden from the taskbar and Alt+Tab, but it may still be listed in OBS's window
  picker. If you select it, the capture must be blank/black — it must not show the
  transcript.

---

## 4. Microsoft Teams — share your screen to yourself

1. In Teams, start a meeting with just yourself: **Calendar → Meet now → Start
   meeting → Join now**.
2. Click **Share** and pick **Screen** (the *full screen* / desktop entry, not a
   specific window).
3. Join the same meeting from a second device (phone, tablet, another laptop) — or
   use the meeting's own shared-content preview — so you can see the shared stream.
4. Move the overlay around while watching the shared stream.

**Pass:** the person/device watching the share sees the desktop without the
overlay. Your transcript never appears.
**Fail:** the overlay appears in the share, or a black rectangle appears.

Repeat with **Zoom** if you use it: *Share Screen → Screen → Share*, and watch
from a second device. Zoom's "Share sound"/"Optimize for video" options do not
change the result, but flip through them if you want to be thorough.

> Teams and Zoom both have a "share a specific window" mode. Sharing the overlay
> window itself is the same case as OBS Window Capture above: it must come through
> blank, never as readable content.

---

## 4b. The transcript panel must be invisible too

The transcript is the most sensitive thing this window will ever show, so verify
it specifically.

**Setup:** press **Start** and wait for the status to read `listening`. Play something with speech — a YouTube video or
an actual call — so real lines accumulate. Make sure several timestamped lines are
on screen, and that one interim (dimmer, italic) line is visible while someone is
mid-sentence.

**Teams full-screen share**

1. Start a meeting with yourself and share **Screen** (the full desktop).
2. Watch the shared stream from a second device.
3. While speech is being transcribed, move the overlay around.

**Pass:** the viewer sees the desktop with no overlay and no transcript text at any
point, including while new lines are appearing.
**Fail:** any transcript text is visible, or a black rectangle appears.

**OBS display capture**

1. OBS → **Display Capture** over the monitor holding the overlay.
2. Let the transcript scroll for ~30 seconds, then **Start Recording** for another
   30 and play the file back.

**Pass:** no transcript in the preview or the recording, at any scroll position.

Also confirm, in the same session:

- The **settings window** is absent too — open it during the OBS capture.
- A `Win`+`Shift`+`S` snip taken while lines are appearing contains no text.
- The **Jump to latest** button and the model-download progress bar are also
  absent (they are children of the same window, but check once).

## 4c. Transcription behaviour checks

These are not about capture exclusion, but confirm the feature is actually working.

1. **It is the speakers, not the microphone.** Mute your microphone completely
   (or unplug it) and play a video. Transcription must keep working. Then stop all
   audio playback and speak into the microphone — nothing should appear.
2. **Device change mid-session.** With transcription running, plug in headphones
   or switch the default output device in Windows sound settings. A note appears in
   the panel (`Default output device changed…`), and transcription resumes on the
   new device within a second or two. It must not crash or go permanently silent.
3. **Silence handling.** Stop all audio for 15 seconds. The status must go to
   `no audio detected` and **no text must appear**. Background hum or fan noise
   producing phantom lines is a bug.
4. **Interim replacement.** Watch a long sentence: dim italic text appears, then is
   replaced in place by the timestamped final line. You must never see the same
   sentence twice, once dim and once solid.
5. **Auto-scroll lock.** Scroll up mid-meeting. New lines must stop yanking the
   view, and **Jump to latest** must appear. Click it; auto-scroll resumes.
6. **Model switch at runtime.** Change the model in Settings while transcription is
   running. Status goes to `loading model…`, the download bar appears if it is not
   cached, then `listening` returns — with no app restart.
7. **Language switch at runtime.** Switch `en` → `auto` and back while running. No
   restart, no reload.
8. **Distil is English-only.** Select `distil-large-v3`. The language dropdown must
   disable everything except English.

## 4c-bis. Latency

Every finalized segment logs its own breakdown to the sidecar's stderr, and the
last one is shown in Settings → Latency tuning.

Run the app from a terminal (`npm run dev`), start transcription, play speech, and
watch for:

```
final seq=4 audio=3.10s | silence=352ms queue=8ms infer=980ms => total=1344ms | rtf=0.32
```

What to check:

| Field | Healthy | Meaning if not |
| --- | --- | --- |
| `silence` | ≈ your **End-of-speech ms** setting | The segmenter is not honouring the setting. |
| `queue` | near 0 | Non-zero means the worker was busy. Persistently high = falling behind. |
| `rtf` | **< 1.0** | Above 1.0 the recognizer is slower than real time and the queue grows for the whole meeting. This is the number that matters. |
| `infer` | roughly constant | It is per-call, not per-second: Whisper encodes a fixed 30-second window regardless of segment length. |

If `rtf` is above 1.0, no amount of VAD tuning will help — switch to a smaller
model (`base`, `tiny`) or install the GPU libraries. Confirm with a long
monologue: `total` must stay flat across ten consecutive segments rather than
climbing.

## 4c-ter. Transcription engine

1. **Key present.** `npm run sidecar:probe` must report
   `"elevenlabs": { "ok": true }` with a latency figure. If it says the key is
   not set, `ELEVENLABS_API_KEY` is missing from the environment the app was
   launched from.
2. **Settings → Transcription → Engine** reads `cloud / elevenlabs`. There is no
   local model any more; if transcription fails there is no fallback, by design.
3. **Domain vocabulary.** Add a project name, say it in a sentence, and it should
   come through spelled correctly. Remove it and the error usually returns — that
   is the `keyterms` bias working.
4. **No key / no network** must produce a visible error with a Restart button in
   the transcript panel, never silence.

## 4c-quater. Noisy caller / live preview

The case this was built for: someone asks a question, stops talking, but their
background noise carries on.

1. Play speech over a constant background (a fan, hiss, an open line). While the
   speech is still going, dim italic preview text must appear in the panel —
   not nothing.
2. When the speaker stops **but the noise continues**, the finalized line must
   appear within a couple of seconds. It must NOT wait for the noise to stop.
   Before this fix the segment stayed open until the 12-second cap.
3. `npm run dev` with `--verbose` logs the decisions:
   `interim skip ... previous still running`, `dropped stale seq=N after ...`,
   `dropped undecoded seq=N ... background`.
4. **Known limit:** a second person talking clearly in the background *will* be
   transcribed. That is speech, and separating speakers needs diarization.

## 4d. No transcript reaches disk

The hard privacy requirement, worth verifying rather than trusting:

1. Run transcription until you have a dozen lines that contain a distinctive
   phrase you can search for.
2. Stop transcription and quit the app from the tray.
3. Search for that phrase:

```powershell
Get-ChildItem "$env:APPDATA\PrivateOverlay" -Recurse -File |
  Select-String -Pattern "<your phrase>" -SimpleMatch -List
Get-ChildItem "$env:TEMP" -Recurse -File -ErrorAction SilentlyContinue |
  Select-String -Pattern "<your phrase>" -SimpleMatch -List
```

**Pass:** no matches anywhere. `%APPDATA%\PrivateOverlay\` should contain only
`config.json` and `models\` — nothing else.
**Fail:** any hit — that is a privacy regression.

Also confirm **Copy** works: press it, paste into Notepad, and check you get the
timestamped lines. That is the only sanctioned way text leaves the app.

## 4d-bis. No tray icon, and both quit paths work

1. **No notification area entry.** Open the Windows taskbar overflow (`^`) and the
   notification-area settings. PrivateOverlay must not be listed at all, running
   or not.
2. **Right-click menu.** Right-click anywhere on the overlay. A small dark menu
   appears with **Settings…** and **Quit**, drawn inside the window. `Esc` closes
   the menu (and only hides the overlay if the menu was already closed).
3. **The menu is capture-excluded too.** With an OBS display capture running, open
   the right-click menu and leave it open. It must be absent from the preview.
   This is the reason it is HTML rather than a native menu — verify it once.
4. **Quit via the menu.** Right-click → Quit. The app exits and, critically, the
   sidecar goes with it (see the next section).
5. **Quit via the hotkey.** Relaunch, start transcription, press `Ctrl+Shift+Q`.
   Same result, from any focused application.
6. **Forgot the hotkey?** With the overlay hidden, launching the app again must
   reveal the running instance rather than starting a second one.

## 4e. No orphan process

The sidecar holds the audio device, so a leaked process is not harmless.

**Automated check.** This boots the app *and* the sidecar, records the sidecar's
pid, quits, and lets you confirm the pid is gone:

```powershell
npm run build
node scripts/start.mjs --dev --selftest --with-sidecar
# note "sidecarPid" in the output, then:
tasklist /FI "PID eq <sidecarPid>"
```

Expected: `sidecarAlive: true` in the report, and `No tasks are running which
match the specified criteria` afterwards. Also check the report's `tray` field is
`false` and `hotkeyQuit` is set.

**Manual checks**, which cover the paths the self-test cannot press for you:

1. Start transcription. In Task Manager, confirm one `python.exe` (dev) or
   `overlay-transcriber.exe` (packaged) child exists.
2. Quit the app — test **both** paths separately, right-click → Quit and
   `Ctrl+Shift+Q`. The child must disappear within ~3 seconds either way.
3. Start it again, then **kill the Electron app from Task Manager** ("End task" on
   PrivateOverlay). The sidecar must exit on its own within a few seconds — it
   watches stdin for EOF precisely for this case.
4. Confirm no `overlay-transcriber`/`python` process is left holding the device:

```powershell
Get-Process overlay-transcriber,python -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime
```

## 4f. Sidecar failure is visible

1. With transcription running, kill **the sidecar** from Task Manager (not the app).
2. The transcript panel must show an error box with the exit code and the last
   stderr lines, plus a **Restart engine** button — not silence.
3. Press **Restart engine**. It must come back to `listening` without restarting
   the overlay.

## 5. Stress the re-application

The display affinity lives on the native window handle and Windows can drop it.
After each action below, re-check the indicator dot (must stay green) and take a
fresh `Win`+`Shift`+`S` snip:

1. Hide with `Ctrl`+`Shift`+`Space`, then show again.
2. Hide from the tray menu, show from the tray menu.
3. Drag the overlay onto a **second monitor**, especially one with a different DPI
   scaling, and back.
4. Unplug/replug the second monitor, or change scaling in
   *Settings → System → Display* while the overlay is running.
5. Lock the workstation (`Win`+`L`) and sign back in.
6. Resize the overlay to its minimum (250×200) and back.
7. Start a Teams share, then restart the overlay app mid-call.

All of these re-run the protection code. If the dot ever goes **amber**, press
**Re-apply now** in Settings and note exactly which action caused it — that is a
bug worth reporting.

---

## 6. Confirm the other window behaviours

- **Taskbar:** no button for the overlay while it is visible.
- **Alt+Tab:** the overlay is not in the switcher.
- **Always-on-top:** it stays above a maximised browser and above a full-screen
  video.
- **Persistence:** move and resize it, quit from the tray, relaunch — same
  position, same size, same opacity, same visibility state.
- **Settings window:** it is capture-excluded too. Open it during an OBS display
  capture and confirm it is also absent from the preview.

---

## If something fails

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Black rectangle instead of nothing | Affinity is `WDA_MONITOR` (0x01) | `npm run selftest` — `affinity` should be `17`, not `1`. |
| Overlay fully visible in capture; warning dialog on startup | Windows build < 19041 | Settings → `Windows build`. There is no workaround; the API does not exist. |
| Overlay visible, `method: electron-only` | koffi failed to load, so only Electron's flag is in play | Dev: `node_modules/koffi` present? Packaged: `koffi` must be unpacked from the asar (`asarUnpack` in `package.json`). |
| Green dot but overlay appears in one specific tool | That tool captures outside the compositor (hardware capture card, kernel driver, or a camera) | Out of scope — `SetWindowDisplayAffinity` cannot defend against those. |
| Dot turns amber after moving between monitors | Re-application missed an event | Press **Re-apply now**, and note the exact sequence. |

### Transcription

| Symptom | Likely cause | Check |
| --- | --- | --- |
| `Transcription sidecar not found` | The Python env or bundle is missing | `npm run setup:sidecar` (dev) or `npm run build:sidecar` (packaged). |
| Status stuck at `no audio detected` while audio is playing | The wrong loopback device was picked — common with virtual audio drivers (FxSound, VoiceMeeter, Nvidia Broadcast) | `npm run sidecar:devices` — the `selected` device must be the endpoint actually producing sound. Change the Windows default output device and it re-resolves. |
| Constant **falling behind** | Requests are slower than speech arrives — a slow or congested connection | Check `npm run sidecar:probe` latency. Raising **Merge gap ms** reduces the number of requests. |
| Phantom lines during silence | Confidence thresholds too permissive for this noise floor | Segments are dropped on `no_speech_prob`, `avg_logprob` and compression ratio — see `MAX_NO_SPEECH_PROB` etc. in `sidecar/transcriber/config.py`. |
| Words clipped at the start of sentences | VAD onset too strict | `SPEECH_ONSET_FRAMES` / `PRE_ROLL_MS` in the same file. |
