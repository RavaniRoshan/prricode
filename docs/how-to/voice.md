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
prricode voice --text "…" --out speech.mp3  # synthesize to speech.mp3
```

Without `stt_model`/`tts_model` configured, the commands say so plainly and
point here — no silent failure.

## Local speech engines

Voice does not have to go over HTTP. Set a command and prricode runs whatever
is installed on your machine instead — the same subprocess shape the skill
runtime uses, so nothing is bundled here and you bring your own binaries:

```toml
[voice]
stt_command = "whisper-cli -m ~/models/ggml-base.en.bin -f {input}"
tts_command = "piper -m ~/voices/en_US-amy.onnx -f {output}"
```

`{input}` is a temp file holding the audio; the transcript is read from stdout.
`{output}` is a temp file the command writes; the text arrives on stdin. Any
binary works — `whisper.cpp`, `piper`, a script of your own — and the HTTP
backend is used only when no command is set. A command that fails reports its
exit code and stderr rather than an empty transcript.

## What this is not

- No bundled models: local speech needs a `whisper.cpp`/`piper` build of your
  own, downloaded by your tooling rather than by prricode.
- No wake word or streaming ASR; input is file-based.
- The media pipeline (`media/upload` chunked uploads) feeds audio into
  sessions; transcriptions attach as user items.
