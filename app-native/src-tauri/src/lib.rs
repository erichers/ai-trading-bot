//! Native macOS app: spawns the embedded axum backend (SQLite) on a localhost
//! port, then points a WKWebView window at it. Reuses the existing web frontend
//! (served by the backend's embedded SPA) and the existing axum routes.

use std::net::TcpListener;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Find a free localhost TCP port by binding to :0 and reading the assigned port.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(8731)
}

/// TCP connect probe to confirm the server is accepting connections.
async fn port_listening(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_ok()
}

/// Load the repo .env (or ~/.config/trading-terminal/.env) so the backend's
/// Settings::load picks up Alpaca/Kimi/Ollama credentials. We do NOT bundle keys.
fn load_env() {
    // 1) repo root .env (works on this dev machine)
    let candidates = [
        // 1) explicit override
        std::env::var("TT_ENV_FILE").ok().map(std::path::PathBuf::from),
        // 2) user config (recommended for a real install)
        dirs_config_env(),
        // 3) relative to CWD (works during `tauri dev`)
        Some(std::path::PathBuf::from("../../.env")),
        Some(std::path::PathBuf::from("../.env")),
        Some(std::path::PathBuf::from(".env")),
        // 4) the repo root on this build machine (bundled .app launches from "/",
        //    so relative paths don't resolve — this makes the build functional here).
        Some(std::path::PathBuf::from(REPO_ENV_PATH)),
    ];
    let mut loaded = false;
    for p in candidates.into_iter().flatten() {
        if p.exists() {
            let _ = dotenvy::from_path(&p);
            tracing::info!("Loaded env from {}", p.display());
            loaded = true;
            break;
        }
    }
    if !loaded {
        tracing::warn!(
            "No .env found — set TT_ENV_FILE or create ~/.config/trading-terminal/.env"
        );
    }
}

/// Absolute path to the repo .env, baked in at compile time from the manifest dir.
/// (app-native/src-tauri -> repo root is two levels up.)
const REPO_ENV_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env");

fn dirs_config_env() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".config/trading-terminal/.env"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            // Compute a SQLite path under the app data dir.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dir unavailable");
            std::fs::create_dir_all(&data_dir).ok();
            let sqlite_path = data_dir.join("trading_terminal.db");

            // Load credentials from .env BEFORE Settings::load runs in the backend.
            load_env();

            // Force the SQLite backend for the native app (no MySQL needed).
            std::env::set_var("DB_BACKEND", "sqlite");
            std::env::set_var("SQLITE_PATH", sqlite_path.to_string_lossy().to_string());

            let port = free_port();
            tracing::info!(
                "Native app: SQLite at {}, backend port {}",
                sqlite_path.display(),
                port
            );

            // Spawn the axum server (backend lib) in a background tokio task.
            // Settings::load reads the env vars we just set.
            tauri::async_runtime::spawn(async move {
                let settings = Arc::new(trading_backend_rs::config::Settings::load());
                if let Err(e) = trading_backend_rs::run(Some(settings), Some(port)).await {
                    tracing::error!("backend server exited: {e:#}");
                }
            });

            // Wait for the server to come up, then open the main window at it.
            // Window creation must happen on the main thread, so we poll in a
            // background task and dispatch the actual build via run_on_main_thread.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                for _ in 0..300 {
                    if port_listening(port).await {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                let url = format!("http://localhost:{port}/");
                let handle2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let build = WebviewWindowBuilder::new(
                        &handle2,
                        "main",
                        WebviewUrl::External(url.parse().expect("valid url")),
                    )
                    .title("AI Trading Terminal")
                    .inner_size(1400.0, 900.0)
                    .min_inner_size(1024.0, 700.0)
                    .resizable(true)
                    .center()
                    .focused(true)
                    .visible(true)
                    .build();
                    match build {
                        Ok(_) => tracing::info!("main window created at {url}"),
                        Err(e) => tracing::error!("failed to create window: {e:#}"),
                    }
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
