"""AI research via the Anthropic SDK (claude-sonnet-4-6). Falls back to mock JSON."""
from __future__ import annotations

import json
import random
from datetime import datetime, timezone
from typing import Any

from config import logger, settings
from services import alpaca_service, indicators

MODEL = "claude-sonnet-4-6"

_anthropic_client = None
_sdk_ok = False
try:
    import anthropic
    _sdk_ok = True
except Exception as exc:  # pragma: no cover
    logger.warning("anthropic SDK not importable (%s) — AI research mock-only.", exc)
    _sdk_ok = False


def _client():
    global _anthropic_client
    if not (_sdk_ok and settings.anthropic_configured):
        return None
    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    return _anthropic_client


# JSON schema the model is constrained to (structured outputs).
_ANALYZE_SCHEMA = {
    "type": "object",
    "properties": {
        "thesis": {"type": "string"},
        "sentiment_score": {"type": "number"},
        "conviction": {"type": "number"},
        "key_risks": {"type": "array", "items": {"type": "string"}},
        "suggested_action": {"type": "string"},
        "suggested_stop": {"type": "number"},
        "suggested_target": {"type": "number"},
        "regime": {"type": "string"},
        "bear_case": {"type": "string"},
    },
    "required": [
        "thesis", "sentiment_score", "conviction", "key_risks",
        "suggested_action", "suggested_stop", "suggested_target",
        "regime", "bear_case",
    ],
    "additionalProperties": False,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mock_analyze(symbol: str, snapshot: dict, ind: dict) -> dict[str, Any]:
    price = snapshot.get("price", 100.0)
    rsi = ind.get("rsi14") or 50.0
    bullish = rsi < 45
    sentiment = round(random.uniform(0.1, 0.6) * (1 if bullish else -1), 3)
    conviction = random.randint(45, 80)
    action = "buy" if bullish else ("hold" if 45 <= rsi <= 60 else "reduce")
    return {
        "symbol": symbol,
        "thesis": (
            f"{symbol} is trading near ${price:.2f}. RSI(14) at {rsi:.1f} suggests "
            f"{'oversold conditions favoring a bounce' if bullish else 'neutral-to-extended momentum'}. "
            "Trend and volume profile support a measured position."
        ),
        "sentiment_score": sentiment,
        "conviction": conviction,
        "key_risks": [
            "Broad market drawdown / risk-off rotation",
            "Earnings or guidance surprise",
            "Macro rate shocks compressing multiples",
        ],
        "suggested_action": action,
        "suggested_stop": round(price * 0.95, 2),
        "suggested_target": round(price * 1.08, 2),
        "regime": random.choice(["trend-up", "range", "high-vol"]),
        "bear_case": (
            f"If {symbol} loses near-term support, momentum could flip; elevated valuations "
            "leave little cushion and a sector de-rating would pressure the name further."
        ),
        "generated_at": _now(),
        "model": "mock",
    }


def analyze(symbol: str) -> dict[str, Any]:
    symbol = symbol.upper()
    bars = alpaca_service.get_bars(symbol, "1Day", 120)
    ind = indicators.compute_all(bars)
    snapshot = alpaca_service.get_snapshot(symbol)
    news = alpaca_service.get_news([symbol], 5)

    client = _client()
    if client is None:
        return _mock_analyze(symbol, snapshot, ind)

    news_lines = "\n".join(f"- {n['headline']} ({n['source']})" for n in news)
    prompt = (
        f"You are an equity analyst. Analyze {symbol}.\n\n"
        f"Latest snapshot: {json.dumps(snapshot)}\n\n"
        f"Indicator snapshot: {json.dumps(ind)}\n\n"
        f"Recent headlines:\n{news_lines}\n\n"
        "Produce a concise trading thesis. Separately reason through the strongest "
        "bear case as a second consideration. Provide a sentiment_score in [-1, 1], "
        "a conviction in [0, 100], concrete suggested_stop and suggested_target price "
        "levels, a suggested_action (buy/hold/reduce/sell), and the current market "
        "regime (trend-up/trend-down/range/high-vol). Return STRICT JSON only."
    )

    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=1500,
            output_config={"format": {"type": "json_schema", "schema": _ANALYZE_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        )
        text = next((b.text for b in resp.content if b.type == "text"), "")
        data = json.loads(text)
        data["symbol"] = symbol
        data["generated_at"] = _now()
        data["model"] = MODEL
        return data
    except Exception as exc:
        logger.warning("Anthropic analyze failed (%s) — returning mock.", exc)
        return _mock_analyze(symbol, snapshot, ind)


def briefing(watchlist: list[str]) -> dict[str, Any]:
    snapshots = alpaca_service.get_snapshots(watchlist)
    items = []
    for sym in watchlist:
        snap = snapshots.get(sym, {})
        chg = snap.get("change_pct", 0.0)
        sentiment = max(-1.0, min(1.0, chg / 5.0))
        note = (
            f"{sym} {'up' if chg >= 0 else 'down'} {abs(chg):.2f}% "
            f"at ${snap.get('price', 0):.2f}."
        )
        items.append({"symbol": sym, "note": note, "sentiment": round(sentiment, 3)})

    avg = sum(i["sentiment"] for i in items) / max(1, len(items))
    regime = "trend-up" if avg > 0.15 else ("trend-down" if avg < -0.15 else "range")

    client = _client()
    summary = (
        f"Watchlist breadth is {'positive' if avg > 0 else 'mixed'} this session. "
        f"Average sentiment {avg:+.2f}; regime reads {regime}."
    )
    if client is not None:
        try:
            resp = client.messages.create(
                model=MODEL,
                max_tokens=400,
                messages=[{
                    "role": "user",
                    "content": (
                        "Write a 2-sentence morning market briefing for this watchlist "
                        f"snapshot: {json.dumps(items)}. Be concrete and concise."
                    ),
                }],
            )
            summary = next((b.text for b in resp.content if b.type == "text"), summary)
        except Exception as exc:
            logger.warning("Anthropic briefing failed (%s) — using mock summary.", exc)

    return {
        "generated_at": _now(),
        "summary": summary,
        "items": items,
        "regime": regime,
    }


def regime() -> dict[str, Any]:
    spy = alpaca_service.get_snapshot("SPY")
    qqq = alpaca_service.get_snapshot("QQQ")
    spy_chg = spy.get("change_pct", 0.0)
    qqq_chg = qqq.get("change_pct", 0.0)
    avg = (spy_chg + qqq_chg) / 2

    bars = alpaca_service.get_bars("SPY", "1Day", 60)
    ind = indicators.compute_all(bars)
    atr = ind.get("atr14") or 0.0
    price = spy.get("price", 1.0) or 1.0
    vix_proxy = round((atr / price) * 100 * 16, 2)  # crude annualized-vol proxy

    if vix_proxy > 25:
        reg = "high-vol"
    elif avg > 0.3:
        reg = "trend-up"
    elif avg < -0.3:
        reg = "trend-down"
    else:
        reg = "range"

    breadth = round(max(0.0, min(1.0, 0.5 + avg / 4)), 3)
    return {
        "regime": reg,
        "vix_proxy": vix_proxy,
        "breadth": breadth,
        "note": (
            f"SPY {spy_chg:+.2f}% / QQQ {qqq_chg:+.2f}%. Volatility proxy {vix_proxy}. "
            f"Regime: {reg}."
        ),
    }
