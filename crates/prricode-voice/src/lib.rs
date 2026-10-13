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
}
