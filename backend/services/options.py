"""REAL options data via alpaca-py with graceful mock fallback.

- Expirations: TradingClient.get_option_contracts (paginated) → distinct dates.
- Chain: OptionHistoricalDataClient.get_option_chain → mapped contract list.
- Flow: aggregated from the real chain for the relevant expiration.

Every call falls back to services.mock.* on failure / empty so the UI keeps working.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from config import logger, settings
from services import mock

# ---- Lazy SDK import --------------------------------------------------------
_sdk_ok = False
try:
    from alpaca.trading.client import TradingClient
    from alpaca.trading.requests import GetOptionContractsRequest
    from alpaca.data.historical.option import OptionHistoricalDataClient
    from alpaca.data.requests import OptionChainRequest
    from alpaca.data.enums import OptionsFeed

    _sdk_ok = True
except Exception as exc:  # pragma: no cover
    logger.warning("alpaca options SDK not importable (%s) — options mock-only.", exc)
    _sdk_ok = False

_trading_client = None
_option_client = None

# OCC option symbol: ROOT(1-6) + YYMMDD(6) + C|P + strike*1000 padded to 8.
OCC_RE = re.compile(r"^([A-Z]{1,6})(\d{6})([CP])(\d{8})$")


def _trading():
    global _trading_client
    if not (_sdk_ok and settings.alpaca_configured):
        return None
    if _trading_client is None:
        _trading_client = TradingClient(
            settings.alpaca_api_key, settings.alpaca_secret_key,
            paper=settings.alpaca_paper_trade,
        )
    return _trading_client


def _option_data():
    global _option_client
    if not (_sdk_ok and settings.alpaca_configured):
        return None
    if _option_client is None:
        _option_client = OptionHistoricalDataClient(
            settings.alpaca_api_key, settings.alpaca_secret_key
        )
    return _option_client


def _feed():
    val = (settings.alpaca_options_feed or "indicative").lower()
    try:
        return OptionsFeed.OPRA if val == "opra" else OptionsFeed.INDICATIVE
    except Exception:
        return None


# ---- OCC parsing ------------------------------------------------------------
def parse_occ(occ: str) -> dict[str, Any] | None:
    m = OCC_RE.match(occ.strip().upper())
    if not m:
        return None
    root, ymd, cp, strike_raw = m.groups()
    try:
        exp = datetime.strptime(ymd, "%y%m%d").date().isoformat()
    except ValueError:
        return None
    return {
        "root": root,
        "expiration": exp,
        "type": "call" if cp == "C" else "put",
        "strike": int(strike_raw) / 1000.0,
    }


def is_occ_symbol(symbol: str) -> bool:
    return bool(OCC_RE.match((symbol or "").strip().upper()))


def _is_monthly(d: date) -> bool:
    # Monthly = the 3rd Friday of its month.
    return d.weekday() == 4 and 15 <= d.day <= 21


# ---- Expirations ------------------------------------------------------------
def get_option_expirations(symbol: str) -> list[str]:
    client = _trading()
    if client is None:
        return mock.mock_expirations(symbol)
    try:
        today = datetime.now(timezone.utc).date()
        seen: set[str] = set()
        page_token = None
        pages = 0
        while pages < 10:
            req = GetOptionContractsRequest(
                underlying_symbols=[symbol],
                expiration_date_gte=today,
                limit=10000,
                page_token=page_token,
            )
            resp = client.get_option_contracts(req)
            contracts = getattr(resp, "option_contracts", None) or []
            for c in contracts:
                exp = getattr(c, "expiration_date", None)
                if exp:
                    seen.add(exp.isoformat() if hasattr(exp, "isoformat") else str(exp))
            page_token = getattr(resp, "next_page_token", None)
            pages += 1
            if not page_token:
                break
        out = sorted(seen)
        return out or mock.mock_expirations(symbol)
    except Exception as exc:
        logger.warning("get_option_expirations failed for %s (%s) — mock.", symbol, exc)
        return mock.mock_expirations(symbol)


def expirations_with_type(symbol: str) -> list[dict[str, Any]]:
    out = []
    for e in get_option_expirations(symbol):
        try:
            d = datetime.fromisoformat(e).date()
            t = "monthly" if _is_monthly(d) else "weekly"
        except Exception:
            t = "weekly"
        out.append({"date": e, "type": t})
    return out


# ---- Chain ------------------------------------------------------------------
def _f(x) -> float | None:
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


def _snapshot_to_contract(occ: str, snap: Any) -> dict[str, Any] | None:
    parsed = parse_occ(occ)
    if not parsed:
        return None
    quote = getattr(snap, "latest_quote", None)
    trade = getattr(snap, "latest_trade", None)
    greeks = getattr(snap, "greeks", None)
    bid = _f(getattr(quote, "bid_price", None)) if quote else None
    ask = _f(getattr(quote, "ask_price", None)) if quote else None
    last = _f(getattr(trade, "price", None)) if trade else None
    bid_size = _f(getattr(quote, "bid_size", None)) if quote else None
    ask_size = _f(getattr(quote, "ask_size", None)) if quote else None
    volume = int(getattr(trade, "size", 0) or 0) if trade else 0
    return {
        "symbol": occ,
        "strike": parsed["strike"],
        "type": parsed["type"],
        "expiration": parsed["expiration"],
        "bid": bid or 0.0,
        "ask": ask or 0.0,
        "last": last if last is not None else round(((bid or 0.0) + (ask or 0.0)) / 2, 2),
        "bid_size": bid_size or 0.0,
        "ask_size": ask_size or 0.0,
        "volume": volume,
        "open_interest": int(getattr(snap, "open_interest", 0) or 0),
        "implied_volatility": round(_f(getattr(snap, "implied_volatility", None)) or 0.0, 6),
        "delta": round(_f(getattr(greeks, "delta", None)) or 0.0, 6) if greeks else 0.0,
        "gamma": round(_f(getattr(greeks, "gamma", None)) or 0.0, 6) if greeks else 0.0,
        "theta": round(_f(getattr(greeks, "theta", None)) or 0.0, 6) if greeks else 0.0,
        "vega": round(_f(getattr(greeks, "vega", None)) or 0.0, 6) if greeks else 0.0,
    }


def get_option_chain(symbol: str, expiration: str | None, opt_type: str) -> list[dict[str, Any]]:
    client = _option_data()
    if client is None:
        return mock.mock_option_chain(symbol, expiration, opt_type)
    try:
        exp = expiration
        if not exp:
            exps = get_option_expirations(symbol)
            exp = exps[0] if exps else None
        kwargs: dict[str, Any] = {"underlying_symbol": symbol}
        feed = _feed()
        if feed is not None:
            kwargs["feed"] = feed
        if exp:
            kwargs["expiration_date"] = datetime.fromisoformat(exp).date()
        req = OptionChainRequest(**kwargs)
        chain = client.get_option_chain(req)
        out: list[dict[str, Any]] = []
        for occ, snap in (chain or {}).items():
            contract = _snapshot_to_contract(occ, snap)
            if contract:
                out.append(contract)
        if opt_type in ("call", "put"):
            out = [c for c in out if c["type"] == opt_type]
        out.sort(key=lambda c: (c["expiration"], c["type"], c["strike"]))
        if not out:
            logger.warning("get_option_chain empty for %s %s — mock.", symbol, exp)
            return mock.mock_option_chain(symbol, expiration, opt_type)
        return out
    except Exception as exc:
        logger.warning("get_option_chain failed for %s (%s) — mock.", symbol, exc)
        return mock.mock_option_chain(symbol, expiration, opt_type)


# ---- Flow -------------------------------------------------------------------
def _nearest_expiration(symbol: str, period: str) -> str | None:
    exps = get_option_expirations(symbol)
    if not exps:
        return None
    if period == "weekly":
        for e in exps:
            try:
                if not _is_monthly(datetime.fromisoformat(e).date()):
                    return e
            except Exception:
                continue
    return exps[0]


def get_option_flow(symbol: str, period: str) -> dict[str, Any]:
    client = _option_data()
    if client is None:
        return mock.mock_option_flow(symbol, period)
    try:
        exp = _nearest_expiration(symbol, period)
        chain = get_option_chain(symbol, exp, "all")
        # If the chain came back mock-shaped (no greeks at all), still aggregate it.
        if not chain:
            return mock.mock_option_flow(symbol, period)

        calls = [c for c in chain if c["type"] == "call"]
        puts = [c for c in chain if c["type"] == "put"]

        def agg(rows):
            out = []
            for r in rows:
                mid = ((r.get("bid") or 0.0) + (r.get("ask") or 0.0)) / 2
                out.append({
                    "strike": r["strike"],
                    "volume": r["volume"],
                    "open_interest": r["open_interest"],
                    "premium": round(r["volume"] * mid * 100, 2),
                    "iv": r["implied_volatility"],
                })
            return out

        total_call_vol = sum(c["volume"] for c in calls)
        total_put_vol = sum(p["volume"] for p in puts)
        unusual = []
        for r in chain:
            oi = max(1, r["open_interest"])
            if r["volume"] > 2 * oi:
                mid = ((r.get("bid") or 0.0) + (r.get("ask") or 0.0)) / 2
                unusual.append({
                    "strike": r["strike"],
                    "type": r["type"],
                    "volume": r["volume"],
                    "oi": r["open_interest"],
                    "vol_oi_ratio": round(r["volume"] / oi, 2),
                    "premium": round(r["volume"] * mid * 100, 2),
                })
        return {
            "expiration": exp or (chain[0]["expiration"] if chain else None),
            "calls": agg(calls),
            "puts": agg(puts),
            "put_call_ratio": round(total_put_vol / max(1, total_call_vol), 4),
            "total_call_volume": total_call_vol,
            "total_put_volume": total_put_vol,
            "unusual": sorted(unusual, key=lambda x: -x["vol_oi_ratio"])[:10],
        }
    except Exception as exc:
        logger.warning("get_option_flow failed for %s (%s) — mock.", symbol, exc)
        return mock.mock_option_flow(symbol, period)
