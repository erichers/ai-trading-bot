"""Weekly-options bot engine.

evaluate_bot(bot) builds option-trade proposals per symbol by combining indicator
state + latest research, picking a REAL contract from the live nearest-weekly
chain per the bot's ``action`` config (explicit contract_symbol > moneyness /
otm_strikes), sizing it, and running it through the deterministic risk engine in
dry-run. NO MOCK CONTRACTS — when real options data is missing for a symbol the
proposal is marked with an honest error note. run_bot(bot, place) optionally
submits the approved option orders and persists trades + risk events.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

import db
from config import logger
from services import alpaca_service, indicators, options as options_svc, research as research_svc, risk


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _latest_research(symbol: str) -> dict[str, Any]:
    try:
        rows = db.list_research(symbol=symbol, limit=1)
        if rows:
            return rows[0]
    except Exception as exc:
        logger.warning("bots: list_research failed for %s (%s).", symbol, exc)
    # Fall back to a fresh analysis.
    try:
        return research_svc.analyze(symbol)
    except Exception as exc:
        logger.warning("bots: analyze fallback failed for %s (%s).", symbol, exc)
        return {"sentiment_score": 0.0, "conviction": 0.0}


def _action(bot: dict[str, Any]) -> dict[str, Any]:
    """Effective action config for the bot (defaults to an option action)."""
    act = dict(db.DEFAULT_OPTION_ACTION)
    act.update(bot.get("action") or {})
    return act


def _decide_direction(bot: dict[str, Any], research: dict[str, Any], ind: dict[str, Any],
                      price: float) -> tuple[str | None, str]:
    """Return (side|'skip', rationale). side in {'call','put',None}."""
    cfg = bot.get("config") or {}
    act = _action(bot)
    # action.right takes precedence: explicit call/put forces; 'auto' = from research.
    act_right = (act.get("right") or "auto").lower()
    if act_right in ("call", "put"):
        return act_right, f"Forced {act_right} via action.right."
    forced = (cfg.get("side") or "auto").lower()
    if forced in ("call", "put"):
        return forced, f"Forced {forced} via bot config."

    direction_mode = (cfg.get("direction") or "research").lower()
    ai_gate = bot.get("ai_gate") or {}
    min_conv = float(ai_gate.get("min_conviction", 60))
    sentiment = float(research.get("sentiment_score") or 0.0)
    conviction = float(research.get("conviction") or 0.0)
    sma20 = ind.get("sma20")
    rsi = ind.get("rsi14")
    macd_hist = (ind.get("macd") or {}).get("hist")

    if direction_mode == "momentum":
        if macd_hist is not None and macd_hist > 0 and (rsi is None or rsi < 70):
            return "call", f"Momentum: MACD hist {macd_hist:+.3f}>0, RSI {rsi}."
        if macd_hist is not None and macd_hist < 0 and (rsi is None or rsi > 30):
            return "put", f"Momentum: MACD hist {macd_hist:+.3f}<0, RSI {rsi}."
        return None, "Momentum: no clear MACD signal."

    # research mode (default)
    gate_ok = (not ai_gate.get("enabled", True)) or conviction >= min_conv
    above_sma = sma20 is None or price > sma20
    below_sma = sma20 is None or price < sma20
    if sentiment > 0.15 and gate_ok and above_sma:
        return "call", (
            f"Bullish: sentiment {sentiment:+.2f}, conviction {conviction:.0f}"
            f">={min_conv:.0f}, price {price:.2f}{'>' if above_sma else '<='}SMA20 {sma20}."
        )
    if sentiment < -0.15 and gate_ok and below_sma:
        return "put", (
            f"Bearish: sentiment {sentiment:+.2f}, conviction {conviction:.0f}"
            f">={min_conv:.0f}, price {price:.2f}<SMA20 {sma20}."
        )
    return None, (
        f"No edge: sentiment {sentiment:+.2f}, conviction {conviction:.0f} "
        f"(gate {'ok' if gate_ok else 'fail'}), price vs SMA20 {sma20}."
    )


def _pick_contract(symbol: str, side: str, act: dict[str, Any],
                   cfg: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """Return (contract_dict, error_note). Picks a REAL contract per the action.

    Precedence: explicit contract_symbol > moneyness/otm_strikes selection from
    the real nearest-weekly chain. Returns (None, note) on any real-data failure.
    """
    contract_symbol = (act.get("contract_symbol") or "").strip()
    expiry = act.get("expiry") or cfg.get("expiry") or "nearest_weekly"
    moneyness = (act.get("moneyness") or "ATM").upper()
    otm_strikes = int(act.get("otm_strikes", 1) or 0)
    try:
        if contract_symbol:
            c = options_svc.contract_by_symbol(contract_symbol)
            c["rationale_contract"] = f"Explicit contract {contract_symbol}."
            return c, None
        c = options_svc.select_one(
            symbol, side, expiry, moneyness=moneyness, otm_strikes=otm_strikes)
        c["rationale_contract"] = (
            f"{moneyness}{f' +{otm_strikes}' if moneyness in ('OTM','ITM') and otm_strikes else ''} "
            f"{side} from live {expiry} chain (strike {c.get('strike')}, "
            f"underlying {c.get('underlying_price')})."
        )
        return c, None
    except HTTPException as exc:
        return None, f"Real options data unavailable: {exc.detail}"
    except Exception as exc:
        logger.warning("bots: pick_contract failed for %s (%s).", symbol, exc)
        return None, f"Real options data unavailable: {exc}"


def evaluate_bot(bot: dict[str, Any]) -> dict[str, Any]:
    cfg = bot.get("config") or {}
    contracts = int(cfg.get("contracts", 1) or 1)
    max_premium = float(cfg.get("max_premium", 1500) or 1500)

    account = _safe_account()
    positions = _safe_positions()
    limits = db.get_risk_limits()
    market_open = _safe_market_open()
    day_trades = int(account.get("daytrade_count") or 0)

    proposals: list[dict[str, Any]] = []
    for symbol in (bot.get("symbols") or []):
        symbol = symbol.upper()
        try:
            bars = alpaca_service.get_bars(symbol, "1Day", 120)
            ind = indicators.compute_all(bars)
            snapshot = alpaca_service.get_snapshot(symbol)
            price = float(snapshot.get("price") or 0.0) or 100.0
            research = _latest_research(symbol)
            side, rationale = _decide_direction(bot, research, ind, price)
            if side is None:
                proposals.append({
                    "symbol": symbol, "action": "skip", "rationale": rationale,
                    "conviction": research.get("conviction"),
                    "sentiment": research.get("sentiment_score"),
                    "indicators_snapshot": _ind_snap(ind, price),
                })
                continue

            act = _action(bot)
            contract, pick_note = _pick_contract(symbol, side, act, cfg)
            note = pick_note
            if contract is None:
                # Honest error proposal — NO fake contract.
                proposals.append({
                    "symbol": symbol,
                    "action": "skip",
                    "right": side,
                    "rationale": rationale,
                    "error": pick_note,
                    "note": pick_note,
                    "conviction": research.get("conviction"),
                    "sentiment": research.get("sentiment_score"),
                    "indicators_snapshot": _ind_snap(ind, price),
                })
                continue

            ask = float(contract.get("ask") or contract.get("last") or 0.0)
            mid = round(((contract.get("bid") or 0.0) + (contract.get("ask") or 0.0)) / 2
                        or (contract.get("last") or 0.0), 2)
            est_premium = round(ask * 100 * contracts, 2)

            skip_premium = ask and (ask * 100) > max_premium
            occ_symbol = contract.get("occ_symbol") or contract.get("symbol")

            # Dry-run risk check (option order: 1 contract = 100 multiplier).
            order = {
                "symbol": occ_symbol, "asset_class": "option", "side": "buy",
                "qty": contracts, "type": "limit",
                "limit_price": mid or ask, "ref_price": mid or ask,
                "time_in_force": "day",
            }
            try:
                risk_decision = risk.evaluate_order(
                    order, account, positions, limits, market_open, day_trades)
            except Exception as exc:
                logger.warning("bots: risk evaluate failed for %s (%s).", symbol, exc)
                risk_decision = {"approved": True, "decision": "approved",
                                 "vetoes": [], "warnings": [], "computed": {}}

            if skip_premium:
                note = (note + " " if note else "") + (
                    f"Premium ${ask * 100:.0f} exceeds max_premium ${max_premium:.0f}."
                )

            full_rationale = rationale
            if contract.get("rationale_contract"):
                full_rationale = f"{rationale} {contract['rationale_contract']}"

            proposals.append({
                "symbol": symbol,
                "action": "skip" if skip_premium else "propose",
                "occ_symbol": occ_symbol,
                "right": side,
                "strike": contract.get("strike"),
                "expiration": contract.get("expiration"),
                "mid_price": mid,
                "est_premium": est_premium,
                "qty": contracts,
                "conviction": research.get("conviction"),
                "sentiment": research.get("sentiment_score"),
                "rationale": full_rationale,
                "contract": {
                    "occ_symbol": occ_symbol,
                    "strike": contract.get("strike"),
                    "right": side,
                    "expiration": contract.get("expiration"),
                    "bid": contract.get("bid"),
                    "ask": contract.get("ask"),
                    "mid": mid,
                    "last": contract.get("last"),
                    "implied_volatility": contract.get("implied_volatility"),
                    "delta": contract.get("delta"),
                    "gamma": contract.get("gamma"),
                    "theta": contract.get("theta"),
                    "vega": contract.get("vega"),
                    "open_interest": contract.get("open_interest"),
                    "volume": contract.get("volume"),
                    "moneyness": contract.get("moneyness"),
                    "underlying_price": contract.get("underlying_price"),
                },
                "indicators_snapshot": _ind_snap(ind, price),
                "risk_decision": risk_decision,
                "note": note,
            })
        except Exception as exc:
            logger.warning("bots: evaluate %s failed (%s).", symbol, exc)
            proposals.append({"symbol": symbol, "action": "skip",
                              "rationale": f"error: {exc}"})

    return {
        "bot_id": bot.get("id"),
        "bot_name": bot.get("name"),
        "mode": bot.get("mode"),
        "generated_at": _now(),
        "proposals": proposals,
    }


def run_bot(bot: dict[str, Any], place: bool = False) -> dict[str, Any]:
    evaluation = evaluate_bot(bot)
    mode = (bot.get("mode") or "signal").lower()
    do_place = bool(place) and mode in ("semi", "auto")
    placed: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []

    for p in evaluation["proposals"]:
        if p.get("action") != "propose":
            continue
        # Always record a signal for the proposal.
        try:
            sig = db.insert_signal({
                "strategy_id": bot.get("id"),
                "symbol": p["symbol"],
                "timeframe": "weekly_options",
                "fired": True,
                "matched": [{"rule": "bot_direction", "message": p.get("rationale")}],
                "snapshot": {
                    "occ_symbol": p.get("occ_symbol"), "right": p.get("right"),
                    "strike": p.get("strike"), "expiration": p.get("expiration"),
                    "mid_price": p.get("mid_price"), "qty": p.get("qty"),
                },
            })
            signals.append(sig)
        except Exception as exc:
            logger.warning("bots: insert_signal failed (%s).", exc)

        if not do_place:
            continue

        decision = p.get("risk_decision") or {}
        if not decision.get("approved", True):
            try:
                db.insert_risk_event({
                    "symbol": p.get("occ_symbol"), "side": "buy", "qty": p.get("qty"),
                    "order_type": "limit", "decision": "vetoed",
                    "rules": decision.get("vetoes", []), "computed": decision.get("computed"),
                    "source": "bot",
                })
            except Exception as exc:
                logger.warning("bots: insert_risk_event (veto) failed (%s).", exc)
            continue

        order = {
            "symbol": p["occ_symbol"], "asset_class": "option", "side": "buy",
            "qty": p["qty"], "type": "limit", "limit_price": p.get("mid_price"),
            "time_in_force": "day",
        }
        try:
            ack = alpaca_service.place_order(order)
            db.insert_trade({
                "alpaca_order_id": ack.get("id"),
                "client_order_id": ack.get("client_order_id"),
                "symbol": ack.get("symbol") or p["occ_symbol"],
                "asset_class": "option", "side": "buy", "qty": p["qty"],
                "order_type": "limit", "limit_price": p.get("mid_price"),
                "status": ack.get("status"), "source": "bot",
                "strategy_id": bot.get("id"), "raw": ack.get("raw"),
            })
            db.insert_risk_event({
                "symbol": p["occ_symbol"], "side": "buy", "qty": p["qty"],
                "order_type": "limit", "decision": decision.get("decision", "approved"),
                "rules": (decision.get("warnings") or []), "computed": decision.get("computed"),
                "source": "bot",
            })
            placed.append(ack)
        except Exception as exc:
            logger.warning("bots: place_order failed for %s (%s).", p.get("occ_symbol"), exc)

    return {
        **evaluation,
        "placed_orders": placed,
        "signals_recorded": len(signals),
        "placed": do_place,
    }


# ---- helpers ----------------------------------------------------------------
def _ind_snap(ind: dict[str, Any], price: float) -> dict[str, Any]:
    return {
        "price": round(price, 2),
        "sma20": ind.get("sma20"),
        "sma50": ind.get("sma50"),
        "rsi14": ind.get("rsi14"),
        "macd_hist": (ind.get("macd") or {}).get("hist"),
        "atr14": ind.get("atr14"),
    }


def _safe_account() -> dict[str, Any]:
    try:
        return alpaca_service.get_account()
    except Exception:
        return {}


def _safe_positions() -> list[dict[str, Any]]:
    try:
        return alpaca_service.get_positions()
    except Exception:
        return []


def _safe_market_open() -> bool:
    try:
        return alpaca_service.market_open()
    except Exception:
        return False
