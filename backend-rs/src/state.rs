//! Shared application state.

use crate::alpaca::Alpaca;
use crate::config::Settings;
use crate::llm::Llm;
use sqlx::mysql::MySqlPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub pool: MySqlPool,
    pub alpaca: Alpaca,
    pub llm: Llm,
}
