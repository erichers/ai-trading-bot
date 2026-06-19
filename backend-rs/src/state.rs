//! Shared application state.

use crate::alpaca::Alpaca;
use crate::config::Settings;
use crate::database::Db;
use crate::llm::Llm;
use chrono::Utc;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub pool: Db,
    pub alpaca: Alpaca,
    pub llm: Llm,
    /// Real-time event bus — notifications (fills, vetoes, bot actions) are pushed
    /// to every connected WebSocket client.
    pub events: broadcast::Sender<Value>,
}

impl AppState {
    /// Broadcast a notification to all connected clients. `level` is one of
    /// "info" | "success" | "warning" | "error". Best-effort (dropped if there
    /// are no subscribers). Any `extra` object fields are merged into the payload.
    pub fn notify(&self, level: &str, title: &str, message: &str, extra: Value) {
        let mut v = json!({
            "type": "notification",
            "level": level,
            "title": title,
            "message": message,
            "ts": Utc::now().to_rfc3339(),
        });
        if let Some(o) = extra.as_object() {
            for (k, val) in o {
                v[k] = val.clone();
            }
        }
        let _ = self.events.send(v);
    }
}
