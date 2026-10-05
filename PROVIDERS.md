# PROVIDERS.md — auto-answer backends

Auto-answer sends the detected question to an LLM and streams the reply into the
overlay. Which backend it talks to is entirely config; the code path is the same.

Everything below goes in the `lookup` block of
`%APPDATA%\PrivateOverlay\config.json`, or can be set in **Settings →
Auto-answer**. Fill in your own keys.

---

## Where the API key lives

Two options, in precedence order:

1. **Environment variable (recommended).** Set `OVERLAY_LLM_API_KEY` and the key
   never touches disk:

   ```powershell
   $env:OVERLAY_LLM_API_KEY = "sk-..."
   npm run dev
   ```

   To make it permanent for your user account:

   ```powershell
   [Environment]::SetEnvironmentVariable("OVERLAY_LLM_API_KEY", "sk-...", "User")
   ```

2. **`config.json`.** Typing the key into Settings stores it in
   `lookup.apiKey`, **in plain text**, in `%APPDATA%\PrivateOverlay\config.json`.
   That file is readable by anything running as your user. This is the one secret
   the app stores and the one exception to its in-memory-only rule.

The environment variable wins when both are set. In Settings the key field is
write-only — it is sent to the main process and never read back into the UI, so
the key is not present in the renderer at all.

A local Ollama needs no key; leave it empty.

---

## Anthropic

The `anthropic` adapter targets `https://api.anthropic.com/v1/messages` directly.
`baseUrl` is ignored.

```json
"lookup": {
  "autoAnswer": true,
  "provider": "anthropic",
  "baseUrl": "",
  "model": "claude-haiku-4-5-20251001",
  "apiKey": "sk-ant-...",
  "bulletCount": "10-20",
  "maxTokens": 1024,
  "timeoutMs": 10000,
  "callsPerHour": 20,
  "minSpacingMs": 8000,
  "pauseMinutes": 5,
  "fadeSeconds": 45,
  "maxEntries": 5
}
```

Auth is the `x-api-key` header plus `anthropic-version: 2023-06-01` — both set by
the adapter. Key from <https://console.anthropic.com/settings/keys>.

Other models: `claude-sonnet-5`, `claude-opus-5`. Haiku is the right default here —
this feature wants first-token latency far more than it wants depth.

---

## Groq

OpenAI-compatible, and currently the fastest first-token latency of the hosted
options, which is what matters for a live call.

```json
"lookup": {
  "provider": "openai_compatible",
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "llama-3.3-70b-versatile",
  "apiKey": "gsk_..."
}
```

Key from <https://console.groq.com/keys>.

---

## Gemini (OpenAI-compatible endpoint)

Google exposes an OpenAI-shaped endpoint, so it works through the same adapter.
Note the `/openai/` path segment — pointing at the native Gemini API will not work.

```json
"lookup": {
  "provider": "openai_compatible",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
  "model": "gemini-2.0-flash",
  "apiKey": "AIza..."
}
```

Key from <https://aistudio.google.com/apikey>.

---

## OpenRouter

One key, many models — useful for comparing providers with the latency readout on
each answer.

```json
"lookup": {
  "provider": "openai_compatible",
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "anthropic/claude-haiku-4.5",
  "apiKey": "sk-or-..."
}
```

Key from <https://openrouter.ai/keys>.

---

## Local Ollama

Fully offline — the only configuration that keeps the app's original
no-network-calls property while auto-answer is on. No key needed.

```json
"lookup": {
  "provider": "openai_compatible",
  "baseUrl": "http://localhost:11434/v1",
  "model": "llama3.2",
  "apiKey": ""
}
```

Setup:

```powershell
winget install Ollama.Ollama
ollama pull llama3.2
ollama serve
```

`localhost` and `127.0.0.1` base URLs are treated as not needing a key, so the
panel will not report "no API key configured".

Expect a local model to be slower to first token than Groq unless you have a GPU
with headroom — and the transcription model is already using it.

---

## Checking it works

**Settings → Auto-answer → Test connection** fires one trivial request and
reports round-trip latency, or the exact error. Do this before a real call.

Common failures:

| Message | Cause |
| --- | --- |
| `no API key configured` | Neither `OVERLAY_LLM_API_KEY` nor `lookup.apiKey` is set. |
| `401` / `invalid api key` | Wrong key, or a key from a different provider. |
| `404` on a `/chat/completions` path | `baseUrl` is missing its `/v1` (or `/openai` for Gemini). |
| `model not found` | Model name not available on that provider — they differ. |
| `timed out after 10000 ms` | Provider slow or unreachable; raise `timeoutMs`, or check a local Ollama is running. |
| `ECONNREFUSED` on localhost | `ollama serve` is not running. |

Every answer entry shows **first token ms** and **total ms**, so you can compare
providers empirically on your own connection rather than trusting benchmarks.

---

## What gets sent

Only the detected question — one transcript segment, 4 to 30 words — plus the
fixed system prompt. Not the whole transcript, not audio, not any window content.

That said: those words are other people's speech from your call, going to a third
party under their terms and retention policy. Auto-answer is **off by default**
and the global pause hotkey (`Ctrl+Shift+P`) silences it for five minutes. If you
want the capability with no third party involved, use the Ollama block above.

---

## Speech-to-text: ElevenLabs Scribe

This is the **only** transcription engine — the local Whisper model was removed.
Without a key, transcription does not work at all.

Two ways to supply it, in precedence order:

1. **Environment variable**, which keeps the key off disk:

   ```powershell
   $env:ELEVENLABS_API_KEY = "sk_..."
   npm run dev
   ```

   Permanent for your user account (needs a new terminal afterwards):

   ```powershell
   [Environment]::SetEnvironmentVariable("ELEVENLABS_API_KEY", "sk_...", "User")
   ```

2. **Settings → Transcription → ElevenLabs API key.** Stored in plain text in
   `config.json`, like the auto-answer key. The field is write-only: it is sent
   to the main process and never read back into the UI.

A key scoped to speech-to-text is enough — the app calls no other ElevenLabs
endpoint. (`npm run sidecar:probe` only checks the *environment* variable, so it
reports "not set" even when a key is saved in settings.)

| Setting | Value |
| --- | --- |
| Domain vocabulary | sent to the API as `keyterms` |

Verify with `npm run sidecar:probe`:

```json
"elevenlabs": { "ok": true, "status": 200, "latencyMs": 1593 }
```

| Message | Cause |
| --- | --- |
| `no ElevenLabs API key` | No key in the environment *and* none saved in Settings. |
| `ElevenLabs engine not configured` | Initialisation already failed; the real reason is the error above it. |
| `ElevenLabs rejected the API key` | Wrong or revoked key. There is no local fallback — transcription stops until it is fixed. |
| `missing the permission user_read` | Harmless — only affects the probe's subscription lookup, not transcription. |

**What is sent:** one WAV per speech segment (~130 KB for 4 seconds of 16 kHz
mono), plus the keyterm list. Silence is never uploaded — the local VAD cuts it
out first, so a meeting costs far less audio-time than its wall-clock duration.
