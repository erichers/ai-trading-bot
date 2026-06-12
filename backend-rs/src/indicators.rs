//! Hand-rolled technical indicators in pure Rust. Mirrors backend/services/indicators.py.

use serde_json::{json, Value};

fn round4(v: f64) -> Option<f64> {
    if v.is_nan() {
        None
    } else {
        Some((v * 10000.0).round() / 10000.0)
    }
}

/// Last non-NaN value, rounded to 4dp.
fn last(series: &[f64]) -> Option<f64> {
    for v in series.iter().rev() {
        if !v.is_nan() {
            return round4(*v);
        }
    }
    None
}

fn sma(close: &[f64], period: usize) -> Vec<f64> {
    let n = close.len();
    let mut out = vec![f64::NAN; n];
    if period == 0 {
        return out;
    }
    for i in 0..n {
        if i + 1 >= period {
            let sum: f64 = close[i + 1 - period..=i].iter().sum();
            out[i] = sum / period as f64;
        }
    }
    out
}

fn ema(close: &[f64], period: usize) -> Vec<f64> {
    // ewm span, adjust=False
    let n = close.len();
    let mut out = vec![f64::NAN; n];
    if n == 0 || period == 0 {
        return out;
    }
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut prev = close[0];
    out[0] = prev;
    for i in 1..n {
        prev = alpha * close[i] + (1.0 - alpha) * prev;
        out[i] = prev;
    }
    out
}

/// ewm with explicit alpha, adjust=False, min_periods.
fn ewm_alpha(vals: &[f64], alpha: f64, min_periods: usize) -> Vec<f64> {
    let n = vals.len();
    let mut out = vec![f64::NAN; n];
    if n == 0 {
        return out;
    }
    let mut prev = f64::NAN;
    let mut count = 0usize;
    for i in 0..n {
        let x = vals[i];
        if prev.is_nan() {
            prev = x;
        } else {
            prev = alpha * x + (1.0 - alpha) * prev;
        }
        count += 1;
        if count >= min_periods.max(1) {
            out[i] = prev;
        }
    }
    out
}

fn diff(vals: &[f64]) -> Vec<f64> {
    let n = vals.len();
    let mut out = vec![f64::NAN; n];
    for i in 1..n {
        out[i] = vals[i] - vals[i - 1];
    }
    out
}

fn rsi(close: &[f64], period: usize) -> Vec<f64> {
    let d = diff(close);
    let gain: Vec<f64> = d.iter().map(|x| if x.is_nan() { f64::NAN } else { x.max(0.0) }).collect();
    let loss: Vec<f64> = d.iter().map(|x| if x.is_nan() { f64::NAN } else { (-x).max(0.0) }).collect();
    // pandas ewm on series whose first elem is NaN: treat NaN as skipped seed.
    let alpha = 1.0 / period as f64;
    let avg_gain = ewm_skipnan(&gain, alpha, period);
    let avg_loss = ewm_skipnan(&loss, alpha, period);
    let n = close.len();
    let mut out = vec![f64::NAN; n];
    for i in 0..n {
        let ag = avg_gain[i];
        let al = avg_loss[i];
        if ag.is_nan() || al.is_nan() {
            continue;
        }
        if al == 0.0 {
            out[i] = 100.0;
        } else {
            let rs = ag / al;
            out[i] = 100.0 - (100.0 / (1.0 + rs));
        }
    }
    out
}

/// ewm honoring leading NaN (first valid becomes seed), adjust=False, min_periods.
fn ewm_skipnan(vals: &[f64], alpha: f64, min_periods: usize) -> Vec<f64> {
    let n = vals.len();
    let mut out = vec![f64::NAN; n];
    let mut prev = f64::NAN;
    let mut count = 0usize;
    for i in 0..n {
        let x = vals[i];
        if x.is_nan() {
            // pandas keeps the running mean across NaN but doesn't count it
            if !prev.is_nan() && count >= min_periods {
                out[i] = prev;
            }
            continue;
        }
        if prev.is_nan() {
            prev = x;
        } else {
            prev = alpha * x + (1.0 - alpha) * prev;
        }
        count += 1;
        if count >= min_periods.max(1) {
            out[i] = prev;
        }
    }
    out
}

fn macd(close: &[f64]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let fast = ema(close, 12);
    let slow = ema(close, 26);
    let n = close.len();
    let macd_line: Vec<f64> = (0..n).map(|i| fast[i] - slow[i]).collect();
    let signal_line = ema(&macd_line, 9);
    let hist: Vec<f64> = (0..n).map(|i| macd_line[i] - signal_line[i]).collect();
    (macd_line, signal_line, hist)
}

fn stddev(vals: &[f64], period: usize) -> Vec<f64> {
    // pandas rolling std uses ddof=1 (sample).
    let n = vals.len();
    let mut out = vec![f64::NAN; n];
    for i in 0..n {
        if i + 1 >= period {
            let win = &vals[i + 1 - period..=i];
            let mean: f64 = win.iter().sum::<f64>() / period as f64;
            let var: f64 = win.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (period as f64 - 1.0);
            out[i] = var.sqrt();
        }
    }
    out
}

fn bbands(close: &[f64]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mid = sma(close, 20);
    let sd = stddev(close, 20);
    let n = close.len();
    let upper: Vec<f64> = (0..n).map(|i| mid[i] + 2.0 * sd[i]).collect();
    let lower: Vec<f64> = (0..n).map(|i| mid[i] - 2.0 * sd[i]).collect();
    (upper, mid, lower)
}

fn true_range(high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
    let n = high.len();
    let mut tr = vec![f64::NAN; n];
    for i in 0..n {
        let hl = high[i] - low[i];
        if i == 0 {
            tr[i] = hl;
        } else {
            let pc = close[i - 1];
            tr[i] = hl.max((high[i] - pc).abs()).max((low[i] - pc).abs());
        }
    }
    tr
}

fn atr(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let tr = true_range(high, low, close);
    ewm_alpha(&tr, 1.0 / period as f64, period)
}

fn vwap(high: &[f64], low: &[f64], close: &[f64], vol: &[f64]) -> Vec<f64> {
    let n = high.len();
    let mut out = vec![f64::NAN; n];
    let mut cum_vol = 0.0;
    let mut cum_tpv = 0.0;
    for i in 0..n {
        let typical = (high[i] + low[i] + close[i]) / 3.0;
        cum_vol += vol[i];
        cum_tpv += typical * vol[i];
        if cum_vol != 0.0 {
            out[i] = cum_tpv / cum_vol;
        }
    }
    out
}

fn adx(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let n = high.len();
    let up = diff(high);
    let down_raw = diff(low);
    let down: Vec<f64> = down_raw.iter().map(|x| -x).collect();
    let mut plus_dm = vec![f64::NAN; n];
    let mut minus_dm = vec![f64::NAN; n];
    for i in 0..n {
        let u = up[i];
        let d = down[i];
        if u.is_nan() || d.is_nan() {
            plus_dm[i] = 0.0;
            minus_dm[i] = 0.0;
            continue;
        }
        plus_dm[i] = if u > d && u > 0.0 { u } else { 0.0 };
        minus_dm[i] = if d > u && d > 0.0 { d } else { 0.0 };
    }
    let tr = true_range(high, low, close);
    let alpha = 1.0 / period as f64;
    let atr_ = ewm_alpha(&tr, alpha, period);
    let plus_sm = ewm_alpha(&plus_dm, alpha, period);
    let minus_sm = ewm_alpha(&minus_dm, alpha, period);
    let mut dx = vec![f64::NAN; n];
    for i in 0..n {
        if atr_[i].is_nan() || atr_[i] == 0.0 {
            continue;
        }
        let plus_di = 100.0 * plus_sm[i] / atr_[i];
        let minus_di = 100.0 * minus_sm[i] / atr_[i];
        let denom = plus_di + minus_di;
        if denom == 0.0 {
            continue;
        }
        dx[i] = 100.0 * (plus_di - minus_di).abs() / denom;
    }
    ewm_alpha_skipnan(&dx, alpha, period)
}

fn ewm_alpha_skipnan(vals: &[f64], alpha: f64, min_periods: usize) -> Vec<f64> {
    ewm_skipnan(vals, alpha, min_periods)
}

fn stoch(high: &[f64], low: &[f64], close: &[f64], k: usize, d: usize) -> (Vec<f64>, Vec<f64>) {
    let n = high.len();
    let mut k_line = vec![f64::NAN; n];
    for i in 0..n {
        if i + 1 >= k {
            let lo = low[i + 1 - k..=i].iter().cloned().fold(f64::INFINITY, f64::min);
            let hi = high[i + 1 - k..=i].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let denom = hi - lo;
            if denom != 0.0 {
                k_line[i] = 100.0 * (close[i] - lo) / denom;
            }
        }
    }
    let d_line = sma(&k_line, d);
    (k_line, d_line)
}

fn obv(close: &[f64], vol: &[f64]) -> Vec<f64> {
    let n = close.len();
    let mut out = vec![f64::NAN; n];
    let mut cum = 0.0;
    for i in 0..n {
        let dir = if i == 0 {
            0.0
        } else if close[i] > close[i - 1] {
            1.0
        } else if close[i] < close[i - 1] {
            -1.0
        } else {
            0.0
        };
        cum += dir * vol[i];
        out[i] = cum;
    }
    out
}

fn extract(bars: &[Value], key: &str) -> Vec<f64> {
    bars.iter()
        .map(|b| match &b[key] {
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            _ => f64::NAN,
        })
        .collect()
}

pub fn compute_all(bars: &[Value]) -> Value {
    if bars.is_empty() {
        return empty_snapshot();
    }
    let close = extract(bars, "c");
    let high = extract(bars, "h");
    let low = extract(bars, "l");
    let vol = extract(bars, "v");

    let (macd_line, signal_line, hist) = macd(&close);
    let (upper, mid, lower) = bbands(&close);
    let (k_line, d_line) = stoch(&high, &low, &close, 14, 3);

    json!({
        "sma20": last(&sma(&close, 20)),
        "sma50": last(&sma(&close, 50)),
        "sma200": last(&sma(&close, 200)),
        "ema9": last(&ema(&close, 9)),
        "ema21": last(&ema(&close, 21)),
        "rsi14": last(&rsi(&close, 14)),
        "macd": {
            "macd": last(&macd_line),
            "signal": last(&signal_line),
            "hist": last(&hist),
        },
        "bbands": {
            "upper": last(&upper),
            "mid": last(&mid),
            "lower": last(&lower),
        },
        "atr14": last(&atr(&high, &low, &close, 14)),
        "vwap": last(&vwap(&high, &low, &close, &vol)),
        "adx14": last(&adx(&high, &low, &close, 14)),
        "stoch": {"k": last(&k_line), "d": last(&d_line)},
        "obv": last(&obv(&close, &vol)),
        "volume": last(&vol),
        "avg_volume20": last(&sma(&vol, 20)),
    })
}

fn empty_snapshot() -> Value {
    json!({
        "sma20": null, "sma50": null, "sma200": null, "ema9": null, "ema21": null,
        "rsi14": null, "macd": {"macd": null, "signal": null, "hist": null},
        "bbands": {"upper": null, "mid": null, "lower": null}, "atr14": null,
        "vwap": null, "adx14": null, "stoch": {"k": null, "d": null}, "obv": null,
        "volume": null, "avg_volume20": null,
    })
}

pub fn catalog() -> Value {
    json!([
        {"id": "sma", "name": "Simple Moving Average", "params": {"period": 20},
         "description": "Average closing price over N periods."},
        {"id": "ema", "name": "Exponential Moving Average", "params": {"period": 21},
         "description": "Weighted moving average emphasizing recent prices."},
        {"id": "rsi", "name": "Relative Strength Index", "params": {"period": 14},
         "description": "Momentum oscillator (0-100); >70 overbought, <30 oversold."},
        {"id": "macd", "name": "MACD", "params": {"fast": 12, "slow": 26, "signal": 9},
         "description": "Trend/momentum from EMA crossovers with signal & histogram."},
        {"id": "bbands", "name": "Bollinger Bands", "params": {"period": 20, "stddev": 2},
         "description": "Volatility bands around an SMA at +/- N standard deviations."},
        {"id": "atr", "name": "Average True Range", "params": {"period": 14},
         "description": "Volatility measure of average trading range."},
        {"id": "vwap", "name": "Volume Weighted Average Price", "params": {},
         "description": "Average price weighted by volume across the session."},
        {"id": "stoch", "name": "Stochastic Oscillator", "params": {"k": 14, "d": 3},
         "description": "Momentum oscillator comparing close to recent range."},
        {"id": "adx", "name": "Average Directional Index", "params": {"period": 14},
         "description": "Trend strength indicator (0-100)."},
        {"id": "obv", "name": "On-Balance Volume", "params": {},
         "description": "Cumulative volume flow confirming price trends."},
        {"id": "volume", "name": "Volume", "params": {},
         "description": "Raw traded volume and its 20-period average."}
    ])
}
