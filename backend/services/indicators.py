"""Hand-rolled technical indicators in pure pandas (no native build deps)."""
from __future__ import annotations

import math
from typing import Any

import pandas as pd


def _bars_to_df(bars: list[dict]) -> pd.DataFrame:
    if not bars:
        return pd.DataFrame(columns=["o", "h", "l", "c", "v"])
    df = pd.DataFrame(bars)
    for col in ("o", "h", "l", "c", "v"):
        if col in df:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def _last(series: pd.Series) -> float | None:
    s = series.dropna()
    if s.empty:
        return None
    val = float(s.iloc[-1])
    return None if math.isnan(val) else round(val, 4)


def sma(close: pd.Series, period: int) -> pd.Series:
    return close.rolling(window=period, min_periods=period).mean()


def ema(close: pd.Series, period: int) -> pd.Series:
    return close.ewm(span=period, adjust=False).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, pd.NA)
    return 100 - (100 / (1 + rs))


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def bbands(close: pd.Series, period: int = 20, stds: float = 2.0):
    mid = sma(close, period)
    std = close.rolling(window=period, min_periods=period).std()
    upper = mid + stds * std
    lower = mid - stds * std
    return upper, mid, lower


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def vwap(high: pd.Series, low: pd.Series, close: pd.Series, vol: pd.Series) -> pd.Series:
    typical = (high + low + close) / 3
    cum_vol = vol.cumsum()
    cum_tpv = (typical * vol).cumsum()
    return cum_tpv / cum_vol.replace(0, pd.NA)


def adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    up = high.diff()
    down = -low.diff()
    plus_dm = ((up > down) & (up > 0)) * up
    minus_dm = ((down > up) & (down > 0)) * down
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr_ = tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr_
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr_
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, pd.NA)
    return dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def stoch(high: pd.Series, low: pd.Series, close: pd.Series, k: int = 14, d: int = 3):
    lowest = low.rolling(window=k, min_periods=k).min()
    highest = high.rolling(window=k, min_periods=k).max()
    k_line = 100 * (close - lowest) / (highest - lowest).replace(0, pd.NA)
    d_line = k_line.rolling(window=d, min_periods=d).mean()
    return k_line, d_line


def obv(close: pd.Series, vol: pd.Series) -> pd.Series:
    direction = close.diff().apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
    return (direction * vol).cumsum()


def compute_all(bars: list[dict]) -> dict[str, Any]:
    df = _bars_to_df(bars)
    if df.empty or "c" not in df:
        return _empty_snapshot()
    close, high, low, vol = df["c"], df["h"], df["l"], df["v"]

    macd_line, signal_line, hist = macd(close)
    upper, mid, lower = bbands(close)
    k_line, d_line = stoch(high, low, close)

    return {
        "sma20": _last(sma(close, 20)),
        "sma50": _last(sma(close, 50)),
        "sma200": _last(sma(close, 200)),
        "ema9": _last(ema(close, 9)),
        "ema21": _last(ema(close, 21)),
        "rsi14": _last(rsi(close, 14)),
        "macd": {
            "macd": _last(macd_line),
            "signal": _last(signal_line),
            "hist": _last(hist),
        },
        "bbands": {
            "upper": _last(upper),
            "mid": _last(mid),
            "lower": _last(lower),
        },
        "atr14": _last(atr(high, low, close, 14)),
        "vwap": _last(vwap(high, low, close, vol)),
        "adx14": _last(adx(high, low, close, 14)),
        "stoch": {"k": _last(k_line), "d": _last(d_line)},
        "obv": _last(obv(close, vol)),
        "volume": _last(vol),
        "avg_volume20": _last(sma(vol, 20)),
    }


def _empty_snapshot() -> dict[str, Any]:
    return {
        "sma20": None, "sma50": None, "sma200": None, "ema9": None, "ema21": None,
        "rsi14": None, "macd": {"macd": None, "signal": None, "hist": None},
        "bbands": {"upper": None, "mid": None, "lower": None}, "atr14": None,
        "vwap": None, "adx14": None, "stoch": {"k": None, "d": None}, "obv": None,
        "volume": None, "avg_volume20": None,
    }


CATALOG = [
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
     "description": "Raw traded volume and its 20-period average."},
]
