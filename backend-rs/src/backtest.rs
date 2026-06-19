//! Backtesting engine. Walks REAL Alpaca historical bars chronologically, reuses
//! the SAME indicator + rule evaluation the live bot uses, opens/closes simulated
//! positions, and reports honest metrics + an equity curve.
//!
//! NO MOCK DATA: bars come straight from Alpaca. If a symbol has no bars we record
//! an error note for that symbol; if NO symbol produces data we return 503.
//!
//! P&L is computed on the UNDERLYING price move (entry->exit %) times direction.
//! For option bots this is a directional proxy on the real underlying — we do NOT
//! have historical option quotes, so there is a clear `note` saying so. We optionally
//! scale by a nominal delta (labelled) so option bots aren't compared 1:1 with equity.

use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::indicators;
use crate::state::AppState;
use serde_json::{json, Value};

const NOTE: &str = "Directional backtest on real underlying bars; option P&L is a delta-approximate proxy, not historical option quotes.";

fn num(v: &Value, default: f64) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(default),
        Value::String(s) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
fn round4(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

// ---- lookback mapping -------------------------------------------------------

/// Approximate number of TRADING days for a lookback window.
fn lookback_trading_days(lookback: &str) -> usize {
    match lookback.to_uppercase().as_str() {
        "1D" => 1,
        "2D" => 2,
        "1W" => 5,
        "1M" => 22,
        "3M" => 66,
        _ => 5,
    }
}

/// Approximate number of bars PER trading day for a timeframe (regular session).
fn bars_per_day(timeframe: &str) -> usize {
    match timeframe {
        "1Min" => 390,
        "5Min" => 78,
        "15Min" => 26,
        "30Min" => 13,
        "1Hour" => 7,
        "1Day" => 1,
        _ => 78,
    }
}

/// How many bars to keep at most: window bars + a warmup buffer for indicator validity.
fn request_limit(timeframe: &str, lookback: &str) -> usize {
    let window = lookback_trading_days(lookback) * bars_per_day(timeframe);
    let warmup = 200; // SMA200 etc. need history before signals are valid
    (window + warmup).clamp(250, 50_000)
}

/// Calendar days to look back when fetching bars: cover the tested window plus a
/// warmup buffer, padded for weekends/holidays. The most-recent bars are what we
/// want, so we fetch from this many days ago until now and keep the last N.
fn start_days_ago(timeframe: &str, lookback: &str) -> i64 {
    let window_td = lookback_trading_days(lookback) as i64;
    // warmup needs ~200 bars of history; convert to trading days for this tf.
    let warmup_td = (200 / bars_per_day(timeframe).max(1) as i64).max(2);
    let trading_days = window_td + warmup_td;
    // pad ~1.5x for weekends/holidays, floor at a few days.
    ((trading_days * 3) / 2 + 4).max(5)
}

// ---- rule evaluation over a rolling snapshot --------------------------------

fn indicator_path(id: &str) -> String {
    let key = id.trim().to_lowercase();
    match key.as_str() {
        "rsi" | "rsi14" => "rsi14".into(),
        "sma" | "sma20" => "sma20".into(),
        "sma50" => "sma50".into(),
        "sma200" => "sma200".into(),
        "ema" | "ema21" => "ema21".into(),
        "ema9" => "ema9".into(),
        "macd" => "macd.macd".into(),
        "macd_hist" | "macd.hist" => "macd.hist".into(),
        "macd_signal" | "macd.signal" => "macd.signal".into(),
        "atr" | "atr14" => "atr14".into(),
        "adx" | "adx14" => "adx14".into(),
        "vwap" => "vwap".into(),
        "obv" => "obv".into(),
        "volume" => "volume".into(),
        "price" | "close" => "price".into(),
        other => other.to_string(),
    }
}

fn resolve(indicator: &str, snapshot: &Value) -> Option<f64> {
    let mut node = snapshot;
    for p in indicator.split('.') {
        node = node.get(p)?;
    }
    node.as_f64()
}

fn resolve_rhs(value: &Value, snapshot: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s
            .parse::<f64>()
            .ok()
            .or_else(|| resolve(&indicator_path(s), snapshot)),
        _ => None,
    }
}

/// Apply an operator. For crosses_above/below we need prev vs current so we
/// pass both the current snapshot and the previous one. `crosses_above` fires
/// when lhs was <= rhs on the previous bar and is now > rhs (and analogously).
fn rule_passes(rule: &Value, cur: &Value, prev: Option<&Value>) -> bool {
    let ind = rule["indicator"].as_str().unwrap_or("");
    let op = rule["operator"].as_str().unwrap_or("");
    let rhs = &rule["value"];
    if ind.is_empty() {
        return false;
    }
    let lhs_now = resolve(&indicator_path(ind), cur);
    let rhs_now = resolve_rhs(rhs, cur);
    let (l, r) = match (lhs_now, rhs_now) {
        (Some(l), Some(r)) => (l, r),
        _ => return false,
    };
    match op {
        ">" | "above" => l > r,
        "<" | "below" => l < r,
        ">=" => l >= r,
        "<=" => l <= r,
        "==" | "eq" => (l - r).abs() < f64::EPSILON,
        "crosses_above" => {
            // need prev lhs <= prev rhs AND now lhs > rhs
            match prev {
                Some(p) => {
                    let lp = resolve(&indicator_path(ind), p);
                    let rp = resolve_rhs(rhs, p);
                    match (lp, rp) {
                        (Some(lp), Some(rp)) => lp <= rp && l > r,
                        _ => false,
                    }
                }
                None => false,
            }
        }
        "crosses_below" => match prev {
            Some(p) => {
                let lp = resolve(&indicator_path(ind), p);
                let rp = resolve_rhs(rhs, p);
                match (lp, rp) {
                    (Some(lp), Some(rp)) => lp >= rp && l < r,
                    _ => false,
                }
            }
            None => false,
        },
        _ => false,
    }
}

fn combine(rules: &[Value], cur: &Value, prev: Option<&Value>) -> bool {
    if rules.is_empty() {
        return false;
    }
    let mut acc = rule_passes(&rules[0], cur, prev);
    for rule in &rules[1..] {
        let v = rule_passes(rule, cur, prev);
        let join = rule["join"].as_str().unwrap_or("AND").to_uppercase();
        if join == "OR" {
            acc = acc || v;
        } else {
            acc = acc && v;
        }
    }
    acc
}

/// Is a rule set bullish or bearish? Used for action.right == "auto" and to
/// detect an "opposite" exit signal. We derive intent from the operators:
/// crosses_above / > on an oscillator/price is treated as bullish, crosses_below
/// / < as bearish. Mixed/ambiguous → None.
fn rule_direction(rules: &[Value]) -> Option<&'static str> {
    let mut bull = 0i32;
    let mut bear = 0i32;
    for r in rules {
        match r["operator"].as_str().unwrap_or("") {
            "crosses_above" | ">" | ">=" | "above" => bull += 1,
            "crosses_below" | "<" | "<=" | "below" => bear += 1,
            _ => {}
        }
    }
    if bull > bear {
        Some("long")
    } else if bear > bull {
        Some("short")
    } else {
        None
    }
}

// ---- config resolution ------------------------------------------------------

struct BtConfig {
    name: String,
    symbols: Vec<String>,
    timeframe: String,
    rules: Vec<Value>,
    /// "long" | "short" | "auto"
    side: String,
    /// "call" | "put" | None (equity)
    right: Option<String>,
    is_option: bool,
    /// nominal delta to scale option proxy P&L
    delta: f64,
    /// stop loss fraction of entry (e.g. 0.02 = 2%), 0 = disabled
    stop_pct: f64,
    /// take profit fraction of entry, 0 = disabled
    target_pct: f64,
}

fn resolve_side_right(action: &Value, config: &Value, rules: &[Value]) -> (String, Option<String>, bool, f64) {
    let asset = action["asset"].as_str().unwrap_or("option").to_lowercase();
    let is_option = asset != "equity";
    let act_right = action["right"].as_str().unwrap_or("auto").to_lowercase();
    let cfg_side = config["side"].as_str().unwrap_or("auto").to_lowercase();
    let chosen = if act_right == "call" || act_right == "put" {
        act_right.clone()
    } else if cfg_side == "call" || cfg_side == "put" || cfg_side == "long" || cfg_side == "short" {
        cfg_side.clone()
    } else {
        "auto".to_string()
    };
    let (side, right) = match chosen.as_str() {
        "call" | "long" => ("long".to_string(), if is_option { Some("call".to_string()) } else { None }),
        "put" | "short" => ("short".to_string(), if is_option { Some("put".to_string()) } else { None }),
        _ => {
            // auto: derive from rule direction (bullish trigger = long).
            match rule_direction(rules) {
                Some("short") => ("short".to_string(), if is_option { Some("put".to_string()) } else { None }),
                _ => ("long".to_string(), if is_option { Some("call".to_string()) } else { None }),
            }
        }
    };
    // nominal option delta (proxy). Use config.target_delta if present, else 0.5.
    let delta = {
        let d = num(&config["target_delta"], 0.5);
        if d > 0.0 && d <= 1.0 { d } else { 0.5 }
    };
    (side, right, is_option, delta)
}

fn build_config(body: &Value, loaded: Option<&Value>) -> Result<BtConfig, ApiError> {
    let lookback = body["lookback"].as_str().unwrap_or("1W").to_string();
    let _ = lookback; // validated by caller

    let (name, symbols, timeframe, rules, action, config) = if let Some(c) = loaded {
        // bot or strategy row
        let name = c["name"].as_str().unwrap_or("strategy").to_string();
        let mut syms: Vec<String> = c["symbols"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_uppercase())).collect())
            .unwrap_or_default();
        // allow override via body.symbol / body.symbols
        if let Some(s) = body["symbol"].as_str() {
            syms = vec![s.to_uppercase()];
        } else if let Some(arr) = body["symbols"].as_array() {
            let v: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_uppercase())).collect();
            if !v.is_empty() {
                syms = v;
            }
        }
        let timeframe = body["timeframe"]
            .as_str()
            .or_else(|| c["timeframe"].as_str())
            .or_else(|| c["config"]["timeframe"].as_str())
            .unwrap_or("5Min")
            .to_string();
        let rules = c["rules"].as_array().cloned().unwrap_or_default();
        let action = c["action"].clone();
        let config = c["config"].clone();
        (name, syms, timeframe, rules, action, config)
    } else {
        // inline config
        let name = body["name"].as_str().unwrap_or("inline backtest").to_string();
        let mut syms: Vec<String> = vec![];
        if let Some(s) = body["symbol"].as_str() {
            syms.push(s.to_uppercase());
        }
        if let Some(arr) = body["symbols"].as_array() {
            for x in arr {
                if let Some(s) = x.as_str() {
                    syms.push(s.to_uppercase());
                }
            }
        }
        let timeframe = body["timeframe"].as_str().unwrap_or("5Min").to_string();
        let rules = body["rules"].as_array().cloned().unwrap_or_default();
        let action = body["action"].clone();
        let config = body["config"].clone();
        (name, syms, timeframe, rules, action, config)
    };

    if symbols.is_empty() {
        return Err(ApiError::bad_request(
            "No symbols to backtest: provide symbol/symbols, or a bot_id/strategy_id with symbols.",
        ));
    }
    if rules.is_empty() {
        return Err(ApiError::bad_request(
            "No rules to backtest: provide rules (entry triggers) inline or via the bot/strategy.",
        ));
    }

    let (side, right, is_option, delta) = resolve_side_right(&action, &config, &rules);

    // Exits: prefer explicit body/config/strategy exits, else sensible defaults.
    // stop = 2% adverse move, target = 4% (2R) on the underlying by default.
    let exits = if !body["exits"].is_null() {
        body["exits"].clone()
    } else if let Some(c) = loaded {
        c["exits"].clone()
    } else {
        Value::Null
    };
    let stop_pct = {
        let v = num(&exits["stop_pct"], num(&config["stop_pct"], 2.0));
        if v > 0.0 { v / 100.0 } else { 0.02 }
    };
    let target_pct = {
        let v = num(&exits["target_pct"], num(&config["target_pct"], 4.0));
        if v > 0.0 { v / 100.0 } else { 0.04 }
    };

    Ok(BtConfig {
        name,
        symbols,
        timeframe,
        rules,
        side,
        right,
        is_option,
        delta,
        stop_pct,
        target_pct,
    })
}

// ---- simulation -------------------------------------------------------------

#[derive(Clone)]
struct Trade {
    side: String,
    entry_time: String,
    entry_price: f64,
    exit_time: String,
    exit_price: f64,
    pnl_pct: f64,
    exit_reason: String,
}

// ---- metrics ----------------------------------------------------------------

fn metrics(trades: &[Trade]) -> Value {
    let num_trades = trades.len();
    if num_trades == 0 {
        return json!({
            "total_return_pct": 0.0, "win_rate": 0.0, "num_trades": 0,
            "wins": 0, "losses": 0, "profit_factor": 0.0, "max_drawdown_pct": 0.0,
            "avg_win_pct": 0.0, "avg_loss_pct": 0.0,
        });
    }
    let mut wins = 0usize;
    let mut losses = 0usize;
    let mut gross_win = 0.0;
    let mut gross_loss = 0.0;
    let mut win_sum = 0.0;
    let mut loss_sum = 0.0;
    // Compound equity starting at 100 to measure return + drawdown.
    let mut equity = 100.0f64;
    let mut peak = 100.0f64;
    let mut max_dd = 0.0f64;
    for t in trades {
        let frac = t.pnl_pct / 100.0;
        equity *= 1.0 + frac;
        if equity > peak {
            peak = equity;
        }
        let dd = (peak - equity) / peak * 100.0;
        if dd > max_dd {
            max_dd = dd;
        }
        if t.pnl_pct >= 0.0 {
            wins += 1;
            win_sum += t.pnl_pct;
            gross_win += t.pnl_pct;
        } else {
            losses += 1;
            loss_sum += t.pnl_pct;
            gross_loss += -t.pnl_pct;
        }
    }
    let total_return_pct = round2(equity - 100.0);
    let win_rate = round2(wins as f64 / num_trades as f64 * 100.0);
    let profit_factor = if gross_loss > 0.0 {
        round2(gross_win / gross_loss)
    } else if gross_win > 0.0 {
        999.99
    } else {
        0.0
    };
    let avg_win_pct = if wins > 0 { round2(win_sum / wins as f64) } else { 0.0 };
    let avg_loss_pct = if losses > 0 { round2(loss_sum / losses as f64) } else { 0.0 };
    json!({
        "total_return_pct": total_return_pct,
        "win_rate": win_rate,
        "num_trades": num_trades,
        "wins": wins,
        "losses": losses,
        "profit_factor": profit_factor,
        "max_drawdown_pct": round2(max_dd),
        "avg_win_pct": avg_win_pct,
        "avg_loss_pct": avg_loss_pct,
    })
}

fn equity_curve(trades: &[Trade]) -> Value {
    let mut equity = 100.0f64;
    let mut curve = vec![json!({"t": "start", "equity": 100.0})];
    for t in trades {
        equity *= 1.0 + t.pnl_pct / 100.0;
        curve.push(json!({"t": t.exit_time, "equity": round4(equity)}));
    }
    Value::Array(curve)
}

fn trade_json(symbol: &str, right: &Option<String>, t: &Trade) -> Value {
    let mut v = json!({
        "symbol": symbol,
        "side": t.side,
        "entry_time": t.entry_time,
        "entry_price": t.entry_price,
        "exit_time": t.exit_time,
        "exit_price": t.exit_price,
        "pnl_pct": t.pnl_pct,
        "exit_reason": t.exit_reason,
    });
    if let Some(r) = right {
        v["right"] = json!(r);
    }
    v
}

/// Combine per-symbol trades into one metrics block (equal-weight, all trades pooled).
fn combine_metrics(all: &[Trade]) -> Value {
    metrics(all)
}

// ---- public entrypoint ------------------------------------------------------

pub async fn run_backtest(state: &AppState, body: &Value) -> ApiResult<Value> {
    let lookback = body["lookback"].as_str().unwrap_or("1W").to_uppercase();
    if !["1D", "2D", "1W", "1M", "3M"].contains(&lookback.as_str()) {
        return Err(ApiError::bad_request(
            "lookback must be one of 1D, 2D, 1W, 1M, 3M.",
        ));
    }

    // Resolve config: load bot/strategy if an id is given, else use inline.
    let loaded: Option<Value> = if let Some(id) = body["bot_id"].as_str() {
        Some(
            db::get_bot(&state.pool, id)
                .await?
                .ok_or_else(|| ApiError::not_found("bot not found"))?,
        )
    } else if let Some(id) = body["strategy_id"].as_str() {
        Some(
            db::get_strategy(&state.pool, id)
                .await?
                .ok_or_else(|| ApiError::not_found("strategy not found"))?,
        )
    } else {
        None
    };

    let cfg = build_config(body, loaded.as_ref())?;
    let limit = request_limit(&cfg.timeframe, &lookback);
    let days_ago = start_days_ago(&cfg.timeframe, &lookback);
    let window_bars = lookback_trading_days(&lookback) * bars_per_day(&cfg.timeframe);

    let mut per_symbol = vec![];
    let mut all_trades: Vec<Trade> = vec![];
    let mut any_data = false;
    let mut global_start: Option<String> = None;
    let mut global_end: Option<String> = None;

    for symbol in &cfg.symbols {
        let bars_v = match state
            .alpaca
            .get_bars_since(symbol, &cfg.timeframe, days_ago, limit)
            .await
        {
            Ok(b) => b,
            Err(e) => {
                per_symbol.push(json!({
                    "symbol": symbol,
                    "error": format!("No bars available: {}", e.detail),
                    "metrics": metrics(&[]),
                    "equity_curve": [],
                    "trades": [],
                }));
                continue;
            }
        };
        let all_bars = bars_v.as_array().cloned().unwrap_or_default();
        if all_bars.is_empty() {
            per_symbol.push(json!({
                "symbol": symbol,
                "error": "No bars available for the requested window.",
                "metrics": metrics(&[]),
                "equity_curve": [],
                "trades": [],
            }));
            continue;
        }
        any_data = true;

        // Track the actual window (the most recent `window_bars` are the tested
        // window; earlier bars are warmup). Indicators use all bars up to each
        // index, but trades can only open in the tested window.
        let total = all_bars.len();
        let warmup_cut = total.saturating_sub(window_bars);
        // record start/end of the *tested* window for the response
        let start_t = all_bars
            .get(warmup_cut)
            .and_then(|b| b["t"].as_str())
            .unwrap_or_else(|| all_bars[0]["t"].as_str().unwrap_or(""))
            .to_string();
        let end_t = all_bars[total - 1]["t"].as_str().unwrap_or("").to_string();
        if global_start.is_none() || start_t < *global_start.as_ref().unwrap() {
            global_start = Some(start_t.clone());
        }
        if global_end.is_none() || end_t > *global_end.as_ref().unwrap() {
            global_end = Some(end_t.clone());
        }

        // Simulate over the full bar set so indicators have warmup, but only
        // count entries whose entry bar is within the tested window.
        let trades = simulate_symbol_windowed(&cfg, &all_bars, warmup_cut, &start_t);

        all_trades.extend(trades.clone());
        per_symbol.push(json!({
            "symbol": symbol,
            "metrics": metrics(&trades),
            "equity_curve": equity_curve(&trades),
            "trades": trades.iter().map(|t| trade_json(symbol, &cfg.right, t)).collect::<Vec<_>>(),
        }));
    }

    if !any_data {
        return Err(ApiError::upstream(
            "No symbols produced historical bars for the requested window (NO MOCK DATA).",
        ));
    }

    Ok(json!({
        "config_name": cfg.name,
        "timeframe": cfg.timeframe,
        "lookback": lookback,
        "start": global_start.unwrap_or_default(),
        "end": global_end.unwrap_or_default(),
        "side": cfg.side,
        "right": cfg.right,
        "is_option": cfg.is_option,
        "combined": combine_metrics(&all_trades),
        "per_symbol": per_symbol,
        "note": NOTE,
    }))
}

/// Wrapper around `simulate_symbol` that restricts entries to the tested window
/// (bars at or after `warmup_cut` index / `start_t` timestamp) while still using
/// all preceding bars for indicator warmup.
fn simulate_symbol_windowed(cfg: &BtConfig, bars: &[Value], warmup_cut: usize, start_t: &str) -> Vec<Trade> {
    // Reuse the core walk, but gate entry on the bar index. We inline a copy of
    // the walk that respects the warmup boundary.
    let mut trades: Vec<Trade> = vec![];
    let n = bars.len();
    if n < 30 {
        return trades;
    }
    let _ = start_t;
    let mut prev_snap: Option<Value> = None;
    let mut open_pos: Option<(String, f64, String)> = None;
    let opposite = if cfg.side == "long" { "short" } else { "long" };
    let scale = if cfg.is_option { cfg.delta } else { 1.0 };

    for i in 0..n {
        let window = &bars[..=i];
        let mut snap = indicators::compute_all(window);
        let close = num(&bars[i]["c"], 0.0);
        snap["price"] = json!(round4(close));
        let entry_fires = combine(&cfg.rules, &snap, prev_snap.as_ref());

        if let Some((ref pos_side, entry_price, ref entry_time)) = open_pos.clone() {
            let high = num(&bars[i]["h"], close);
            let low = num(&bars[i]["l"], close);
            let t = bars[i]["t"].as_str().unwrap_or("").to_string();
            let pos_dir = if pos_side == "short" { -1.0 } else { 1.0 };
            let stop_price = if pos_side == "short" {
                entry_price * (1.0 + cfg.stop_pct)
            } else {
                entry_price * (1.0 - cfg.stop_pct)
            };
            let target_price = if pos_side == "short" {
                entry_price * (1.0 - cfg.target_pct)
            } else {
                entry_price * (1.0 + cfg.target_pct)
            };
            let mut exit: Option<(f64, &'static str)> = None;
            if cfg.stop_pct > 0.0 {
                let hit = if pos_side == "short" { high >= stop_price } else { low <= stop_price };
                if hit {
                    exit = Some((stop_price, "stop"));
                }
            }
            if exit.is_none() && cfg.target_pct > 0.0 {
                let hit = if pos_side == "short" { low <= target_price } else { high >= target_price };
                if hit {
                    exit = Some((target_price, "target"));
                }
            }
            if exit.is_none() && entry_fires && pos_side == opposite {
                exit = Some((close, "opposite_signal"));
            }
            if let Some((exit_price, reason)) = exit {
                let pnl_pct = round4((exit_price - entry_price) / entry_price * 100.0 * pos_dir * scale);
                trades.push(Trade {
                    side: pos_side.clone(),
                    entry_time: entry_time.clone(),
                    entry_price: round4(entry_price),
                    exit_time: t,
                    exit_price: round4(exit_price),
                    pnl_pct,
                    exit_reason: reason.to_string(),
                });
                open_pos = None;
            }
        }

        // Only OPEN positions whose entry bar (i+1) lies in the tested window.
        if open_pos.is_none() && entry_fires && i + 1 < n && (i + 1) >= warmup_cut {
            let entry_price = num(&bars[i + 1]["o"], close);
            let entry_time = bars[i + 1]["t"].as_str().unwrap_or("").to_string();
            open_pos = Some((cfg.side.clone(), entry_price, entry_time));
        }

        prev_snap = Some(snap);
    }

    if let Some((pos_side, entry_price, entry_time)) = open_pos {
        let last = &bars[n - 1];
        let exit_price = num(&last["c"], entry_price);
        let t = last["t"].as_str().unwrap_or("").to_string();
        let pos_dir = if pos_side == "short" { -1.0 } else { 1.0 };
        let pnl_pct = round4((exit_price - entry_price) / entry_price * 100.0 * pos_dir * scale);
        trades.push(Trade {
            side: pos_side.clone(),
            entry_time,
            entry_price: round4(entry_price),
            exit_time: t,
            exit_price: round4(exit_price),
            pnl_pct,
            exit_reason: "end_of_window".to_string(),
        });
    }

    trades
}
