"""Deterministic-ish mock data generators used when live APIs are unreachable.

Every external call falls back to these so the app never 500s due to missing creds.
"""
from __future__ import annotations

import hashlib
import math
import random
from datetime import datetime, timedelta, timezone

# Rough seed prices so the same symbol looks consistent across calls.
_SEED_PRICES = {
    "AAPL": 225.0, "MSFT": 430.0, "NVDA": 135.0, "TSLA": 250.0,
    "SPY": 560.0, "QQQ": 480.0, "AMZN": 185.0, "GOOGL": 175.0,
    "META": 580.0, "AMD": 160.0, "NFLX": 700.0, "INTC": 22.0,
}

_NAMES = {
    "AAPL": "Apple Inc.", "MSFT": "Microsoft Corporation", "NVDA": "NVIDIA Corporation",
    "TSLA": "Tesla, Inc.", "SPY": "SPDR S&P 500 ETF Trust", "QQQ": "Invesco QQQ Trust",
    "AMZN": "Amazon.com, Inc.", "GOOGL": "Alphabet Inc.", "META": "Meta Platforms, Inc.",
    "AMD": "Advanced Micro Devices, Inc.", "NFLX": "Netflix, Inc.", "INTC": "Intel Corporation",
}

_NEWS_SOURCES = ["Bloomberg", "Reuters", "CNBC", "MarketWatch", "Barron's", "WSJ"]
_NEWS_TEMPLATES = [
    "{sym} shares move as analysts weigh in on quarterly outlook",
    "{name} unveils new product line, investors react",
    "{sym} options activity spikes ahead of earnings",
    "Wall Street raises price target on {sym}",
    "{name} faces regulatory scrutiny in key market",
    "{sym} rallies on upbeat guidance",
    "Sector rotation pressures {sym} despite strong fundamentals",
]


def _seed_price(symbol: str) -> float:
    if symbol in _SEED_PRICES:
        return _SEED_PRICES[symbol]
    h = int(hashlib.sha256(symbol.encode()).hexdigest(), 16)
    return 20.0 + (h % 50000) / 100.0  # $20–$520


def company_name(symbol: str) -> str:
    return _NAMES.get(symbol, f"{symbol} Holdings Inc.")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def mock_account() -> dict:
    equity = 102_345.67
    last_equity = 101_200.00
    day_pl = equity - last_equity
    return {
        "equity": equity,
        "buying_power": 198_000.00,
        "cash": 50_000.00,
        "portfolio_value": equity,
        "last_equity": last_equity,
        "day_pl": round(day_pl, 2),
        "day_pl_pct": round(day_pl / last_equity * 100, 4),
        "daytrade_count": 1,
        "status": "ACTIVE",
    }


def mock_positions() -> list[dict]:
    out = []
    for sym, qty, side in [("AAPL", 50, "long"), ("NVDA", 100, "long"), ("TSLA", 20, "long")]:
        entry = _seed_price(sym) * 0.96
        cur = _seed_price(sym) * random.uniform(0.98, 1.04)
        mv = cur * qty
        upl = (cur - entry) * qty
        out.append({
            "symbol": sym,
            "qty": float(qty),
            "side": side,
            "avg_entry_price": round(entry, 2),
            "current_price": round(cur, 2),
            "market_value": round(mv, 2),
            "unrealized_pl": round(upl, 2),
            "unrealized_plpc": round(upl / (entry * qty), 4),
            "change_today": round(random.uniform(-0.03, 0.03), 4),
        })
    return out


def mock_orders(status: str = "all") -> list[dict]:
    base = datetime.now(timezone.utc)
    orders = [
        {
            "id": "mock-order-1", "symbol": "AAPL", "qty": 50.0, "side": "buy",
            "type": "limit", "time_in_force": "gtc", "status": "new",
            "limit_price": 220.0, "stop_price": None, "filled_avg_price": None,
            "filled_qty": 0.0, "submitted_at": (base - timedelta(minutes=10)).isoformat(),
        },
        {
            "id": "mock-order-2", "symbol": "NVDA", "qty": 100.0, "side": "buy",
            "type": "market", "time_in_force": "day", "status": "filled",
            "limit_price": None, "stop_price": None, "filled_avg_price": 134.5,
            "filled_qty": 100.0, "submitted_at": (base - timedelta(hours=2)).isoformat(),
        },
    ]
    if status == "open":
        return [o for o in orders if o["status"] in ("new", "accepted", "partially_filled")]
    if status == "closed":
        return [o for o in orders if o["status"] in ("filled", "canceled", "expired")]
    return orders


def mock_clock() -> dict:
    now = datetime.now(timezone.utc)
    is_open = now.weekday() < 5 and 13 <= now.hour < 20  # rough US market hours UTC
    return {
        "is_open": is_open,
        "next_open": (now + timedelta(days=1)).replace(hour=13, minute=30).isoformat(),
        "next_close": now.replace(hour=20, minute=0).isoformat(),
        "timestamp": now.isoformat(),
    }


def mock_calendar(start: str | None, end: str | None) -> list[dict]:
    out = []
    day = datetime.now(timezone.utc).date()
    for i in range(5):
        d = day + timedelta(days=i)
        if d.weekday() < 5:
            out.append({
                "date": d.isoformat(),
                "open": "09:30", "close": "16:00",
                "session_open": "07:00", "session_close": "19:00",
            })
    return out


def mock_assets(search: str, limit: int) -> list[dict]:
    universe = list(_SEED_PRICES.keys()) + ["AMZN", "GOOGL", "META", "AMD", "NFLX", "INTC"]
    q = (search or "").upper()
    matches = [s for s in dict.fromkeys(universe) if q in s] if q else list(dict.fromkeys(universe))
    return [
        {
            "symbol": s, "name": company_name(s), "exchange": "NASDAQ",
            "asset_class": "us_equity", "tradable": True,
        }
        for s in matches[:limit]
    ]


def mock_bars(symbol: str, timeframe: str, limit: int) -> list[dict]:
    """Random-walk OHLCV bars ending now."""
    price = _seed_price(symbol)
    rng = random.Random(hashlib.sha256(f"{symbol}{timeframe}".encode()).hexdigest())
    minutes = {"1Min": 1, "5Min": 5, "15Min": 15, "1Hour": 60, "1Day": 1440}.get(timeframe, 1440)
    bars = []
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes * limit)
    p = price * 0.95
    for _ in range(limit):
        drift = rng.uniform(-0.01, 0.012)
        o = p
        c = max(0.5, p * (1 + drift))
        hi = max(o, c) * (1 + abs(rng.uniform(0, 0.006)))
        lo = min(o, c) * (1 - abs(rng.uniform(0, 0.006)))
        vol = int(rng.uniform(500_000, 5_000_000))
        bars.append({
            "t": t.isoformat(),
            "o": round(o, 2), "h": round(hi, 2), "l": round(lo, 2),
            "c": round(c, 2), "v": vol,
        })
        p = c
        t += timedelta(minutes=minutes)
    return bars


def mock_quote(symbol: str) -> dict:
    p = _seed_price(symbol) * random.uniform(0.99, 1.01)
    spread = max(0.01, p * 0.0005)
    return {
        "symbol": symbol,
        "bid": round(p - spread, 2),
        "ask": round(p + spread, 2),
        "bid_size": random.randint(1, 50) * 100,
        "ask_size": random.randint(1, 50) * 100,
        "last": round(p, 2),
        "timestamp": now_iso(),
    }


def mock_snapshot(symbol: str) -> dict:
    prev = _seed_price(symbol)
    price = prev * random.uniform(0.97, 1.03)
    change = price - prev
    return {
        "symbol": symbol,
        "price": round(price, 2),
        "change": round(change, 2),
        "change_pct": round(change / prev * 100, 4),
        "volume": random.randint(1_000_000, 50_000_000),
        "high": round(price * 1.012, 2),
        "low": round(price * 0.988, 2),
        "open": round(prev * 1.001, 2),
        "prev_close": round(prev, 2),
    }


def mock_news(symbols: list[str], limit: int) -> list[dict]:
    syms = symbols or ["SPY", "AAPL", "NVDA"]
    out = []
    base = datetime.now(timezone.utc)
    for i in range(limit):
        sym = syms[i % len(syms)]
        tmpl = _NEWS_TEMPLATES[i % len(_NEWS_TEMPLATES)]
        headline = tmpl.format(sym=sym, name=company_name(sym))
        out.append({
            "id": f"mock-news-{i}",
            "headline": headline,
            "summary": f"{headline}. Market participants are watching closely as the story develops.",
            "source": _NEWS_SOURCES[i % len(_NEWS_SOURCES)],
            "author": "Staff Reporter",
            "url": f"https://example.com/news/{sym.lower()}/{i}",
            "created_at": (base - timedelta(minutes=i * 17)).isoformat(),
            "symbols": [sym],
            "image": f"https://placehold.co/600x400?text={sym}",
        })
    return out


def _expirations(symbol: str) -> list[str]:
    today = datetime.now(timezone.utc).date()
    out = []
    # next 8 Fridays (weeklies) — 3rd Friday of month flagged as monthly elsewhere
    d = today
    found = 0
    while found < 8:
        d += timedelta(days=1)
        if d.weekday() == 4:
            out.append(d.isoformat())
            found += 1
    return out


def mock_expirations(symbol: str) -> list[str]:
    return _expirations(symbol)


def mock_option_chain(symbol: str, expiration: str | None, opt_type: str) -> list[dict]:
    spot = _seed_price(symbol)
    exp = expiration or _expirations(symbol)[0]
    strikes = [round(spot * (1 + i * 0.025), 1) for i in range(-6, 7)]
    rng = random.Random(hashlib.sha256(f"{symbol}{exp}".encode()).hexdigest())
    out = []
    types = ["call", "put"] if opt_type == "all" else [opt_type]
    for strike in strikes:
        for t in types:
            moneyness = (spot - strike) if t == "call" else (strike - spot)
            intrinsic = max(0.0, moneyness)
            extrinsic = rng.uniform(0.5, 6.0)
            last = round(intrinsic + extrinsic, 2)
            bid = round(max(0.01, last - 0.15), 2)
            ask = round(last + 0.15, 2)
            delta = 0.5 + moneyness / (spot * 0.4)
            delta = max(0.02, min(0.98, delta))
            if t == "put":
                delta = -delta
            out.append({
                "symbol": f"{symbol}{exp.replace('-', '')[2:]}{t[0].upper()}{int(strike * 1000):08d}",
                "strike": strike, "type": t, "expiration": exp,
                "bid": bid, "ask": ask, "last": last,
                "volume": rng.randint(0, 8000),
                "open_interest": rng.randint(100, 20000),
                "implied_volatility": round(rng.uniform(0.2, 0.8), 4),
                "delta": round(delta, 4),
                "gamma": round(rng.uniform(0.001, 0.05), 4),
                "theta": round(-rng.uniform(0.01, 0.2), 4),
                "vega": round(rng.uniform(0.05, 0.3), 4),
            })
    return out


def mock_option_flow(symbol: str, period: str) -> dict:
    chain = mock_option_chain(symbol, None, "all")
    exp = chain[0]["expiration"] if chain else _expirations(symbol)[0]
    calls = [c for c in chain if c["type"] == "call"]
    puts = [c for c in chain if c["type"] == "put"]

    def agg(rows):
        return [
            {
                "strike": r["strike"], "volume": r["volume"],
                "open_interest": r["open_interest"],
                "premium": round(r["last"] * r["volume"] * 100, 2),
                "iv": r["implied_volatility"],
            }
            for r in rows
        ]

    total_call_vol = sum(c["volume"] for c in calls)
    total_put_vol = sum(p["volume"] for p in puts)
    unusual = []
    for r in chain:
        oi = max(1, r["open_interest"])
        ratio = r["volume"] / oi
        if ratio > 2.0:
            unusual.append({
                "strike": r["strike"], "type": r["type"], "volume": r["volume"],
                "oi": r["open_interest"], "vol_oi_ratio": round(ratio, 2),
                "premium": round(r["last"] * r["volume"] * 100, 2),
            })
    return {
        "expiration": exp,
        "calls": agg(calls),
        "puts": agg(puts),
        "put_call_ratio": round(total_put_vol / max(1, total_call_vol), 4),
        "total_call_volume": total_call_vol,
        "total_put_volume": total_put_vol,
        "unusual": sorted(unusual, key=lambda x: -x["vol_oi_ratio"])[:10],
    }
