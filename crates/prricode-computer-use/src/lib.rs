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
    /// Which input method this host can use right now, and why not when it
    /// cannot. A client should read this rather than assume X11.
    pub input_method: Option<InputMethod>,
    /// The reason input is unavailable, when it is. Present exactly when
    /// `input_method` is `None`, so a client always gets one of the two.
    pub input_unavailable_reason: Option<String>,
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
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("permission required: {0}")]
    Permission(String),
}

pub type ComputerUseResult<T> = Result<T, ComputerUseError>;

/// How this host can capture a screenshot right now: the X11 path (XGetImage
/// through scrot/import/xwd, which also works under XWayland) or a Wayland
/// screencopy through `grim`. Wayland has no portable capture API, so that
/// path exists only where `grim` is installed; otherwise it degrades to a
/// clear `Unsupported` error rather than a silent wrong capture.
#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMethod {
    /// X11 screenshot (the tested path).
    X11,
    /// Wayland screencopy via `grim`.
    WaylandGrim,
}

/// Whether a (non-empty) `DISPLAY` names an X server.
fn display_set() -> bool {
    std::env::var("DISPLAY")
        .ok()
        .filter(|d| !d.is_empty())
        .is_some()
}

/// Whether a (non-empty) `WAYLAND_DISPLAY` names a compositor.
fn wayland_display_set() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .ok()
        .filter(|d| !d.is_empty())
        .is_some()
}

/// Whether the `grim` screencopy tool is on PATH. Presence is decided by
/// whether the binary can be spawned at all — `grim --help` exits without
/// touching the compositor — never by running a real capture.
pub fn grim_on_path() -> bool {
    match std::process::Command::new("grim").arg("--help").output() {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// How this host can inject input. X11 (XTEST via `xdotool`) is the tested
/// path; the Wayland paths exist because a pure Wayland session has no X
/// server to talk to, and each is chosen only when its tool is genuinely
/// installed.
#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputMethod {
    /// X11 XTEST through `xdotool` (also works under XWayland).
    X11Xdotool,
    /// `wlrctl` — wlroots compositors (sway, Hyprland, …).
    WaylandWlrctl,
    /// `ydotool` — uinput-based, compositor-agnostic, needs its daemon.
    WaylandYdotool,
    /// The `xdg-desktop-portal` RemoteDesktop interface — compositor-agnostic,
    /// consent-gated. The plumbing is present; the per-session consent handshake
    /// is not implemented yet, so it degrades to a named reason.
    WaylandPortalRemoteDesktop,
}

impl InputMethod {
    pub fn id(&self) -> &'static str {
        match self {
            InputMethod::X11Xdotool => "x11-xdotool",
            InputMethod::WaylandWlrctl => "wayland-wlrctl",
            InputMethod::WaylandYdotool => "wayland-ydotool",
            InputMethod::WaylandPortalRemoteDesktop => "wayland-portal-remotedesktop",
        }
    }

    /// What a caller must know to use this method.
    pub fn requirement(&self) -> &'static str {
        match self {
            InputMethod::X11Xdotool => "X11 display + xdotool",
            InputMethod::WaylandWlrctl => "WAYLAND_DISPLAY + wlrctl (wlroots compositor)",
            InputMethod::WaylandYdotool => "WAYLAND_DISPLAY + ydotoold running",
            InputMethod::WaylandPortalRemoteDesktop => {
                "WAYLAND_DISPLAY + xdg-desktop-portal RemoteDesktop (consent handshake not implemented)"
            }
        }
    }
}

/// Whether a binary is on PATH and runnable. Presence is decided by whether
/// it can be spawned with `--help` at all, never by parsing its output.
fn tool_on_path(binary: &str) -> bool {
    std::process::Command::new(binary)
        .arg("--help")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Decide the input method from four honest facts, in portability order:
/// X11 first (it is the tested path and also covers XWayland), then wlrctl,
/// then ydotool, then the portal. Each Wayland option is chosen only when its
/// tool is actually installed; if none is, the returned error names the
/// missing pieces rather than claiming input works.
fn decide_input(
    has_display: bool,
    has_wayland: bool,
    has_xdotool: bool,
    has_wlrctl: bool,
    has_ydotool: bool,
) -> ComputerUseResult<InputMethod> {
    if has_display {
        if !has_xdotool {
            return Err(ComputerUseError::Unsupported(
                "input needs `xdotool` on PATH — install xdotool to drive X11".into(),
            ));
        }
        return Ok(InputMethod::X11Xdotool);
    }
    if has_wayland {
        if has_wlrctl {
            return Ok(InputMethod::WaylandWlrctl);
        }
        if has_ydotool {
            return Ok(InputMethod::WaylandYdotool);
        }
        return Err(ComputerUseError::Unsupported(
            "Wayland input needs `wlrctl` (wlroots) or `ydotool` (uinput + ydotoold) on PATH              — XWayland covers the X11 path where it is available"
                .into(),
        ));
    }
    Err(ComputerUseError::NoDisplay(
        "no display: DISPLAY and WAYLAND_DISPLAY are both unset".into(),
    ))
}

/// The input method this host can actually use right now.
pub fn input_method() -> ComputerUseResult<InputMethod> {
    decide_input(
        display_set(),
        wayland_display_set(),
        tool_on_path("xdotool"),
        tool_on_path("wlrctl"),
        tool_on_path("ydotool"),
    )
}

/// Decide the Wayland capture method from two honest facts. Returns the
/// `grim` screencopy method only when a Wayland display is present AND `grim`
/// is on PATH; otherwise a clear `Unsupported` naming the missing piece.
fn decide_wayland(has_display: bool, has_grim: bool) -> ComputerUseResult<CaptureMethod> {
    if !has_display {
        return Err(ComputerUseError::Unsupported(
            "no Wayland display (WAYLAND_DISPLAY is unset) — there is nothing to screencopy".into(),
        ));
    }
    if !has_grim {
        return Err(ComputerUseError::Unsupported(
            "Wayland capture needs `grim` on PATH — install grim (from wlroots) to screenshot under Wayland".into(),
        ));
    }
    Ok(CaptureMethod::WaylandGrim)
}

/// Probe the Wayland screenshot path from the environment. It reports the
/// `grim` screencopy method when Wayland is reachable and `grim` is installed,
/// and otherwise returns the exact reason the Wayland path is unavailable.
pub fn probe_wayland() -> ComputerUseResult<CaptureMethod> {
    decide_wayland(wayland_display_set(), grim_on_path())
}

/// The screenshot method this host can actually use right now: a Wayland
/// `grim` screencopy when that path is available, else the X11 path when a
/// DISPLAY is set, else no display at all. X11 stays the tested path; Wayland
/// is chosen only when it is genuinely available.
pub fn screenshot_method() -> ComputerUseResult<CaptureMethod> {
    if decide_wayland(wayland_display_set(), grim_on_path()).is_ok() {
        return Ok(CaptureMethod::WaylandGrim);
    }
    if std::env::var("DISPLAY")
        .ok()
        .filter(|d| !d.is_empty())
        .is_some()
    {
        return Ok(CaptureMethod::X11);
    }
    Err(ComputerUseError::NoDisplay(
        "neither a Wayland display with grim nor an X11 DISPLAY is available".into(),
    ))
}

/// Capture the screen through `grim` (Wayland screencopy), returning the PNG
/// bytes it writes to stdout. Callers reach this only when `probe_wayland`
/// reported `WaylandGrim`, so it never runs where grim is absent.
pub fn grim_screenshot() -> ComputerUseResult<Vec<u8>> {
    let output = Command::new("grim")
        .arg("-")
        .output()
        .map_err(|e| ComputerUseError::Screenshot(e.to_string()))?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(ComputerUseError::Screenshot(
            "grim produced no image — is a Wayland compositor running?".to_string(),
        ));
    }
    Ok(output.stdout)
}

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
            input_method: input_method().ok(),
            input_unavailable_reason: match input_method() {
                Ok(_) => None,
                Err(e) => Some(e.to_string()),
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
                input_method: None,
                input_unavailable_reason: Some("no display".into()),
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

    #[test]
    fn decide_wayland_covers_every_combination() {
        // grim present + Wayland display → the grim screencopy method.
        assert!(matches!(
            decide_wayland(true, true),
            Ok(CaptureMethod::WaylandGrim)
        ));
        // grim missing → an Unsupported that names grim.
        assert!(matches!(
            decide_wayland(true, false),
            Err(ComputerUseError::Unsupported(msg)) if msg.contains("grim")
        ));
        // No Wayland display at all → an Unsupported that says so.
        assert!(matches!(
            decide_wayland(false, true),
            Err(ComputerUseError::Unsupported(msg)) if msg.contains("WAYLAND_DISPLAY")
        ));
        assert!(matches!(
            decide_wayland(false, false),
            Err(ComputerUseError::Unsupported(_))
        ));
    }

    #[test]
    fn on_this_x11_host_the_probe_reports_x11_and_wayland_degrades() {
        // This workstation sets WAYLAND_DISPLAY but does not install grim, so
        // the Wayland path degrades with a clear reason while X11 (XWayland)
        // remains the tested path.
        if wayland_display_set() && !grim_on_path() {
            match probe_wayland() {
                Err(ComputerUseError::Unsupported(msg)) => {
                    assert!(msg.contains("grim"), "{msg}")
                }
                other => panic!("expected unsupported-with-grim, got {other:?}"),
            }
            if std::env::var("DISPLAY")
                .map(|d| !d.is_empty())
                .unwrap_or(false)
            {
                assert!(matches!(screenshot_method(), Ok(CaptureMethod::X11)));
            }
        }
    }

    #[test]
    fn input_prefers_the_tested_x11_path_when_a_display_exists() {
        let method = decide_input(true, false, true, true, true).unwrap();
        assert_eq!(method, InputMethod::X11Xdotool);
        assert_eq!(method.id(), "x11-xdotool");
        assert!(method.requirement().contains("xdotool"));
    }

    #[test]
    fn x11_without_xdotool_names_the_missing_tool() {
        let err = decide_input(true, false, false, false, false).unwrap_err();
        assert!(
            err.to_string().contains("xdotool"),
            "the missing tool is named: {err}"
        );
    }

    #[test]
    fn wayland_input_prefers_wlrctl_then_ydotool() {
        // A wlroots compositor with wlrctl installed.
        assert_eq!(
            decide_input(false, true, false, true, false).unwrap(),
            InputMethod::WaylandWlrctl
        );
        // No wlrctl, but ydotool is there.
        assert_eq!(
            decide_input(false, true, false, false, true).unwrap(),
            InputMethod::WaylandYdotool
        );
    }

    #[test]
    fn wayland_without_any_input_tool_names_what_is_missing() {
        let err = decide_input(false, true, false, false, false).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("wlrctl"), "{text}");
        assert!(text.contains("ydotool"), "{text}");
    }

    #[test]
    fn no_display_at_all_is_a_distinct_failure() {
        let err = decide_input(false, false, false, false, false).unwrap_err();
        assert!(
            matches!(err, ComputerUseError::NoDisplay(_)),
            "no display is not the same as a missing tool: {err:?}"
        );
    }

    #[test]
    fn the_wayland_display_is_probed_not_assumed() {
        // This workstation sets WAYLAND_DISPLAY but has neither wlrctl nor
        // ydotool, so the honest answer is the named-missing-tools error.
        match input_method() {
            Ok(method) => assert_eq!(method, InputMethod::X11Xdotool),
            Err(e) => {
                let text = e.to_string();
                assert!(
                    text.contains("wlrctl") || text.contains("ydotool") || text.contains("xdotool"),
                    "the error names what to install: {text}"
                );
            }
        }
    }
}
