//! Alpaca REST + market-data wrappers. REAL data only — NO MOCK FALLBACK.
//! Mirrors backend/services/alpaca_service.py field-for-field.

use crate::config::Settings;
use crate::error::{ApiError, ApiResult};
use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::Arc;

const DATA_BASE: &str = "https://data.alpaca.markets";

#[derive(Clone)]
pub struct Alpaca {
    pub settings: Arc<Settings>,
    pub http: Client,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn fnum(v: &Value, default: f64) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(default),
        Value::String(s) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn fopt(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

impl Alpaca {
    pub fn new(settings: Arc<Settings>) -> Self {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Alpaca { settings, http }
    }

    fn configured(&self) -> bool {
        self.settings.alpaca_configured()
    }

    fn no_client(&self) -> ApiError {
        ApiError::dependency("Alpaca credentials not configured.")
    }

    fn headers(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        rb.header("APCA-API-KEY-ID", &self.settings.alpaca_api_key)
            .header("APCA-API-SECRET-KEY", &self.settings.alpaca_secret_key)
    }

    async fn get_trading(&self, path: &str, query: &[(&str, String)]) -> ApiResult<Value> {
        if !self.configured() {
            return Err(self.no_client());
        }
        let url = format!("{}/v2/{}", self.settings.alpaca_trading_base(), path);
        let mut rb = self.http.get(&url);
        if !query.is_empty() {
            rb = rb.query(query);
        }
        let resp = self
            .headers(rb)
            .send()
            .await
            .map_err(|e| ApiError::upstream(format!("Alpaca request failed: {e}")))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ApiError::upstream(format!(
                "Alpaca {} -> {}: {}",
                path, status, text
            )));
        }
        serde_json::from_str(&text)
            .map_err(|e| ApiError::upstream(format!("Alpaca bad JSON for {path}: {e}")))
    }

    async fn get_data(&self, url: &str, query: &[(&str, String)]) -> ApiResult<Value> {
        if !self.configured() {
            return Err(self.no_client());
        }
        let mut rb = self.http.get(url);
        if !query.is_empty() {
            rb = rb.query(query);
        }
        let resp = self
            .headers(rb)
            .send()
            .await
            .map_err(|e| ApiError::upstream(format!("Alpaca data request failed: {e}")))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ApiError::upstream(format!(
                "Alpaca data {} -> {}: {}",
                url, status, text
            )));
        }
        serde_json::from_str(&text)
            .map_err(|e| ApiError::upstream(format!("Alpaca data bad JSON: {e}")))
    }

    // ---- connectivity probe -------------------------------------------------
    pub async fn alpaca_connected(&self) -> bool {
        if !self.configured() {
            return false;
        }
        self.get_trading("account", &[]).await.is_ok()
    }

    // ---- account ------------------------------------------------------------
    pub async fn get_account(&self) -> ApiResult<Value> {
        let a = self.get_trading("account", &[]).await?;
        let equity = fnum(&a["equity"], 0.0);
        let last_equity = fnum(&a["last_equity"], 0.0);
        let day_pl = equity - last_equity;
        let day_pl_pct = if last_equity != 0.0 {
            day_pl / last_equity * 100.0
        } else {
            0.0
        };
        Ok(json!({
            "equity": equity,
            "buying_power": fnum(&a["buying_power"], 0.0),
            "cash": fnum(&a["cash"], 0.0),
            "portfolio_value": fnum(&a["portfolio_value"], 0.0),
            "last_equity": last_equity,
            "day_pl": (day_pl * 100.0).round() / 100.0,
            "day_pl_pct": (day_pl_pct * 10000.0).round() / 10000.0,
            "daytrade_count": a["daytrade_count"].as_i64().unwrap_or(0),
            "status": a["status"].as_str().unwrap_or("UNKNOWN"),
        }))
    }

    // ---- positions ----------------------------------------------------------
    pub async fn get_positions(&self) -> ApiResult<Value> {
        let arr = self.get_trading("positions", &[]).await?;
        let empty = vec![];
        let items = arr.as_array().unwrap_or(&empty);
        let out: Vec<Value> = items
            .iter()
            .map(|p| {
                json!({
                    "symbol": p["symbol"].as_str().unwrap_or(""),
                    "qty": fnum(&p["qty"], 0.0),
                    "side": p["side"].as_str().unwrap_or("long"),
                    "avg_entry_price": fnum(&p["avg_entry_price"], 0.0),
                    "current_price": fopt(&p["current_price"]).unwrap_or(0.0),
                    "market_value": fopt(&p["market_value"]).unwrap_or(0.0),
                    "unrealized_pl": fopt(&p["unrealized_pl"]).unwrap_or(0.0),
                    "unrealized_plpc": fopt(&p["unrealized_plpc"]).unwrap_or(0.0),
                    "change_today": fopt(&p["change_today"]).unwrap_or(0.0),
                })
            })
            .collect();
        Ok(Value::Array(out))
    }

    // ---- orders -------------------------------------------------------------
    fn order_to_dict(o: &Value) -> Value {
        let asset_class = o["asset_class"].as_str().unwrap_or("us_equity");
        let order_class = o["order_class"].as_str().filter(|s| !s.is_empty());
        json!({
            "id": o["id"].as_str().unwrap_or("").to_string(),
            "client_order_id": o["client_order_id"].as_str(),
            "symbol": o["symbol"].as_str().unwrap_or(""),
            "asset_class": asset_class,
            "qty": fopt(&o["qty"]),
            "side": o["side"].as_str().unwrap_or(""),
            "type": o.get("order_type").and_then(|v| v.as_str())
                .or_else(|| o["type"].as_str()).unwrap_or("market"),
            "order_class": order_class,
            "time_in_force": o["time_in_force"].as_str().unwrap_or("day"),
            "status": o["status"].as_str().unwrap_or(""),
            "limit_price": fopt(&o["limit_price"]),
            "stop_price": fopt(&o["stop_price"]),
            "filled_avg_price": fopt(&o["filled_avg_price"]),
            "filled_qty": fopt(&o["filled_qty"]).unwrap_or(0.0),
            "submitted_at": o["submitted_at"].as_str(),
            "filled_at": o["filled_at"].as_str(),
        })
    }

    pub async fn get_orders(&self, status: &str) -> ApiResult<Value> {
        let arr = self
            .get_trading(
                "orders",
                &[("status", status.to_string()), ("limit", "100".to_string())],
            )
            .await?;
        let empty = vec![];
        let items = arr.as_array().unwrap_or(&empty);
        Ok(Value::Array(items.iter().map(Self::order_to_dict).collect()))
    }

    pub async fn place_order(&self, payload: &Value) -> ApiResult<Value> {
        if !self.configured() {
            return Err(self.no_client());
        }
        let symbol = payload["symbol"].as_str().unwrap_or("").to_uppercase();
        let is_option = is_option_order(payload);
        let side = payload["side"].as_str().unwrap_or("buy").to_lowercase();
        let otype = payload["type"].as_str().unwrap_or("market").to_lowercase();
        let tif_raw = payload["time_in_force"].as_str().unwrap_or("day").to_lowercase();

        let mut body = serde_json::Map::new();
        body.insert("symbol".into(), json!(symbol));
        body.insert("side".into(), json!(side));
        body.insert("type".into(), json!(otype));

        if is_option {
            let qty = fnum(&payload["qty"], 0.0).round();
            let tif = if tif_raw == "gtc" { "gtc" } else { "day" };
            body.insert("qty".into(), json!(qty.to_string()));
            body.insert("time_in_force".into(), json!(tif));
        } else {
            let qty = fnum(&payload["qty"], 0.0);
            body.insert("qty".into(), json!(qty.to_string()));
            body.insert("time_in_force".into(), json!(tif_raw));
            let take_profit = payload.get("take_profit").and_then(fopt);
            let stop_loss = payload.get("stop_loss").and_then(fopt);
            if take_profit.is_some() && stop_loss.is_some() {
                body.insert("order_class".into(), json!("bracket"));
                body.insert("take_profit".into(), json!({"limit_price": take_profit.unwrap()}));
                body.insert("stop_loss".into(), json!({"stop_price": stop_loss.unwrap()}));
            }
        }
        if otype == "limit" {
            body.insert(
                "limit_price".into(),
                json!(fnum(&payload["limit_price"], 0.0).to_string()),
            );
        } else if otype == "stop" {
            body.insert(
                "stop_price".into(),
                json!(fnum(&payload["stop_price"], 0.0).to_string()),
            );
        }

        let url = format!("{}/v2/orders", self.settings.alpaca_trading_base());
        let resp = self
            .headers(self.http.post(&url))
            .json(&Value::Object(body))
            .send()
            .await
            .map_err(|e| ApiError::upstream(format!("Order placement failed: {e}")))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ApiError::upstream(format!(
                "Order placement failed: {} {}",
                status, text
            )));
        }
        let o: Value = serde_json::from_str(&text)
            .map_err(|e| ApiError::upstream(format!("Order ack bad JSON: {e}")))?;
        let mut out = Self::order_to_dict(&o);
        if is_option {
            out["asset_class"] = json!("option");
        }
        out["raw"] = o;
        Ok(out)
    }

    pub async fn cancel_order(&self, order_id: &str) -> Value {
        if !self.configured() {
            return json!({"id": order_id, "status": "canceled"});
        }
        let url = format!(
            "{}/v2/orders/{}",
            self.settings.alpaca_trading_base(),
            order_id
        );
        match self.headers(self.http.delete(&url)).send().await {
            Ok(_) => json!({"id": order_id, "status": "canceled"}),
            Err(e) => json!({"id": order_id, "status": "canceled", "error": e.to_string()}),
        }
    }

    pub async fn cancel_all_orders(&self) -> ApiResult<Value> {
        if !self.configured() {
            return Err(self.no_client());
        }
        let url = format!("{}/v2/orders", self.settings.alpaca_trading_base());
        let resp = self.headers(self.http.delete(&url)).send().await;
        match resp {
            Ok(r) => {
                let v: Value = r.json().await.unwrap_or(json!([]));
                let n = v.as_array().map(|a| a.len()).unwrap_or(0);
                Ok(json!({"cancelled": n}))
            }
            Err(e) => Ok(json!({"cancelled": 0, "error": e.to_string()})),
        }
    }

    // ---- clock --------------------------------------------------------------
    pub async fn get_clock(&self) -> ApiResult<Value> {
        let c = self.get_trading("clock", &[]).await?;
        Ok(json!({
            "is_open": c["is_open"].as_bool().unwrap_or(false),
            "next_open": c["next_open"].as_str(),
            "next_close": c["next_close"].as_str(),
            "timestamp": c["timestamp"].as_str().map(|s| s.to_string()).unwrap_or_else(now_iso),
        }))
    }

    pub async fn market_open(&self) -> bool {
        match self.get_clock().await {
            Ok(c) => c["is_open"].as_bool().unwrap_or(false),
            Err(_) => false,
        }
    }

    pub async fn get_calendar(&self, start: Option<&str>, end: Option<&str>) -> ApiResult<Value> {
        let mut q = vec![];
        if let Some(s) = start {
            q.push(("start", s.to_string()));
        }
        if let Some(e) = end {
            q.push(("end", e.to_string()));
        }
        let arr = self.get_trading("calendar", &q).await?;
        let empty = vec![];
        let items = arr.as_array().unwrap_or(&empty);
        let out: Vec<Value> = items
            .iter()
            .map(|d| {
                json!({
                    "date": d["date"].as_str().unwrap_or(""),
                    "open": d["open"].as_str().unwrap_or(""),
                    "close": d["close"].as_str().unwrap_or(""),
                    "session_open": d["session_open"].as_str(),
                    "session_close": d["session_close"].as_str(),
                })
            })
            .collect();
        Ok(Value::Array(out))
    }

    // ---- assets -------------------------------------------------------------
    pub async fn search_assets(&self, search: &str, limit: usize) -> ApiResult<Value> {
        let arr = self
            .get_trading(
                "assets",
                &[
                    ("status", "active".to_string()),
                    ("asset_class", "us_equity".to_string()),
                ],
            )
            .await?;
        let empty = vec![];
        let items = arr.as_array().unwrap_or(&empty);
        let q = search.to_uppercase();
        let mut out = vec![];
        for a in items {
            let sym = a["symbol"].as_str().unwrap_or("");
            let name = a["name"].as_str().unwrap_or(sym);
            if !q.is_empty()
                && !sym.to_uppercase().contains(&q)
                && !name.to_uppercase().contains(&q)
            {
                continue;
            }
            out.push(json!({
                "symbol": sym,
                "name": if name.is_empty() { sym } else { name },
                "exchange": a["exchange"].as_str().unwrap_or(""),
                "asset_class": a["class"].as_str().or_else(|| a["asset_class"].as_str()).unwrap_or("us_equity"),
                "tradable": a["tradable"].as_bool().unwrap_or(false),
            }));
            if out.len() >= limit {
                break;
            }
        }
        Ok(Value::Array(out))
    }

    // ---- market data: bars --------------------------------------------------
    pub async fn get_bars(&self, symbol: &str, timeframe: &str, limit: usize) -> ApiResult<Value> {
        let tf = map_timeframe(timeframe);
        let start = (Utc::now() - chrono::Duration::days(400)).to_rfc3339();
        let url = format!("{}/v2/stocks/{}/bars", DATA_BASE, symbol);
        let resp = self
            .get_data(
                &url,
                &[
                    ("timeframe", tf),
                    ("start", start),
                    ("limit", limit.to_string()),
                    ("feed", "iex".to_string()),
                    ("adjustment", "raw".to_string()),
                ],
            )
            .await?;
        let empty = vec![];
        let bars = resp["bars"].as_array().unwrap_or(&empty);
        let mut out: Vec<Value> = bars
            .iter()
            .map(|b| {
                json!({
                    "t": b["t"].as_str().unwrap_or(""),
                    "o": fnum(&b["o"], 0.0),
                    "h": fnum(&b["h"], 0.0),
                    "l": fnum(&b["l"], 0.0),
                    "c": fnum(&b["c"], 0.0),
                    "v": b["v"].as_i64().unwrap_or(0),
                })
            })
            .collect();
        if out.is_empty() {
            return Err(ApiError::upstream(format!(
                "No bars returned for {symbol} ({timeframe})."
            )));
        }
        if out.len() > limit {
            out = out.split_off(out.len() - limit);
        }
        Ok(Value::Array(out))
    }

    // ---- quote --------------------------------------------------------------
    pub async fn get_quote(&self, symbol: &str) -> ApiResult<Value> {
        let url = format!("{}/v2/stocks/{}/quotes/latest", DATA_BASE, symbol);
        let resp = self
            .get_data(&url, &[("feed", "iex".to_string())])
            .await?;
        let q = &resp["quote"];
        if q.is_null() {
            return Err(ApiError::upstream(format!("Quote unavailable for {symbol}")));
        }
        let bid = fnum(&q["bp"], 0.0);
        let ask = fnum(&q["ap"], 0.0);
        Ok(json!({
            "symbol": symbol,
            "bid": bid,
            "ask": ask,
            "bid_size": q["bs"].as_i64().unwrap_or(0),
            "ask_size": q["as"].as_i64().unwrap_or(0),
            "last": ((bid + ask) / 2.0 * 100.0).round() / 100.0,
            "timestamp": q["t"].as_str().map(|s| s.to_string()).unwrap_or_else(now_iso),
        }))
    }

    // ---- snapshot(s) --------------------------------------------------------
    fn snapshot_to_dict(symbol: &str, snap: &Value) -> Value {
        let daily = &snap["dailyBar"];
        let prev = &snap["prevDailyBar"];
        let latest_trade = &snap["latestTrade"];
        let price = if !latest_trade.is_null() {
            fnum(&latest_trade["p"], 0.0)
        } else if !daily.is_null() {
            fnum(&daily["c"], 0.0)
        } else {
            0.0
        };
        let prev_close = if !prev.is_null() {
            fnum(&prev["c"], price)
        } else if !daily.is_null() {
            fnum(&daily["o"], price)
        } else {
            price
        };
        let change = price - prev_close;
        let change_pct = if prev_close != 0.0 {
            change / prev_close * 100.0
        } else {
            0.0
        };
        json!({
            "symbol": symbol,
            "price": (price * 100.0).round() / 100.0,
            "change": (change * 100.0).round() / 100.0,
            "change_pct": (change_pct * 10000.0).round() / 10000.0,
            "volume": if daily.is_null() { 0 } else { daily["v"].as_i64().unwrap_or(0) },
            "high": if daily.is_null() { price } else { fnum(&daily["h"], price) },
            "low": if daily.is_null() { price } else { fnum(&daily["l"], price) },
            "open": if daily.is_null() { price } else { fnum(&daily["o"], price) },
            "prev_close": (prev_close * 100.0).round() / 100.0,
        })
    }

    pub async fn get_snapshot(&self, symbol: &str) -> ApiResult<Value> {
        let url = format!("{}/v2/stocks/{}/snapshot", DATA_BASE, symbol);
        let resp = self
            .get_data(&url, &[("feed", "iex".to_string())])
            .await?;
        if resp.is_null() || resp.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            return Err(ApiError::upstream(format!("No snapshot for {symbol}.")));
        }
        Ok(Self::snapshot_to_dict(symbol, &resp))
    }

    pub async fn get_snapshots(&self, symbols: &[String]) -> ApiResult<Value> {
        if symbols.is_empty() {
            return Err(ApiError::upstream("No snapshots returned for watchlist."));
        }
        let url = format!("{}/v2/stocks/snapshots", DATA_BASE);
        let resp = self
            .get_data(
                &url,
                &[
                    ("symbols", symbols.join(",")),
                    ("feed", "iex".to_string()),
                ],
            )
            .await?;
        // The batch endpoint returns {"AAPL": {...}, ...} (sometimes under "snapshots").
        let map = if resp.get("snapshots").is_some() {
            &resp["snapshots"]
        } else {
            &resp
        };
        let mut out = serde_json::Map::new();
        if let Some(obj) = map.as_object() {
            for sym in symbols {
                if let Some(snap) = obj.get(sym) {
                    if !snap.is_null() {
                        out.insert(sym.clone(), Self::snapshot_to_dict(sym, snap));
                    }
                }
            }
        }
        if out.is_empty() {
            return Err(ApiError::upstream("No snapshots returned for watchlist."));
        }
        Ok(Value::Object(out))
    }

    // ---- news ---------------------------------------------------------------
    pub async fn get_news(&self, symbols: &[String], limit: usize) -> ApiResult<Value> {
        let url = format!("{}/v1beta1/news", DATA_BASE);
        let mut q = vec![("limit", limit.to_string())];
        if !symbols.is_empty() {
            q.push(("symbols", symbols.join(",")));
        }
        let resp = self.get_data(&url, &q).await?;
        let empty = vec![];
        let items = resp["news"].as_array().unwrap_or(&empty);
        let out: Vec<Value> = items
            .iter()
            .map(|n| {
                let img = n["images"]
                    .as_array()
                    .and_then(|imgs| imgs.first())
                    .and_then(|i| i["url"].as_str())
                    .map(|s| s.to_string());
                json!({
                    "id": n["id"].as_i64().map(|i| i.to_string())
                        .unwrap_or_else(|| n["id"].as_str().unwrap_or("").to_string()),
                    "headline": n["headline"].as_str().unwrap_or(""),
                    "summary": n["summary"].as_str().unwrap_or(""),
                    "source": n["source"].as_str().unwrap_or(""),
                    "author": n["author"].as_str().unwrap_or(""),
                    "url": n["url"].as_str().unwrap_or(""),
                    "created_at": n["created_at"].as_str().map(|s| s.to_string()).unwrap_or_else(now_iso),
                    "symbols": n["symbols"].clone(),
                    "image": img,
                })
            })
            .collect();
        Ok(Value::Array(out))
    }
}

fn map_timeframe(tf: &str) -> String {
    match tf {
        "1Min" => "1Min",
        "5Min" => "5Min",
        "15Min" => "15Min",
        "1Hour" => "1Hour",
        "1Day" => "1Day",
        _ => "1Day",
    }
    .to_string()
}

// OCC option symbol: ROOT + YYMMDD + C|P + strike*1000 padded to 8.
pub fn is_occ_symbol(sym: &str) -> bool {
    let s = sym.trim().to_uppercase();
    let bytes = s.as_bytes();
    // ROOT 1-6 letters, 6 digits, C/P, 8 digits
    let n = bytes.len();
    if n < 16 {
        return false;
    }
    // find split: last 8 are digits, before that C/P, before that 6 digits
    let strike = &s[n - 8..];
    if !strike.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let cp = bytes[n - 9] as char;
    if cp != 'C' && cp != 'P' {
        return false;
    }
    let ymd = &s[n - 15..n - 9];
    if !ymd.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let root = &s[..n - 15];
    !root.is_empty() && root.len() <= 6 && root.chars().all(|c| c.is_ascii_alphabetic())
}

pub fn is_option_order(payload: &Value) -> bool {
    let sym = payload["symbol"].as_str().unwrap_or("");
    payload["asset_class"].as_str() == Some("option") || is_occ_symbol(sym)
}
