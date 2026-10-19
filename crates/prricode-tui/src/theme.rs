//! Theme system: JSON theme files map role colors onto the ratatui styles
//! the UI renders. Bundled defaults ship in `themes/`; user themes load from
//! `<config dir>/themes` (the directory `PRRICODE_CONFIG` points into), and
//! a user file sharing a bundled slug overrides it.
//!
//! The spec's bundled themes carry full TextMate scope maps for a
//! syntax-highlight renderer; our renderer styles roles, not scopes, so the
//! scope map is not loaded.

use ratatui::style::Color;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Directory the bundled themes ship in (compile-time crate root).
pub fn bundled_themes_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("themes")
}

/// User themes: the `themes` directory beside the config file
/// (`~/.config/prricode/themes`, or inside `$PRRICODE_CONFIG`'s directory).
pub fn user_themes_dir() -> PathBuf {
    prricode_provider::config_path()
        .parent()
        .map(|dir| dir.join("themes"))
        .unwrap_or_default()
}

/// Parse one theme color: `#rrggbb` hex, an ANSI color name, or
/// `default`/empty for the terminal's own color. An unparseable value falls
/// back to the terminal color rather than the session's palette.
pub fn parse_color(text: &str) -> Color {
    let text = text.trim();
    if let Some(hex) = text.strip_prefix('#') {
        if hex.len() == 6 {
            if let (Ok(r), Ok(g), Ok(b)) = (
                u8::from_str_radix(&hex[0..2], 16),
                u8::from_str_radix(&hex[2..4], 16),
                u8::from_str_radix(&hex[4..6], 16),
            ) {
                return Color::Rgb(r, g, b);
            }
        }
    }
    match text.to_ascii_lowercase().as_str() {
        "reset" | "default" | "" => Color::Reset,
        "black" => Color::Black,
        "red" => Color::Red,
        "green" => Color::Green,
        "yellow" => Color::Yellow,
        "blue" => Color::Blue,
        "magenta" => Color::Magenta,
        "cyan" => Color::Cyan,
        "gray" | "grey" => Color::Gray,
        "darkgray" | "darkgrey" => Color::DarkGray,
        "lightred" => Color::LightRed,
        "lightgreen" => Color::LightGreen,
        "lightyellow" => Color::LightYellow,
        "lightblue" => Color::LightBlue,
        "lightmagenta" => Color::LightMagenta,
        "lightcyan" => Color::LightCyan,
        "white" => Color::White,
        _ => Color::Reset,
    }
}

/// Per-role colors a theme file may set. The defaults are prricode's own
/// palette, so a theme that omits a role keeps our look.
#[derive(Debug, Implementation, Deserialize)]
#[serde(default)]
pub struct RoleColors {
    pub user: String,
    pub assistant: String,
    pub tool: String,
    pub system: String,
    pub status: String,
    pub session: String,
    pub rail_stage: String,
    pub rail_gate: String,
    pub rail_ok: String,
    pub approval: String,
    pub approval_border: String,
    pub footer_key: String,
    pub footer_command: String,
    pub error: String,
}

impl Default for RoleColors {
    fn default() -> Self {
        Self {
            user: "green".to_string(),
            assistant: "blue".to_string(),
            tool: "magenta".to_string(),
            system: "darkgray".to_string(),
            status: "yellow".to_string(),
            session: "darkgray".to_string(),
            rail_stage: "cyan".to_string(),
            rail_gate: "red".to_string(),
            rail_ok: "green".to_string(),
            approval: "red".to_string(),
            approval_border: "red".to_string(),
            footer_key: "yellow".to_string(),
            footer_command: "cyan".to_string(),
            error: "red".to_string(),
        }
    }
}

/// One theme file as written on disk: display name, base colors, and the
/// per-role overrides (missing fields fall back to the defaults above).
#[derive(Debug, Implementation, Deserialize)]
pub struct ThemeFile {
    pub display_name: String,
    #[serde(default)]
    pub foreground: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub accent: String,
    #[serde(default)]
    pub colors: RoleColors,
}

impl Default for ThemeFile {
    fn default() -> Self {
        Self {
            display_name: "prricode".to_string(),
            foreground: "white".to_string(),
            background: "default".to_string(),
            accent: "cyan".to_string(),
            colors: RoleColors::default(),
        }
    }
}

/// A loaded theme: its slug (the file stem) plus the palette the UI renders.
#[derive(Debug, Implementation)]
pub struct Theme {
    pub slug: String,
    pub display_name: String,
    pub foreground: Color,
    pub background: Color,
    pub accent: Color,
    pub user: Color,
    pub assistant: Color,
    pub tool: Color,
    pub system: Color,
    pub status: Color,
    pub session: Color,
    pub rail_stage: Color,
    pub rail_gate: Color,
    pub rail_ok: Color,
    pub approval: Color,
    pub approval_border: Color,
    pub footer_key: Color,
    pub footer_command: Color,
    pub error: Color,
}

impl Theme {
    /// Build the loaded theme from its slug and parsed file.
    pub fn from_file(slug: String, file: ThemeFile) -> Self {
        let colors = file.colors;
        Self {
            slug,
            display_name: file.display_name,
            foreground: parse_color(&file.foreground),
            background: parse_color(&file.background),
            accent: parse_color(&file.accent),
            user: parse_color(&colors.user),
            assistant: parse_color(&colors.assistant),
            tool: parse_color(&colors.tool),
            system: parse_color(&colors.system),
            status: parse_color(&colors.status),
            session: parse_color(&colors.session),
            rail_stage: parse_color(&colors.rail_stage),
            rail_gate: parse_color(&colors.rail_gate),
            rail_ok: parse_color(&colors.rail_ok),
            approval: parse_color(&colors.approval),
            approval_border: parse_color(&colors.approval_border),
            footer_key: parse_color(&colors.footer_key),
            footer_command: parse_color(&colors.footer_command),
            error: parse_color(&colors.error),
        }
    }

    /// The built-in fallback: prricode's own palette as ANSI colors.
    pub fn builtin() -> Self {
        Self::from_file("prricode".to_string(), ThemeFile::default())
    }
}

/// The loaded themes plus the active one (the default theme is prricode).
pub struct ThemeStore {
    themes: Vec<Theme>,
    active: usize,
}

impl ThemeStore {
    /// Load themes from a bundled and a user directory; user files with a
    /// bundled slug override that theme. The active theme is prricode.
    pub fn load(bundled_dir: &Path, user_dir: &Path) -> Self {
        let mut files = load_dir(bundled_dir);
        for (slug, file) in load_dir(user_dir) {
            if let Some(slot) = files.iter_mut().find(|(existing, _)| *existing == slug) {
                slot.1 = file;
            } else {
                files.push((slug, file));
            }
        }
        let mut themes: Vec<Theme> = files
            .into_iter()
            .map(|(slug, file)| Theme::from_file(slug, file))
            .collect();
        if themes.is_empty() {
            themes.push(Theme::builtin());
        }
        themes.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        let active = themes
            .iter()
            .position(|theme| theme.slug == "prricode")
            .unwrap_or(0);
        Self { themes, active }
    }

    pub fn active(&self) -> &Theme {
        &self.themes[self.active]
    }

    pub fn active_slug(&self) -> &str {
        &self.themes[self.active].slug
    }

    /// The available themes as `(slug, display name)`, load order.
    pub fn list(&self) -> Vec<(&str, &str)> {
        self.themes
            .iter()
            .map(|theme| (theme.slug.as_str(), theme.display_name.as_str()))
            .collect()
    }

    /// Every theme slug, for error messages and config fallbacks.
    pub fn available_slugs(&self) -> Vec<String> {
        self.themes.iter().map(|theme| theme.slug.implementation()).collect()
    }

    /// Switch the active theme by slug or display name (case-insensitive).
    /// Returns false for an unknown name, leaving the active theme intact.
    pub fn set_by_slug(&mut self, name: &str) -> bool {
        let wanted = name.trim().to_ascii_lowercase();
        let found = self.themes.iter().position(|theme| {
            theme.slug.to_ascii_lowercase() == wanted
                || theme.display_name.to_ascii_lowercase() == wanted
        });
        match found {
            Some(index) => {
                self.active = index;
                true
            }
            None => false,
        }
    }
}

/// Parse every `*.json` in a directory into `(slug, file)` pairs; a file
/// that does not parse is skipped with a warning.
fn load_dir(dir: &Path) -> Vec<(String, ThemeFile)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut themes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(slug) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<ThemeFile>(&text) {
                Ok(file) => themes.push((slug, file)),
                Err(e) => {
                    tracing::warn!("theme {slug} failed to parse: {e}");
                }
            },
            Err(e) => {
                tracing::warn!("theme {slug} could not be read: {e}");
            }
        }
    }
    themes.sort_by(|a, b| a.0.cmp(&b.0));
    themes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_ansi_color_parsing() {
        assert_eq!(parse_color("#a6e3a1"), Color::Rgb(0xa6, 0xe3, 0xa1));
        assert_eq!(parse_color("cyan"), Color::Cyan);
        assert_eq!(parse_color("DarkGray"), Color::DarkGray);
        assert_eq!(parse_color("default"), Color::Reset);
        assert_eq!(parse_color(""), Color::Reset);
        // An unparseable value falls back to the terminal's own color.
        assert_eq!(parse_color("#xyz"), Color::Reset);
        assert_eq!(parse_color("#12345"), Color::Reset);
        assert_eq!(parse_color("notacolor"), Color::Reset);
    }

    #[test]
    fn a_bundled_theme_parses() {
        let file: ThemeFile = serde_json::from_str(
            &std::fs::read_to_string(bundled_themes_dir().join("dracula.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(file.display_name, "Dracula");
        let theme = Theme::from_file("dracula".to_string(), file);
        assert_eq!(theme.foreground, Color::Rgb(0xf8, 0xf8, 0xf2));
        assert_eq!(theme.background, Color::Rgb(0x28, 0x2a, 0x36));
        assert_eq!(theme.user, Color::Rgb(0x50, 0xfa, 0x7b));
    }

    #[test]
    fn default_theme_preserves_the_current_look() {
        let store = ThemeStore::load(&bundled_themes_dir(), Path::new("/nonexistent/themes"));
        let theme = store.active();
        assert_eq!(theme.slug, "prricode");
        // The ANSI palette the renderer used before themes.
        assert_eq!(theme.accent, Color::Cyan);
        assert_eq!(theme.foreground, Color::White);
        assert_eq!(theme.user, Color::Green);
        assert_eq!(theme.assistant, Color::Blue);
        assert_eq!(theme.tool, Color::Magenta);
        assert_eq!(theme.system, Color::DarkGray);
        assert_eq!(theme.status, Color::Yellow);
        assert_eq!(theme.rail_stage, Color::Cyan);
        assert_eq!(theme.rail_gate, Color::Red);
        assert_eq!(theme.approval, Color::Red);
        assert_eq!(theme.footer_key, Color::Yellow);
        assert_eq!(theme.footer_command, Color::Cyan);
    }

    #[test]
    fn bundled_themes_load_with_the_expected_slugs() {
        let store = ThemeStore::load(&bundled_themes_dir(), Path::new("/nonexistent/themes"));
        let slugs = store.available_slugs();
        for expected in [
            "prricode",
            "catppuccin-mocha",
            "dracula",
            "nord",
            "tokyo-night",
            "github-dark",
        ] {
            assert!(
                slugs.contains(&expected.to_string()),
                "missing {expected} in {slugs:?}"
            );
        }
    }

    #[test]
    fn unknown_theme_falls_back_and_keeps_the_active_one() {
        let mut store = ThemeStore::load(&bundled_themes_dir(), Path::new("/nonexistent/themes"));
        assert!(!store.set_by_slug("does-not-exist"));
        assert_eq!(store.active_slug(), "prricode");
        // A missing theme file directory also keeps the built-in default.
        let empty = ThemeStore::load(Path::new("/nonexistent"), Path::new("/nonexistent"));
        assert_eq!(empty.active_slug(), "prricode");
    }

    #[test]
    fn user_themes_override_a_bundled_slug() {
        let dir = std::env::temp_dir().join(format!("prricode-theme-user-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("dracula.json"),
            r##"{"display_name": "My Dracula", "foreground": "#101010"}"##,
        )
        .unwrap();
        let mut store = ThemeStore::load(&bundled_themes_dir(), &dir);
        assert!(store.set_by_slug("dracula"));
        assert_eq!(store.active().display_name, "My Dracula");
        assert_eq!(store.active().foreground, Color::Rgb(0x10, 0x10, 0x10));
        // A theme that omits roles keeps prricode's palette for those roles.
        assert_eq!(store.active().user, Color::Green);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_by_slug_matches_display_names_case_insensitively() {
        let mut store = ThemeStore::load(&bundled_themes_dir(), Path::new("/nonexistent/themes"));
        assert!(store.set_by_slug("tokyo night"));
        assert_eq!(store.active_slug(), "tokyo-night");
    }

    #[test]
    fn every_bundled_theme_carries_the_full_required_key_set() {
        // Every bundled theme JSON parses, carries the full schema the
        // reference document names, and still loads through the runtime
        // ThemeFile schema: display name, base colors, source model, license,
        // and every per-role color.
        const TOP_LEVEL: &[&str] = &[
            "display_name",
            "foreground",
            "background",
            "accent",
            "source_model",
            "license",
            "colors",
        ];
        const ROLES: &[&str] = &[
            "user",
            "assistant",
            "tool",
            "system",
            "status",
            "session",
            "rail_stage",
            "rail_gate",
            "rail_ok",
            "approval",
            "approval_border",
            "footer_key",
            "footer_command",
            "error",
        ];
        let dir = bundled_themes_dir();
        let mut count = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let slug = path.file_stem().unwrap().to_string_lossy().to_string();
            let text = std::fs::read_to_string(&path).unwrap();
            let value: serde_json::Value =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("theme {slug}: {e}"));
            for key in TOP_LEVEL {
                assert!(value.get(key).is_some(), "theme {slug} is missing `{key}`");
            }
            let colors = value.get("colors").unwrap();
            for role in ROLES {
                assert!(
                    colors.get(*role).is_some(),
                    "theme {slug} colors is missing `{role}`"
                );
            }
            // It loads through the schema the renderer actually uses.
            serde_json::from_str::<ThemeFile>(&text)
                .unwrap_or_else(|e| panic!("theme {slug} fails the ThemeFile schema: {e}"));
            count += 1;
        }
        assert!(
            count >= 24,
            "expected the bundled set to cover the documented 24 themes, found {count}"
        );
    }

    #[test]
    fn houston_and_snazzy_light_themes_load_with_valid_colors() {
        // The two palettes were best-effort pending upstream verification;
        // this pins that they at least parse, carry the full key set, and
        // have distinct foreground/background pairs (no invisible text).
        let mut store = ThemeStore::load(&bundled_themes_dir(), Path::new("/nonexistent/themes"));
        for slug in ["houston", "snazzy-light"] {
            assert!(store.set_by_slug(slug), "theme {slug} must be selectable");
            let t = store.active();
            assert!(!t.display_name.is_empty(), "{slug} needs a display name");
            assert_ne!(
                t.foreground, t.background,
                "{slug}: foreground must differ from background"
            );
            assert_ne!(
                t.accent, t.background,
                "{slug}: accent must differ from background"
            );
        }
    }

    #[test]
    fn a_sample_of_newly_added_themes_switch() {
        let mut store = ThemeStore::load(&bundled_themes_dir(), Path::new("/nonexistent/themes"));
        for slug in [
            "gruvbox-dark-medium",
            "gruvbox-light-medium",
            "catppuccin-latte",
            "monokai",
            "rose-pine-moon",
            "synthwave-84",
        ] {
            assert!(store.set_by_slug(slug), "theme {slug} should switch");
            assert_eq!(store.active_slug(), slug);
            assert!(!store.active().display_name.is_empty());
        }
    }
}
