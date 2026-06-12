//! Shared application state.

use crate::alpaca::Alpaca;
use crate::config::Settings;
use crate::database::Db;
use crate::llm::Llm;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub pool: Db,
    pub alpaca: Alpaca,
    pub llm: Llm,
}
