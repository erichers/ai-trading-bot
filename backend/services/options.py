"""REAL options data via alpaca-py. NO MOCK FALLBACK.

- Expirations: TradingClient.get_option_contracts (paginated) -> distinct dates.
- Chain: OptionHistoricalDataClient.get_option_chain -> mapped contract list.
- Flow: aggregated from the real chain for the relevant expiration.

On any failure / empty result these raise fastapi.HTTPException: 424 when the
SDK/creds are missing, 503 when the upstream chain is unavailable or empty.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from config import logger, settings

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
    logger.warning("alpaca options SDK not importable (%s) — options will raise 424.", exc)
    _sdk_ok = False

_trading_client = None
_option_client = None

# OCC option symbol: ROOT(1-6) + YYMMDD(6) + C|P + strike*1000 padded to 8.
OCC_RE = re.compile(r"^([A-Z]{1,6})(\d{6})([CP])(\d{8})$")


def _no_client() -> HTTPException:
    if not _sdk_ok:
        return HTTPException(status_code=424, detail="Alpaca options SDK not importable.")
    return HTTPException(status_code=424, detail="Alpaca credentials not configured.")


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
        raise _no_client()
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
        if not out:
            raise HTTPException(status_code=503,
                                detail=f"No option expirations available for {symbol}.")
        return out
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("get_option_expirations failed for %s (%s).", symbol, exc)
        raise HTTPException(status_code=503,
                            detail=f"Option expirations unavailable for {symbol}: {exc}")


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
        raise _no_client()
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
            raise HTTPException(
                status_code=503,
                detail=f"Empty option chain for {symbol} {exp or '(nearest)'}.")
        return out
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("get_option_chain failed for %s (%s).", symbol, exc)
        raise HTTPException(status_code=503,
                            detail=f"Option chain unavailable for {symbol}: {exc}")


# ---- Underlying price -------------------------------------------------------
def underlying_price(symbol: str) -> float:
    """Real underlying price from the equity snapshot (raises 503 if unavailable)."""
    from services import alpaca_service  # local import avoids cycle
    snap = alpaca_service.get_snapshot(symbol)
    price = float(snap.get("price") or 0.0)
    if price <= 0:
        raise HTTPException(status_code=503,
                            detail=f"No underlying price for {symbol}.")
    return price


# ---- Nearest weekly ---------------------------------------------------------
def nearest_weekly(symbol: str) -> str | None:
    exps = expirations_with_type(symbol)
    weeklies = [e["date"] for e in exps if e.get("type") == "weekly"]
    if weeklies:
        return sorted(weeklies)[0]
    if exps:
        return sorted(e["date"] for e in exps)[0]
    return None


def _resolve_expiry(symbol: str, expiry: str | None) -> str:
    """Resolve an expiry spec ('nearest_weekly'|'YYYY-MM-DD'|None) to a date string."""
    spec = (expiry or "nearest_weekly").strip()
    if spec.lower() == "nearest_weekly" or not spec:
        exp = nearest_weekly(symbol)
        if not exp:
            raise HTTPException(status_code=503,
                                detail=f"No weekly expiration for {symbol}.")
        return exp
    # explicit date
    try:
        datetime.fromisoformat(spec)
        return spec
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Bad expiry '{spec}'.")


# ---- Moneyness helpers ------------------------------------------------------
def _moneyness(strike: float, under: float, right: str) -> str:
    """ATM/ITM/OTM relative to the underlying for a given option right."""
    if abs(strike - under) < 1e-9:
        return "ATM"
    if right == "call":
        return "ITM" if strike < under else "OTM"
    # put
    return "ITM" if strike > under else "OTM"


def _distance_pct(strike: float, under: float) -> float:
    return round((strike - under) / under * 100.0, 4) if under else 0.0


def select_contracts(symbol: str, right: str, expiry: str | None,
                     moneyness: str | None = None, count: int = 9) -> dict[str, Any]:
    """Return REAL contracts centered on ATM (or filtered by moneyness).

    Computes ATM = strike nearest the live underlying, and annotates each
    contract with moneyness + distance_pct. Returns `count` contracts centered
    on ATM so the UI can present ATM +/- a few strikes.
    """
    symbol = symbol.upper()
    right = (right or "call").lower()
    if right not in ("call", "put"):
        raise HTTPException(status_code=422, detail="right must be call or put")
    count = max(1, min(int(count or 9), 50))

    exp = _resolve_expiry(symbol, expiry)
    under = underlying_price(symbol)
    chain = get_option_chain(symbol, exp, right)  # already filtered to one right
    if not chain:
        raise HTTPException(status_code=503,
                            detail=f"No {right} contracts for {symbol} {exp}.")

    chain.sort(key=lambda c: c["strike"])
    strikes = [c["strike"] for c in chain]
    # ATM = strike nearest underlying.
    atm_idx = min(range(len(strikes)), key=lambda i: abs(strikes[i] - under))

    annotated: list[dict[str, Any]] = []
    for c in chain:
        strike = float(c["strike"])
        m = _moneyness(strike, under, right)
        bid = float(c.get("bid") or 0.0)
        ask = float(c.get("ask") or 0.0)
        mid = round((bid + ask) / 2, 4) if (bid or ask) else float(c.get("last") or 0.0)
        annotated.append({
            "occ_symbol": c["symbol"],
            "strike": strike,
            "right": right,
            "expiration": c["expiration"],
            "bid": bid,
            "ask": ask,
            "mid": mid,
            "last": float(c.get("last") or 0.0),
            "implied_volatility": float(c.get("implied_volatility") or 0.0),
            "delta": float(c.get("delta") or 0.0),
            "gamma": float(c.get("gamma") or 0.0),
            "theta": float(c.get("theta") or 0.0),
            "vega": float(c.get("vega") or 0.0),
            "open_interest": int(c.get("open_interest") or 0),
            "volume": int(c.get("volume") or 0),
            "moneyness": m,
            "distance_pct": _distance_pct(strike, under),
        })

    if moneyness:
        mny = moneyness.upper()
        if mny == "ATM":
            # ATM +/- a few strikes centered on the nearest-to-spot strike.
            lo = max(0, atm_idx - count // 2)
            hi = min(len(annotated), lo + count)
            lo = max(0, hi - count)
            selected = annotated[lo:hi]
        else:
            # The OTM/ITM contracts NEAREST to ATM (most relevant to pick).
            filtered = [c for c in annotated if c["moneyness"] == mny]
            filtered.sort(key=lambda c: abs(c["strike"] - under))
            selected = filtered[:count]
            selected.sort(key=lambda c: c["strike"])
    else:
        lo = max(0, atm_idx - count // 2)
        hi = lo + count
        if hi > len(annotated):
            hi = len(annotated)
            lo = max(0, hi - count)
        selected = annotated[lo:hi]

    return {
        "symbol": symbol,
        "underlying_price": round(under, 4),
        "expiration": exp,
        "right": right,
        "contracts": selected,
    }


def select_one(symbol: str, right: str, expiry: str | None,
               moneyness: str = "ATM", otm_strikes: int = 1) -> dict[str, Any]:
    """Pick a single real contract per moneyness/otm_strikes from the chain.

    Used by the bot/strategy engine. ATM = nearest strike; OTM/ITM step
    `otm_strikes` strikes away in the appropriate direction for the right.
    """
    symbol = symbol.upper()
    right = (right or "call").lower()
    exp = _resolve_expiry(symbol, expiry)
    under = underlying_price(symbol)
    chain = get_option_chain(symbol, exp, right)
    chain.sort(key=lambda c: c["strike"])
    strikes = [c["strike"] for c in chain]
    atm_idx = min(range(len(strikes)), key=lambda i: abs(strikes[i] - under))

    mny = (moneyness or "ATM").upper()
    steps = max(0, int(otm_strikes or 0))
    idx = atm_idx
    if mny == "OTM":
        # OTM call -> higher strike; OTM put -> lower strike.
        idx = atm_idx + steps if right == "call" else atm_idx - steps
    elif mny == "ITM":
        idx = atm_idx - steps if right == "call" else atm_idx + steps
    idx = max(0, min(idx, len(chain) - 1))

    c = chain[idx]
    strike = float(c["strike"])
    bid = float(c.get("bid") or 0.0)
    ask = float(c.get("ask") or 0.0)
    mid = round((bid + ask) / 2, 4) if (bid or ask) else float(c.get("last") or 0.0)
    return {
        "occ_symbol": c["symbol"],
        "symbol": c["symbol"],  # alias for downstream order builders
        "strike": strike,
        "right": right,
        "type": right,
        "expiration": c["expiration"],
        "bid": bid,
        "ask": ask,
        "mid": mid,
        "last": float(c.get("last") or 0.0),
        "implied_volatility": float(c.get("implied_volatility") or 0.0),
        "delta": float(c.get("delta") or 0.0),
        "gamma": float(c.get("gamma") or 0.0),
        "theta": float(c.get("theta") or 0.0),
        "vega": float(c.get("vega") or 0.0),
        "open_interest": int(c.get("open_interest") or 0),
        "volume": int(c.get("volume") or 0),
        "moneyness": _moneyness(strike, under, right),
        "distance_pct": _distance_pct(strike, under),
        "underlying_price": round(under, 4),
    }


def contract_by_symbol(occ_symbol: str) -> dict[str, Any]:
    """Fetch a single explicit OCC contract from the real chain (503 if missing)."""
    parsed = parse_occ(occ_symbol)
    if not parsed:
        raise HTTPException(status_code=422, detail=f"Bad OCC symbol '{occ_symbol}'.")
    chain = get_option_chain(parsed["root"], parsed["expiration"], parsed["type"])
    for c in chain:
        if c["symbol"].upper() == occ_symbol.strip().upper():
            bid = float(c.get("bid") or 0.0)
            ask = float(c.get("ask") or 0.0)
            mid = round((bid + ask) / 2, 4) if (bid or ask) else float(c.get("last") or 0.0)
            return {
                "occ_symbol": c["symbol"], "symbol": c["symbol"],
                "strike": float(c["strike"]), "right": c["type"], "type": c["type"],
                "expiration": c["expiration"], "bid": bid, "ask": ask, "mid": mid,
                "last": float(c.get("last") or 0.0),
                "implied_volatility": float(c.get("implied_volatility") or 0.0),
                "delta": float(c.get("delta") or 0.0),
                "gamma": float(c.get("gamma") or 0.0),
                "theta": float(c.get("theta") or 0.0),
                "vega": float(c.get("vega") or 0.0),
                "open_interest": int(c.get("open_interest") or 0),
                "volume": int(c.get("volume") or 0),
            }
    raise HTTPException(status_code=503, detail=f"Contract {occ_symbol} not found in live chain.")


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
        raise _no_client()
    try:
        exp = _nearest_expiration(symbol, period)
        chain = get_option_chain(symbol, exp, "all")

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
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("get_option_flow failed for %s (%s).", symbol, exc)
        raise HTTPException(status_code=503,
                            detail=f"Option flow unavailable for {symbol}: {exc}")
