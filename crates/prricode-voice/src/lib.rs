//! Voice plumbing: speech-to-text and text-to-speech behind provider traits.
//!
//! The OpenAI-compatible implementation posts multipart `/audio/transcriptions`
//! and `/audio/speech` requests, which works with OpenRouter, the Kilo AI
//! Gateway, and OpenAI. Nothing is usable until a voice-capable model is
//! configured; callers get a clear error otherwise.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum VoiceError {
    #[error("no speech-to-text model configured (set voice.stt_model)")]
    NoSttModel,
    #[error("no text-to-speech model configured (set voice.tts_model)")]
    NoTtsModel,
    #[error("http {status}: {body}")]
    Http { status: u16, body: String },
    #[error("request failed: {0}")]
    Request(String),
    #[error("io: {0}")]
    Io(String),
}

pub type VoiceResult<T> = Result<T, VoiceError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceState {
    Unconfigured,
    Ready,
}

#[async_trait::async_trait]
pub trait SpeechToText: Send + Sync {
    async fn transcribe(&self, audio: &[u8], media_type: &str) -> VoiceResult<String>;
    fn configured(&self) -> bool;
}

#[async_trait::async_trait]
pub trait TextToSpeech: Send + Sync {
    async fn synthesize(&self, text: &str, voice: Option<&str>) -> VoiceResult<Vec<u8>>;
    fn configured(&self) -> bool;
}

/// A local speech backend that shells out to whatever is installed.
///
/// The templates are shell strings with `{input}` and `{output}`
/// placeholders, resolved at call time. This is the same shape the skill
/// runtime uses: a subprocess interpreter rather than an embedded runtime, so
/// a ~40 MB model binary is fetched by the user's own tooling rather than
/// bundled here.
///
/// ```text
/// stt = "whisper-cli -m ~/models/ggml-base.en.bin -f {input}"
/// tts = "piper -m ~/voices/en_US-amy.onnx -f {output}"
/// ```
#[derive(Debug, Clone)]
pub struct CommandSpeech {
    stt_command: Option<String>,
    tts_command: Option<String>,
}

impl CommandSpeech {
    pub fn new(stt_command: Option<String>, tts_command: Option<String>) -> Self {
        Self {
            stt_command: stt_command.filter(|c| !c.trim().is_empty()),
            tts_command: tts_command.filter(|c| !c.trim().is_empty()),
        }
    }

    /// The transcription command template, when configured.
    pub fn stt_command(&self) -> Option<&str> {
        self.stt_command.as_deref()
    }

    /// The synthesis command template, when configured.
    pub fn tts_command(&self) -> Option<&str> {
        self.tts_command.as_deref()
    }
}

#[async_trait::async_trait]
impl SpeechToText for CommandSpeech {
    async fn transcribe(&self, audio: &[u8], media_type: &str) -> VoiceResult<String> {
        let template = self.stt_command.as_deref().ok_or(VoiceError::NoSttModel)?;
        // The tool reads a file, so the audio lands in a temp file first.
        let extension = media_type
            .rsplit('/')
            .next()
            .filter(|e| !e.is_empty() && e.len() <= 5)
            .unwrap_or("wav");
        let dir = std::env::temp_dir().join(format!("voice-stt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| VoiceError::Io(e.to_string()))?;
        let input = dir.join(format!("audio.{extension}"));
        std::fs::write(&input, audio).map_err(|e| VoiceError::Io(e.to_string()))?;

        let command = template.replace("{input}", &input.display().to_string());
        let output = tokio::process::Command::new("bash")
            .arg("-c")
            .arg(&command)
            .output()
            .await
            .map_err(|e| VoiceError::Io(format!("cannot run the stt command: {e}")))?;
        let _ = std::fs::remove_dir_all(&dir);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(VoiceError::Io(format!(
                "stt command failed ({}): {}",
                output.status.code().unwrap_or(-1),
                stderr.trim()
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn configured(&self) -> bool {
        self.stt_command.is_some()
    }
}

#[async_trait::async_trait]
impl TextToSpeech for CommandSpeech {
    async fn synthesize(&self, text: &str, _voice: Option<&str>) -> VoiceResult<Vec<u8>> {
        let template = self.tts_command.as_deref().ok_or(VoiceError::NoTtsModel)?;
        let dir = std::env::temp_dir().join(format!("voice-tts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| VoiceError::Io(e.to_string()))?;
        let output = dir.join("speech.wav");
        let command = template.replace("{output}", &output.display().to_string());
        let child = tokio::process::Command::new("bash")
            .arg("-c")
            .arg(&command)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| VoiceError::Io(format!("cannot run the tts command: {e}")))?;
        use tokio::io::AsyncWriteExt;
        let mut child = child;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| VoiceError::Io("tts command has no stdin".into()))?
            .write_all(text.as_bytes())
            .await
            .map_err(|e| VoiceError::Io(e.to_string()))?;
        let result = child
            .wait_with_output()
            .await
            .map_err(|e| VoiceError::Io(e.to_string()))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            return Err(VoiceError::Io(format!(
                "tts command failed ({}): {}",
                result.status.code().unwrap_or(-1),
                stderr.trim()
            )));
        }
        // Read the output before cleaning up the directory it lives in.
        let bytes = std::fs::read(&output).map_err(|e| VoiceError::Io(e.to_string()));
        let _ = std::fs::remove_dir_all(&dir);
        bytes
    }

    fn configured(&self) -> bool {
        self.tts_command.is_some()
    }
}

/// OpenAI-compatible audio endpoints (`/audio/transcriptions`, `/audio/speech`).
pub struct OpenAiAudio {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    pub stt_model: Option<String>,
    pub tts_model: Option<String>,
}

impl OpenAiAudio {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            base_url: base_url.into(),
            api_key,
            stt_model: None,
            tts_model: None,
        }
    }

    pub fn with_stt(mut self, model: impl Into<String>) -> Self {
        self.stt_model = Some(model.into());
        self
    }

    pub fn with_tts(mut self, model: impl Into<String>) -> Self {
        self.tts_model = Some(model.into());
        self
    }
}

#[async_trait::async_trait]
impl SpeechToText for OpenAiAudio {
    async fn transcribe(&self, audio: &[u8], media_type: &str) -> VoiceResult<String> {
        let model = self.stt_model.clone().ok_or(VoiceError::NoSttModel)?;
        let extension = match media_type {
            "audio/wav" | "audio/x-wav" | "audio/vnd.wave" => "wav",
            "audio/mpeg" | "audio/mp3" => "mp3",
            "audio/webm" => "webm",
            "audio/ogg" => "ogg",
            "audio/mp4" | "audio/m4a" => "m4a",
            _ => "bin",
        };
        let part = reqwest::multipart::Part::bytes(audio.to_vec())
            .file_name(format!("audio.{extension}"))
            .mime_str(media_type)
            .map_err(|e| VoiceError::Request(e.to_string()))?;
        let form = reqwest::multipart::Form::new()
            .text("model", model)
            .part("file", part);
        let mut request = self
            .client
            .post(format!("{}/audio/transcriptions", self.base_url));
        if let Some(key) = &self.api_key {
            request = request.header("Authorization", format!("Bearer {key}"));
        }
        let response = request
            .multipart(form)
            .send()
            .await
            .map_err(|e| VoiceError::Request(e.to_string()))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| VoiceError::Request(e.to_string()))?;
        if !status.is_success() {
            return Err(VoiceError::Http {
                status: status.as_u16(),
                body: body.chars().take(1024).collect(),
            });
        }
        let value: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| VoiceError::Request(format!("bad transcription response: {e}")))?;
        Ok(value
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string())
    }

    fn configured(&self) -> bool {
        self.stt_model.is_some()
    }
}

#[async_trait::async_trait]
impl TextToSpeech for OpenAiAudio {
    async fn synthesize(&self, text: &str, voice: Option<&str>) -> VoiceResult<Vec<u8>> {
        let model = self.tts_model.clone().ok_or(VoiceError::NoTtsModel)?;
        let mut body = serde_json::json!({
            "model": model,
            "input": text,
            "voice": voice.unwrap_or("alloy"),
        });
        if let Some(voice) = voice {
            body["voice"] = serde_json::json!(voice);
        }
        let mut request = self.client.post(format!("{}/audio/speech", self.base_url));
        if let Some(key) = &self.api_key {
            request = request.header("Authorization", format!("Bearer {key}"));
        }
        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| VoiceError::Request(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .map_err(|e| VoiceError::Request(e.to_string()))?;
            return Err(VoiceError::Http {
                status: status.as_u16(),
                body: body.chars().take(1024).collect(),
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| VoiceError::Request(e.to_string()))?;
        Ok(bytes.to_vec())
    }

    fn configured(&self) -> bool {
        self.tts_model.is_some()
    }
}

/// Read an audio file from disk (CLI helper for `prricode voice --file`).
pub fn read_audio(path: &Path) -> VoiceResult<Vec<u8>> {
    std::fs::read(path).map_err(|e| VoiceError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unconfigured_errors_are_clear() {
        let audio = OpenAiAudio::new("http://127.0.0.1:1", None);
        assert!(!<OpenAiAudio as SpeechToText>::configured(&audio));
        let err = audio.transcribe(b"fake", "audio/wav").await.unwrap_err();
        assert!(matches!(err, VoiceError::NoSttModel));
        let err = audio.synthesize("hi", None).await.unwrap_err();
        assert!(matches!(err, VoiceError::NoTtsModel));
    }

    /// A local backend is driven by shell templates, so a test can point it
    /// at a fake "engine" and still prove the plumbing.
    #[tokio::test]
    async fn a_command_stt_backend_transcribes_through_a_subprocess() {
        let dir = std::env::temp_dir().join(format!("voice-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-stt.sh");
        std::fs::write(
            &script,
            "#!/usr/bin/env bash\ncat <<'EOF'\nlocal transcript here\nEOF\n",
        )
        .unwrap();
        let stt = CommandSpeech::new(Some(format!("bash {}", script.display())), None);
        assert!(SpeechToText::configured(&stt));
        let text = stt.transcribe(b"RIFFfake", "audio/wav").await.unwrap();
        assert_eq!(text, "local transcript here");

        // A command that fails says why, with its exit code and stderr.
        let broken = CommandSpeech::new(Some("bash -c 'echo boom >&2; exit 3'".to_string()), None);
        let err = broken
            .transcribe(b"RIFFfake", "audio/wav")
            .await
            .unwrap_err();
        assert!(err.to_string().contains('3'), "{err}");
        assert!(err.to_string().contains("boom"), "{err}");

        // Nothing configured is the clear, existing error.
        let none = CommandSpeech::new(None, None);
        assert!(!SpeechToText::configured(&none));
        assert!(matches!(
            none.transcribe(b"x", "audio/wav").await,
            Err(VoiceError::NoSttModel)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_command_tts_backend_synthesizes_through_a_subprocess() {
        let dir = std::env::temp_dir().join(format!("voice-tts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The template reads stdin (the text) and writes the output file.
        let script = dir.join("fake-tts.sh");
        std::fs::write(
            &script,
            "#!/usr/bin/env bash\ncat >/dev/null\nprintf 'WAVEDATA' > \"$1\"\n",
        )
        .unwrap();
        // The command receives {output} as its first argument.
        let tts = CommandSpeech::new(None, Some(format!("bash {} {{output}}", script.display())));
        assert!(TextToSpeech::configured(&tts));
        let bytes = tts.synthesize("hello", None).await.unwrap();
        assert_eq!(bytes, b"WAVEDATA");
        assert!(matches!(
            CommandSpeech::new(None, None).synthesize("x", None).await,
            Err(VoiceError::NoTtsModel)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }
}
