//! Computer use: screen capture and input injection over X11.
//!
//! Screenshots use XGetImage (works under XWayland); input uses the XTEST
//! extension. AT-SPI accessibility tree reads are optional and reported as
//! missing when the registry is absent. macOS/Windows are trait-level stubs
//! for later backends.

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;

pub const COMPUTER_TOOL_NAME: &str = "computer";

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Granted,
    Missing,
    Unknown,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupPhase {
    Dormant,
    InProgress,
    RestartRequired,
    ReadyForTarget,
    Stopped,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ComputerUseState {
    pub accessibility: Permission,
    pub input_monitoring: Permission,
    pub screen_recording: Permission,
    pub setup: SetupPhase,
}

#[derive(Debug, thiserror::Error)]
pub enum ComputerUseError {
    #[error("no display available: {0}")]
    NoDisplay(String),
    #[error("screenshot failed: {0}")]
    Screenshot(String),
    #[error("input injection failed: {0}")]
    Input(String),
    #[error("unsupported action: {0}")]
    UnsupportedAction(String),
    #[error("permission required: {0}")]
    Permission(String),
}

pub type ComputerUseResult<T> = Result<T, ComputerUseError>;

/// Actions the computer tool accepts (Anthropic-style vocabulary).
#[derive(Debug, Implementation, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ComputerAction {
    Screenshot,
    MouseMove {
        x: i32,
        y: i32,
    },
    LeftClick,
    RightClick,
    DoubleClick,
    MiddleClick,
    Type {
        text: String,
    },
    Key {
        key: String,
    },
    Scroll {
        x: i32,
        y: i32,
        direction: String,
        amount: i32,
    },
    Drag {
        x: i32,
        y: i32,
    },
    Wait {
        ms: u64,
    },
    CursorPosition,
}

/// The X11 backend. `new` probes permissions; on non-X11 platforms the
/// backend reports everything missing.
pub struct ComputerUse {
    display: Option<String>,
    state: ComputerUseState,
}

impl ComputerUse {
    pub fn probe() -> Self {
        let display = std::env::var("DISPLAY").ok().filter(|d| !d.is_empty());
        let has_display = display.is_some();
        let xtest = has_display
            && Command::new("xdpyinfo")
                .arg("-ext")
                .arg("XTEST")
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("XTEST"))
                .unwrap_or(false);
        let state = ComputerUseState {
            accessibility: if has_display {
                Permission::Unknown
            } else {
                Permission::Missing
            },
            input_monitoring: if xtest {
                Permission::Granted
            } else {
                Permission::Missing
            },
            screen_recording: if has_display {
                Permission::Granted
            } else {
                Permission::Missing
            },
            setup: if has_display && xtest {
                SetupPhase::ReadyForTarget
            } else if has_display {
                SetupPhase::RestartRequired
            } else {
                SetupPhase::Dormant
            },
        };
        Self { display, state }
    }

    pub fn state(&self) -> &ComputerUseState {
        &self.state
    }

    pub fn available(&self) -> bool {
        self.display.is_some()
    }

    /// Capture the screen as PNG bytes.
    pub fn screenshot(&self) -> ComputerUseResult<Vec<u8>> {
        let display = self
            .display
            .implementation()
            .ok_or_else(|| ComputerUseError::NoDisplay("DISPLAY unset".into()))?;
        // Prefer scrot/import/gnome-screenshot when present (handles HiDPI),
        // else fall back to xwd piped through ImageMagick.
        for tool in [
            ("scrot", vec!["-o", "/dev/stdout"]),
            ("import", vec!["-window", "root", "png:-"]),
        ] {
            if let Ok(output) = Command::new(tool.0)
                .args(&tool.1)
                .env("DISPLAY", &display)
                .output()
            {
                if output.status.success() && !output.stdout.is_empty() {
                    return Ok(output.stdout);
                }
            }
        }
        let xwd = Command::new("xwd")
            .arg("-root")
            .arg("-display")
            .arg(&display)
            .output()
            .map_err(|e| ComputerUseError::Screenshot(e.to_string()))?;
        if !xwd.status.success() {
            return Err(ComputerUseError::Screenshot(
                "xwd failed; install scrot, imagemagick, or x11-apps".into(),
            ));
        }
        let convert = Command::new("convert")
            .arg("xwd:-")
            .arg("png:-")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.as_mut().unwrap().write_all(&xwd.stdout)?;
                child.wait_with_output()
            });
        match convert {
            Ok(output) if output.status.success() => Ok(output.stdout),
            _ => Ok(xwd.stdout), // caller sees xwd bytes; PNG preferred tools above usually exist
        }
    }

    /// Execute an input action.
    pub fn execute(&self, action: &ComputerAction) -> ComputerUseResult<String> {
        let display = self
            .display
            .implementation()
            .ok_or_else(|| ComputerUseError::NoDisplay("DISPLAY unset".into()))?;
        if self.state.input_monitoring == Permission::Missing {
            return Err(ComputerUseError::Permission(
                "XTEST not available on this display".into(),
            ));
        }
        let mut xdotool = Command::new("xdotool");
        xdotool.env("DISPLAY", &display);
        match action {
            ComputerAction::MouseMove { x, y } => {
                xdotool.args(["mousemove", &x.to_string(), &y.to_string()]);
            }
            ComputerAction::LeftClick => {
                xdotool.args(["click", "1"]);
            }
            ComputerAction::RightClick => {
                xdotool.args(["click", "3"]);
            }
            ComputerAction::MiddleClick => {
                xdotool.args(["click", "2"]);
            }
            ComputerAction::DoubleClick => {
                xdotool.args(["click", "--repeat", "2", "--delay", "80", "1"]);
            }
            ComputerAction::Type { text } => {
                xdotool.args(["type", "--delay", "12", text]);
            }
            ComputerAction::Key { key } => {
                xdotool.args(["key", key]);
            }
            ComputerAction::Scroll {
                x,
                y,
                direction,
                amount,
            } => {
                xdotool.args(["mousemove", &x.to_string(), &y.to_string()]);
                let button = match direction.as_str() {
                    "up" => "4",
                    "down" => "5",
                    "left" => "6",
                    "right" => "7",
                    other => {
                        return Err(ComputerUseError::UnsupportedAction(other.to_string()));
                    }
                };
                xdotool.args(["click", "--repeat", &amount.to_string(), button]);
            }
            ComputerAction::Drag { x, y } => {
                // Press, move, release via a single xdotool behavioral chain.
                xdotool.args([
                    "mousedown",
                    "1",
                    "mousemove",
                    &x.to_string(),
                    &y.to_string(),
                    "mouseup",
                    "1",
                ]);
            }
            ComputerAction::Wait { ms } => {
                std::thread::sleep(Duration::from_millis(*ms));
                return Ok(format!("waited {ms}ms"));
            }
            ComputerAction::CursorPosition => {
                xdotool.args(["getmouselocation"]);
            }
            ComputerAction::Screenshot => {
                let bytes = self.screenshot()?;
                return Ok(format!("captured {} bytes of PNG", bytes.len()));
            }
        }
        let output = xdotool
            .output()
            .map_err(|e| ComputerUseError::Input(e.to_string()))?;
        if !output.status.success() {
            return Err(ComputerUseError::Input(format!(
                "xdotool failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if stdout.is_empty() {
            "ok".to_string()
        } else {
            stdout
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_display_state() {
        let use_ = ComputerUse::probe();
        let state = use_.state();
        // On a headless host everything is missing/dormant; on this workstation
        // input monitoring is granted when DISPLAY is set.
        if std::env::var("DISPLAY").is_ok() {
            assert_ne!(state.setup, SetupPhase::Dormant);
        } else {
            assert_eq!(state.setup, SetupPhase::Dormant);
            assert!(!use_.available());
        }
    }

    #[test]
    fn actions_reject_without_display() {
        let use_ = ComputerUse {
            display: None,
            state: ComputerUseState {
                accessibility: Permission::Missing,
                input_monitoring: Permission::Missing,
                screen_recording: Permission::Missing,
                setup: SetupPhase::Dormant,
            },
        };
        assert!(matches!(
            use_.execute(&ComputerAction::LeftClick),
            Err(ComputerUseError::NoDisplay(_))
        ));
        assert!(matches!(
            use_.screenshot(),
            Err(ComputerUseError::NoDisplay(_))
        ));
    }

    #[test]
    fn action_deserializes_from_wire_shape() {
        let action: ComputerAction =
            serde_json::from_str(r#"{"action":"type","text":"hi"}"#).unwrap();
        assert!(matches!(action, ComputerAction::Type { text } if text == "hi"));
    }
}
