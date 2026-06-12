//! Application configuration loaded from the repo-root ../.env

use std::env;

#[derive(Clone, Debug)]
pub struct Settings {
    pub alpaca_api_key: String,
    pub alpaca_secret_key: String,
    pub alpaca_api_base_url: String,
    pub alpaca_paper_trade: bool,
    pub alpaca_options_feed: String,
    pub anthropic_api_key: String,

    pub research_provider: String,
    pub research_backup_provider: String,
    pub chat_provider: String,
    pub ollama_base_url: String,
    pub research_model: String,

    pub kimi_api_key: String,
    pub kimi_base_url: String,
    pub kimi_model: String,

    pub db_host: String,
    pub db_port: u16,
    pub db_user: String,
    pub db_password: String,
    pub db_name: String,

    /// "mysql" (default, web version) | "sqlite" (native app).
    pub db_backend: String,
    /// SQLite file path (used only when db_backend == "sqlite").
    pub sqlite_path: String,
}

fn ev(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn ev_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => default,
    }
}

impl Settings {
    pub fn load() -> Self {
        // .env lives one level up from backend-rs/
        let _ = dotenvy::from_path("../.env");
        let _ = dotenvy::dotenv();

        Settings {
            alpaca_api_key: ev("ALPACA_API_KEY", ""),
            alpaca_secret_key: ev("ALPACA_SECRET_KEY", ""),
            alpaca_api_base_url: ev(
                "ALPACA_API_BASE_URL",
                "https://paper-api.alpaca.markets/v2",
            ),
            alpaca_paper_trade: ev_bool("ALPACA_PAPER_TRADE", true),
            alpaca_options_feed: ev("ALPACA_OPTIONS_FEED", "indicative"),
            anthropic_api_key: ev("ANTHROPIC_API_KEY", ""),

            research_provider: ev("RESEARCH_PROVIDER", "kimi"),
            research_backup_provider: ev("RESEARCH_BACKUP_PROVIDER", "ollama"),
            chat_provider: ev("CHAT_PROVIDER", "ollama"),
            ollama_base_url: ev("OLLAMA_BASE_URL", "http://localhost:11434"),
            research_model: ev("RESEARCH_MODEL", "gemma4:e2b"),

            kimi_api_key: ev("KIMI_API_KEY", ""),
            kimi_base_url: ev("KIMI_BASE_URL", "https://api.moonshot.ai/v1"),
            kimi_model: ev("KIMI_MODEL", "kimi-k2.5"),

            db_host: ev("DB_HOST", "127.0.0.1"),
            db_port: ev("DB_PORT", "8889").parse().unwrap_or(8889),
            db_user: ev("DB_USER", "root"),
            db_password: ev("DB_PASSWORD", "root"),
            db_name: ev("DB_NAME", "trading_terminal"),

            db_backend: ev("DB_BACKEND", "mysql").to_lowercase(),
            sqlite_path: ev("SQLITE_PATH", "trading_terminal.db"),
        }
    }

    pub fn use_sqlite(&self) -> bool {
        self.db_backend == "sqlite"
    }

    pub fn alpaca_configured(&self) -> bool {
        !self.alpaca_api_key.is_empty() && !self.alpaca_secret_key.is_empty()
    }

    pub fn anthropic_configured(&self) -> bool {
        !self.anthropic_api_key.is_empty()
    }

    pub fn kimi_configured(&self) -> bool {
        !self.kimi_api_key.is_empty()
    }

    pub fn effective_research_model(&self) -> String {
        if self.research_provider.to_lowercase() == "kimi" {
            self.kimi_model.clone()
        } else {
            self.research_model.clone()
        }
    }

    /// The trading API host (strips the trailing /v2 path so we can build /v2/... ourselves).
    pub fn alpaca_trading_base(&self) -> String {
        let base = self.alpaca_api_base_url.trim_end_matches('/');
        // base like https://paper-api.alpaca.markets/v2 -> strip /v2
        if let Some(stripped) = base.strip_suffix("/v2") {
            stripped.to_string()
        } else {
            base.to_string()
        }
    }

    pub fn database_url(&self) -> String {
        format!(
            "mysql://{}:{}@{}:{}/{}",
            self.db_user, self.db_password, self.db_host, self.db_port, self.db_name
        )
    }
}
