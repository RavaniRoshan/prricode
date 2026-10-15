# Voice

prricode speaks audio through models, not through built-in engines. The voice
crate defines the seams; an OpenAI-compatible audio backend implements them.

## Configuration

Voice is inactive until you point it at models:

```toml
# ~/.config/prricode/config.toml
[defaults]
provider = "openrouter"        # or kilo / openai / custom — any /audio-capable endpoint

[voice]
stt_model = "openai/whisper-large-v3"   # speech -> text
tts_model = "openai/tts-1"              # text -> speech
tts_voice = "alloy"
```

Resolution order: config file, then environment
(`PRRICODE_VOICE_STT_MODEL`, `PRRICODE_VOICE_TTS_MODEL`).

## Endpoints used

| Operation | Request | Response |
|---|---|---|
| Transcribe | `POST {base}/audio/transcriptions` (multipart: model + file) | `{ "text": "…" }` |
| Synthesize | `POST {base}/audio/speech` (`{model, input, voice}`) | audio bytes |

Audio is sent with a filename/extension derived from the media type
(wav/mp3/webm/ogg/m4a). Input files in other formats are converted with
`ffmpeg` before upload.

## CLI

```bash
prricode voice --file meeting.wav        # transcribe to text
prricode voice --file note.wav --text "…" # (synthesize) writes speech.mp3
```

Without `stt_model`/`tts_model` configured, the commands say so plainly and
point here — no silent failure.

## What this is not

- No local whisper/piper build: nothing runs speech on your machine by default.
  A local `whisper.cpp` backend is a candidate for a feature flag later.
- No wake word or streaming ASR; input is file-based.
- The media pipeline (`media/upload` chunked uploads) feeds audio into
  sessions; transcriptions attach as user items.
