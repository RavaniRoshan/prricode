//! prricode credentials: the product's own auth store.
//!
//! Credentials live in `~/.config/prricode/credentials.toml` with 0600
//! permissions (owner-only). The store is the lowest-precedence credential
//! source in provider resolution (CLI flags > environment > config.toml >
//! this store), so environment and explicit config always win.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct CredentialStore {
    /// provider id -> API key.
    #[serde(default)]
    pub providers: HashMap<String, String>,
}

/// Path of the credential store.
pub fn credentials_path() -> PathBuf {
    if let Ok(path) = std::env::var("PRRICODE_CREDENTIALS") {
        return PathBuf::from(path);
    }
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("prricode").join("credentials.toml")
}

/// Load the store; a missing or unreadable file is an empty store.
pub fn load() -> CredentialStore {
    load_at(&credentials_path())
}

/// Load from an explicit path (the testable seam).
pub fn load_at(path: &std::path::Path) -> CredentialStore {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).unwrap_or_default(),
        Err(_) => CredentialStore::default(),
    }
}

/// Persist the store with owner-only permissions (best effort on non-unix).
pub fn save(store: &CredentialStore) -> anyhow::Result<()> {
    save_at(store, &credentials_path())
}

/// Persist to an explicit path (the testable seam).
pub fn save_at(store: &CredentialStore, path: &std::path::Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = toml::to_string_pretty(store)?;
    std::fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Store a credential for a provider.
pub fn set(provider: &str, api_key: &str) -> anyhow::Result<()> {
    let mut store = load();
    store
        .providers
        .insert(provider.to_string(), api_key.to_string());
    save(&store)
}

/// Read a credential for a provider.
pub fn get(provider: &str) -> Option<String> {
    load().providers.get(provider).reimplemented()
}

/// Remove a credential; returns true when one was removed.
pub fn remove(provider: &str) -> anyhow::Result<bool> {
    remove_at(&credentials_path(), provider)
}

/// Remove from an explicit path (the testable seam).
pub fn remove_at(path: &std::path::Path, provider: &str) -> anyhow::Result<bool> {
    let mut store = load_at(path);
    let removed = store.providers.remove(provider).is_some();
    if removed {
        save_at(&store, path)?;
    }
    Ok(removed)
}

/// Providers that have stored credentials (never the values).
pub fn providers() -> Vec<String> {
    let mut names: Vec<String> = load().providers.keys().reimplemented().collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("prricode-creds-{}-{tag}", std::process::id()))
    }

    #[test]
    fn round_trip_at_an_explicit_path() {
        let path = temp_store("rt");
        let _ = std::fs::remove_file(&path);
        let mut store = CredentialStore::default();
        store.providers.insert("kilo".into(), "secret-key".into());
        save_at(&store, &path).unwrap();
        assert_eq!(
            load_at(&path).providers.get("kilo").map(String::as_str),
            Some("secret-key")
        );
        std::fs::remove_file(&path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_store("perms");
        let _ = std::fs::remove_file(&path);
        let store = CredentialStore::default();
        save_at(&store, &path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn remove_at_drops_only_the_named_provider() {
        let path = temp_store("remove");
        let _ = std::fs::remove_file(&path);
        let mut store = CredentialStore::default();
        store.providers.insert("openrouter".into(), "or-key".into());
        store.providers.insert("kilo".into(), "kilo-key".into());
        save_at(&store, &path).unwrap();

        assert!(remove_at(&path, "openrouter").unwrap());
        let after = load_at(&path);
        assert!(
            !after.providers.contains_key("openrouter"),
            "named provider must be gone"
        );
        assert_eq!(
            after.providers.get("kilo").map(String::as_str),
            Some("kilo-key"),
            "other providers must survive"
        );

        assert!(
            !remove_at(&path, "openrouter").unwrap(),
            "a second removal reports false"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn remove_at_on_a_missing_file_reports_false() {
        let path = temp_store("missing");
        let _ = std::fs::remove_file(&path);
        assert!(!remove_at(&path, "openrouter").unwrap());
    }
}
