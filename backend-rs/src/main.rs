//! Bloomberg-terminal-style AI trading backend (axum) — web binary.
//! DEFAULT behavior is MySQL (MAMP :8889). Run: cargo run  (serves on port 8001).
//! The actual server lives in the library crate (`trading_backend_rs`) so the
//! native Tauri app can embed it with SQLite.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    trading_backend_rs::run(None, None).await
}
