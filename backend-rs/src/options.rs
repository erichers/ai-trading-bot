//! REAL options data via Alpaca REST. NO MOCK FALLBACK.
//! Trading API: /v2/options/contracts. Data API: /v1beta1/options/snapshots/{underlying}.

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use chrono::{Datelike, NaiveDate, Utc};
use serde_json::{json, Value};

const DATA_BASE: &str = "https://data.alpaca.markets";

fn fopt(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn parse_occ(occ: &str) -> Option<Value> {
    let s = occ.trim().to_uppercase();
    if !crate::alpaca::is_occ_symbol(&s) {
        return None;
    }
    let n = s.len();
    let root = &s[..n - 15];
    let ymd = &s[n - 15..n - 9];
    let cp = &s[n - 9..n - 8];
    let strike_raw = &s[n - 8..];
    let exp = NaiveDate::parse_from_str(ymd, "%y%m%d").ok()?;
    let strike: f64 = strike_raw.parse::<f64>().ok()? / 1000.0;
    Some(json!({
        "root": root,
        "expiration": exp.format("%Y-%m-%d").to_string(),
        "type": if cp == "C" { "call" } else { "put" },
        "strike": strike,
    }))
}

fn is_monthly(d: NaiveDate) -> bool {
    d.weekday() == chrono::Weekday::Fri && d.day() >= 15 && d.day() <= 21
}

fn feed(state: &AppState) -> &'static str {
    if state.settings.alpaca_options_feed.to_lowercase() == "opra" {
        "opra"
    } else {
        "indicative"
    }
}

async fn get_trading(state: &AppState, path: &str, query: &[(&str, String)]) -> ApiResult<Value> {
    if !state.settings.alpaca_configured() {
        return Err(ApiError::dependency("Alpaca credentials not configured."));
    }
    let url = format!("{}/v2/{}", state.settings.alpaca_trading_base(), path);
    let resp = state
        .alpaca
        .http
        .get(&url)
        .header("APCA-API-KEY-ID", &state.settings.alpaca_api_key)
        .header("APCA-API-SECRET-KEY", &state.settings.alpaca_secret_key)
        .query(query)
        .send()
        .await
        .map_err(|e| ApiError::upstream(format!("Alpaca options request failed: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ApiError::upstream(format!("Alpaca options {status}: {text}")));
    }
    serde_json::from_str(&text).map_err(|e| ApiError::upstream(format!("options bad JSON: {e}")))
}

async fn get_data(state: &AppState, url: &str, query: &[(&str, String)]) -> ApiResult<Value> {
    if !state.settings.alpaca_configured() {
        return Err(ApiError::dependency("Alpaca credentials not configured."));
    }
    let resp = state
        .alpaca
        .http
        .get(url)
        .header("APCA-API-KEY-ID", &state.settings.alpaca_api_key)
        .header("APCA-API-SECRET-KEY", &state.settings.alpaca_secret_key)
        .query(query)
        .send()
        .await
        .map_err(|e| ApiError::upstream(format!("Alpaca options data request failed: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ApiError::upstream(format!("Alpaca options data {status}: {text}")));
    }
    serde_json::from_str(&text).map_err(|e| ApiError::upstream(format!("options data bad JSON: {e}")))
}

pub async fn get_option_expirations(state: &AppState, symbol: &str) -> ApiResult<Vec<String>> {
    let today = Utc::now().date_naive().format("%Y-%m-%d").to_string();
    let mut seen = std::collections::BTreeSet::new();
    let mut page_token: Option<String> = None;
    let mut pages = 0;
    while pages < 10 {
        let mut q = vec![
            ("underlying_symbols", symbol.to_string()),
            ("expiration_date_gte", today.clone()),
            ("limit", "10000".to_string()),
        ];
        if let Some(pt) = &page_token {
            q.push(("page_token", pt.clone()));
        }
        let resp = get_trading(state, "options/contracts", &q).await?;
        let empty = vec![];
        let contracts = resp["option_contracts"].as_array().unwrap_or(&empty);
        for c in contracts {
            if let Some(exp) = c["expiration_date"].as_str() {
                seen.insert(exp.to_string());
            }
        }
        page_token = resp["next_page_token"].as_str().map(|s| s.to_string());
        pages += 1;
        if page_token.is_none() {
            break;
        }
    }
    let out: Vec<String> = seen.into_iter().collect();
    if out.is_empty() {
        return Err(ApiError::upstream(format!(
            "No option expirations available for {symbol}."
        )));
    }
    Ok(out)
}

pub async fn expirations_with_type(state: &AppState, symbol: &str) -> ApiResult<Value> {
    let exps = get_option_expirations(state, symbol).await?;
    let out: Vec<Value> = exps
        .iter()
        .map(|e| {
            let t = NaiveDate::parse_from_str(e, "%Y-%m-%d")
                .map(|d| if is_monthly(d) { "monthly" } else { "weekly" })
                .unwrap_or("weekly");
            json!({"date": e, "type": t})
        })
        .collect();
    Ok(Value::Array(out))
}

fn snapshot_to_contract(occ: &str, snap: &Value) -> Option<Value> {
    let parsed = parse_occ(occ)?;
    let quote = &snap["latestQuote"];
    let trade = &snap["latestTrade"];
    let greeks = &snap["greeks"];
    let bid = fopt(&quote["bp"]).unwrap_or(0.0);
    let ask = fopt(&quote["ap"]).unwrap_or(0.0);
    let last = fopt(&trade["p"]);
    let bid_size = fopt(&quote["bs"]).unwrap_or(0.0);
    let ask_size = fopt(&quote["as"]).unwrap_or(0.0);
    let volume = trade["s"].as_i64().unwrap_or(0);
    let r6 = |x: f64| (x * 1_000_000.0).round() / 1_000_000.0;
    Some(json!({
        "symbol": occ,
        "strike": parsed["strike"],
        "type": parsed["type"],
        "expiration": parsed["expiration"],
        "bid": bid,
        "ask": ask,
        "last": last.unwrap_or(((bid + ask) / 2.0 * 100.0).round() / 100.0),
        "bid_size": bid_size,
        "ask_size": ask_size,
        "volume": volume,
        "open_interest": snap["openInterest"].as_i64().unwrap_or(0),
        "implied_volatility": r6(fopt(&snap["impliedVolatility"]).unwrap_or(0.0)),
        "delta": if greeks.is_null() { 0.0 } else { r6(fopt(&greeks["delta"]).unwrap_or(0.0)) },
        "gamma": if greeks.is_null() { 0.0 } else { r6(fopt(&greeks["gamma"]).unwrap_or(0.0)) },
        "theta": if greeks.is_null() { 0.0 } else { r6(fopt(&greeks["theta"]).unwrap_or(0.0)) },
        "vega": if greeks.is_null() { 0.0 } else { r6(fopt(&greeks["vega"]).unwrap_or(0.0)) },
    }))
}

pub async fn get_option_chain(
    state: &AppState,
    symbol: &str,
    expiration: Option<&str>,
    opt_type: &str,
) -> ApiResult<Vec<Value>> {
    let exp = match expiration {
        Some(e) => Some(e.to_string()),
        None => get_option_expirations(state, symbol).await?.into_iter().next(),
    };
    let url = format!("{}/v1beta1/options/snapshots/{}", DATA_BASE, symbol);
    let mut q = vec![("feed", feed(state).to_string()), ("limit", "1000".to_string())];
    if let Some(e) = &exp {
        q.push(("expiration_date", e.clone()));
    }
    // paginate snapshots
    let mut out: Vec<Value> = vec![];
    let mut page_token: Option<String> = None;
    loop {
        let mut qq = q.clone();
        if let Some(pt) = &page_token {
            qq.push(("page_token", pt.clone()));
        }
        let resp = get_data(state, &url, &qq).await?;
        if let Some(map) = resp["snapshots"].as_object() {
            for (occ, snap) in map {
                if let Some(c) = snapshot_to_contract(occ, snap) {
                    out.push(c);
                }
            }
        }
        page_token = resp["next_page_token"].as_str().map(|s| s.to_string());
        if page_token.is_none() {
            break;
        }
    }
    if opt_type == "call" || opt_type == "put" {
        out.retain(|c| c["type"].as_str() == Some(opt_type));
    }
    out.sort_by(|a, b| {
        let ka = (a["expiration"].as_str().unwrap_or(""), a["type"].as_str().unwrap_or(""), fopt(&a["strike"]).unwrap_or(0.0));
        let kb = (b["expiration"].as_str().unwrap_or(""), b["type"].as_str().unwrap_or(""), fopt(&b["strike"]).unwrap_or(0.0));
        ka.0.cmp(kb.0).then(ka.1.cmp(kb.1)).then(ka.2.partial_cmp(&kb.2).unwrap_or(std::cmp::Ordering::Equal))
    });
    if out.is_empty() {
        return Err(ApiError::upstream(format!(
            "Empty option chain for {symbol} {}.",
            exp.unwrap_or_else(|| "(nearest)".to_string())
        )));
    }
    Ok(out)
}

pub async fn chain_json(
    state: &AppState,
    symbol: &str,
    expiration: Option<&str>,
    opt_type: &str,
) -> ApiResult<Value> {
    Ok(Value::Array(get_option_chain(state, symbol, expiration, opt_type).await?))
}

async fn underlying_price(state: &AppState, symbol: &str) -> ApiResult<f64> {
    let snap = state.alpaca.get_snapshot(symbol).await?;
    let price = fopt(&snap["price"]).unwrap_or(0.0);
    if price <= 0.0 {
        return Err(ApiError::upstream(format!("No underlying price for {symbol}.")));
    }
    Ok(price)
}

async fn nearest_weekly(state: &AppState, symbol: &str) -> ApiResult<Option<String>> {
    let exps = expirations_with_type(state, symbol).await?;
    let arr = exps.as_array().cloned().unwrap_or_default();
    let mut weeklies: Vec<String> = arr
        .iter()
        .filter(|e| e["type"].as_str() == Some("weekly"))
        .filter_map(|e| e["date"].as_str().map(|s| s.to_string()))
        .collect();
    weeklies.sort();
    if let Some(w) = weeklies.into_iter().next() {
        return Ok(Some(w));
    }
    let mut all: Vec<String> = arr.iter().filter_map(|e| e["date"].as_str().map(|s| s.to_string())).collect();
    all.sort();
    Ok(all.into_iter().next())
}

async fn resolve_expiry(state: &AppState, symbol: &str, expiry: Option<&str>) -> ApiResult<String> {
    let spec = expiry.unwrap_or("nearest_weekly").trim();
    if spec.is_empty() || spec.to_lowercase() == "nearest_weekly" {
        return nearest_weekly(state, symbol)
            .await?
            .ok_or_else(|| ApiError::upstream(format!("No weekly expiration for {symbol}.")));
    }
    if NaiveDate::parse_from_str(spec, "%Y-%m-%d").is_ok() {
        Ok(spec.to_string())
    } else {
        Err(ApiError::bad_request(format!("Bad expiry '{spec}'.")))
    }
}

fn moneyness(strike: f64, under: f64, right: &str) -> &'static str {
    if (strike - under).abs() < 1e-9 {
        return "ATM";
    }
    if right == "call" {
        if strike < under {
            "ITM"
        } else {
            "OTM"
        }
    } else if strike > under {
        "ITM"
    } else {
        "OTM"
    }
}

fn distance_pct(strike: f64, under: f64) -> f64 {
    if under != 0.0 {
        ((strike - under) / under * 100.0 * 10000.0).round() / 10000.0
    } else {
        0.0
    }
}

pub async fn select_contracts(
    state: &AppState,
    symbol: &str,
    right: &str,
    expiry: Option<&str>,
    moneyness_filter: Option<&str>,
    count: usize,
) -> ApiResult<Value> {
    let right = right.to_lowercase();
    if right != "call" && right != "put" {
        return Err(ApiError::bad_request("right must be call or put"));
    }
    let count = count.clamp(1, 50);
    let exp = resolve_expiry(state, symbol, expiry).await?;
    let under = underlying_price(state, symbol).await?;
    let mut chain = get_option_chain(state, symbol, Some(&exp), &right).await?;
    chain.sort_by(|a, b| fopt(&a["strike"]).unwrap_or(0.0).partial_cmp(&fopt(&b["strike"]).unwrap_or(0.0)).unwrap());
    let strikes: Vec<f64> = chain.iter().map(|c| fopt(&c["strike"]).unwrap_or(0.0)).collect();
    let atm_idx = strikes
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| (**a - under).abs().partial_cmp(&(**b - under).abs()).unwrap())
        .map(|(i, _)| i)
        .unwrap_or(0);

    let annotated: Vec<Value> = chain
        .iter()
        .map(|c| {
            let strike = fopt(&c["strike"]).unwrap_or(0.0);
            let bid = fopt(&c["bid"]).unwrap_or(0.0);
            let ask = fopt(&c["ask"]).unwrap_or(0.0);
            let mid = if bid != 0.0 || ask != 0.0 {
                ((bid + ask) / 2.0 * 10000.0).round() / 10000.0
            } else {
                fopt(&c["last"]).unwrap_or(0.0)
            };
            json!({
                "occ_symbol": c["symbol"],
                "strike": strike,
                "right": right,
                "expiration": c["expiration"],
                "bid": bid,
                "ask": ask,
                "mid": mid,
                "last": fopt(&c["last"]).unwrap_or(0.0),
                "implied_volatility": fopt(&c["implied_volatility"]).unwrap_or(0.0),
                "delta": fopt(&c["delta"]).unwrap_or(0.0),
                "gamma": fopt(&c["gamma"]).unwrap_or(0.0),
                "theta": fopt(&c["theta"]).unwrap_or(0.0),
                "vega": fopt(&c["vega"]).unwrap_or(0.0),
                "open_interest": c["open_interest"].as_i64().unwrap_or(0),
                "volume": c["volume"].as_i64().unwrap_or(0),
                "moneyness": moneyness(strike, under, &right),
                "distance_pct": distance_pct(strike, under),
            })
        })
        .collect();

    let selected: Vec<Value> = if let Some(mny) = moneyness_filter {
        let mny = mny.to_uppercase();
        if mny == "ATM" {
            let lo = atm_idx.saturating_sub(count / 2);
            let mut hi = (lo + count).min(annotated.len());
            let lo = hi.saturating_sub(count);
            hi = hi.max(lo);
            annotated[lo..hi].to_vec()
        } else {
            let mut filtered: Vec<Value> = annotated
                .iter()
                .filter(|c| c["moneyness"].as_str() == Some(mny.as_str()))
                .cloned()
                .collect();
            filtered.sort_by(|a, b| (fopt(&a["strike"]).unwrap_or(0.0) - under).abs().partial_cmp(&(fopt(&b["strike"]).unwrap_or(0.0) - under).abs()).unwrap());
            filtered.truncate(count);
            filtered.sort_by(|a, b| fopt(&a["strike"]).unwrap_or(0.0).partial_cmp(&fopt(&b["strike"]).unwrap_or(0.0)).unwrap());
            filtered
        }
    } else {
        let lo = atm_idx.saturating_sub(count / 2);
        let mut hi = lo + count;
        let lo = if hi > annotated.len() {
            hi = annotated.len();
            hi.saturating_sub(count)
        } else {
            lo
        };
        annotated[lo..hi].to_vec()
    };

    Ok(json!({
        "symbol": symbol.to_uppercase(),
        "underlying_price": (under * 10000.0).round() / 10000.0,
        "expiration": exp,
        "right": right,
        "contracts": selected,
    }))
}

pub async fn get_option_flow(state: &AppState, symbol: &str, period: &str) -> ApiResult<Value> {
    let exps = get_option_expirations(state, symbol).await?;
    let exp = if period == "weekly" {
        exps.iter()
            .find(|e| NaiveDate::parse_from_str(e, "%Y-%m-%d").map(|d| !is_monthly(d)).unwrap_or(false))
            .or_else(|| exps.first())
            .cloned()
    } else {
        exps.first().cloned()
    };
    let chain = get_option_chain(state, symbol, exp.as_deref(), "all").await?;
    let calls: Vec<&Value> = chain.iter().filter(|c| c["type"].as_str() == Some("call")).collect();
    let puts: Vec<&Value> = chain.iter().filter(|c| c["type"].as_str() == Some("put")).collect();

    let agg = |rows: &[&Value]| -> Vec<Value> {
        rows.iter()
            .map(|r| {
                let mid = (fopt(&r["bid"]).unwrap_or(0.0) + fopt(&r["ask"]).unwrap_or(0.0)) / 2.0;
                let vol = r["volume"].as_i64().unwrap_or(0);
                json!({
                    "strike": r["strike"],
                    "volume": vol,
                    "open_interest": r["open_interest"],
                    "premium": ((vol as f64 * mid * 100.0) * 100.0).round() / 100.0,
                    "iv": r["implied_volatility"],
                })
            })
            .collect()
    };
    let total_call_vol: i64 = calls.iter().map(|c| c["volume"].as_i64().unwrap_or(0)).sum();
    let total_put_vol: i64 = puts.iter().map(|p| p["volume"].as_i64().unwrap_or(0)).sum();
    let mut unusual = vec![];
    for r in &chain {
        let oi = r["open_interest"].as_i64().unwrap_or(0).max(1);
        let vol = r["volume"].as_i64().unwrap_or(0);
        if vol > 2 * oi {
            let mid = (fopt(&r["bid"]).unwrap_or(0.0) + fopt(&r["ask"]).unwrap_or(0.0)) / 2.0;
            unusual.push(json!({
                "strike": r["strike"],
                "type": r["type"],
                "volume": vol,
                "oi": r["open_interest"],
                "vol_oi_ratio": ((vol as f64 / oi as f64) * 100.0).round() / 100.0,
                "premium": ((vol as f64 * mid * 100.0) * 100.0).round() / 100.0,
            }));
        }
    }
    unusual.sort_by(|a, b| fopt(&b["vol_oi_ratio"]).unwrap_or(0.0).partial_cmp(&fopt(&a["vol_oi_ratio"]).unwrap_or(0.0)).unwrap());
    unusual.truncate(10);

    Ok(json!({
        "expiration": exp.or_else(|| chain.first().and_then(|c| c["expiration"].as_str().map(|s| s.to_string()))),
        "calls": agg(&calls),
        "puts": agg(&puts),
        "put_call_ratio": ((total_put_vol as f64 / (total_call_vol.max(1)) as f64) * 10000.0).round() / 10000.0,
        "total_call_volume": total_call_vol,
        "total_put_volume": total_put_vol,
        "unusual": unusual,
    }))
}
