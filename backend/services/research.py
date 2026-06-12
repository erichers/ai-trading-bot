"""AI research. Default provider = local Ollama (Gemma). Anthropic optional.

Calls POST {OLLAMA_BASE_URL}/api/chat with format:"json". Robustly parses the
returned JSON (strips code fences) and falls back to deterministic mock on any
failure so the UI never breaks.
"""
from __future__ import annotations

import json
import random
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from config import logger, settings
from services import alpaca_service, indicators

_OLLAMA_TIMEOUT = 120.0

# Anthropic is an optional alternate provider.
_anthropic_client = None
_anthropic_ok = False
try:
    import anthropic
    _anthropic_ok = True
except Exception:  # pragma: no cover
    _anthropic_ok = False

_ANTHROPIC_MODEL = "claude-sonnet-4-6"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ollama_connected() -> bool:
    try:
        r = httpx.get(f"{settings.ollama_base_url}/api/tags", timeout=3.0)
        return r.status_code == 200
    except Exception:
        return False


def _anthropic():
    global _anthropic_client
    if not (_anthropic_ok and settings.anthropic_configured):
        return None
    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    return _anthropic_client


_SYSTEM = (
    "You are a disciplined equity analyst. You always respond with a single STRICT "
    "JSON object and nothing else. Keys: thesis (string), sentiment_score (number in "
    "[-1,1]), conviction (number in [0,100]), key_risks (array of strings), "
    "suggested_action (one of buy/hold/reduce/sell), suggested_stop (number, a price), "
    "suggested_target (number, a price), regime (one of trend-up/trend-down/range/"
    "high-vol), bear_case (string articulating the strongest opposing case)."
)


def _build_prompt(symbol: str, snapshot: dict, ind: dict, bars: list[dict],
                  news: list[dict]) -> str:
    recent_bars = bars[-20:]
    bar_lines = "\n".join(
        f"{b.get('t', '')[:10]} O{b['o']} H{b['h']} L{b['l']} C{b['c']} V{b['v']}"
        for b in recent_bars
    )
    news_lines = "\n".join(f"- {n['headline']} ({n['source']})" for n in news)
    return (
        f"Analyze {symbol}.\n\n"
        f"Latest snapshot: {json.dumps(snapshot)}\n\n"
        f"Indicator snapshot: {json.dumps(ind)}\n\n"
        f"Recent daily bars (oldest->newest):\n{bar_lines}\n\n"
        f"Recent headlines:\n{news_lines or '(none)'}\n\n"
        "Produce a concise trading thesis, then reason through the strongest bear_case. "
        "Give a sentiment_score in [-1,1], a conviction in [0,100], concrete "
        "suggested_stop and suggested_target price levels near the current price, a "
        "suggested_action, and the current market regime. Return STRICT JSON only."
    )


def _parse_json_loose(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    # strip ```json ... ``` fences if present
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except Exception:
        # last-ditch: grab the first {...} block
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        raise


def _coerce(data: dict[str, Any], symbol: str, snapshot: dict, provider: str,
            model: str) -> dict[str, Any]:
    price = snapshot.get("price", 100.0) or 100.0

    def num(v, default):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    risks = data.get("key_risks") or []
    if isinstance(risks, str):
        risks = [risks]
    return {
        "symbol": symbol,
        "thesis": str(data.get("thesis", "")).strip(),
        "sentiment_score": max(-1.0, min(1.0, num(data.get("sentiment_score"), 0.0))),
        "conviction": max(0.0, min(100.0, num(data.get("conviction"), 50.0))),
        "key_risks": [str(r) for r in risks][:8],
        "suggested_action": str(data.get("suggested_action", "hold")).lower(),
        "suggested_stop": num(data.get("suggested_stop"), round(price * 0.95, 2)),
        "suggested_target": num(data.get("suggested_target"), round(price * 1.08, 2)),
        "regime": str(data.get("regime", "range")),
        "bear_case": str(data.get("bear_case", "")).strip(),
        "provider": provider,
        "model": model,
        "generated_at": _now(),
    }


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
        "provider": "mock",
        "model": "mock",
        "generated_at": _now(),
    }


def _ollama_chat(system: str, user: str, *, json_format: bool = True) -> str:
    payload = {
        "model": settings.research_model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if json_format:
        payload["format"] = "json"
    with httpx.Client(timeout=_OLLAMA_TIMEOUT) as client:
        r = client.post(f"{settings.ollama_base_url}/api/chat", json=payload)
        r.raise_for_status()
        return r.json()["message"]["content"]


def analyze(symbol: str) -> dict[str, Any]:
    symbol = symbol.upper()
    bars = alpaca_service.get_bars(symbol, "1Day", 120)
    ind = indicators.compute_all(bars)
    snapshot = alpaca_service.get_snapshot(symbol)
    news = alpaca_service.get_news([symbol], 5)
    prompt = _build_prompt(symbol, snapshot, ind, bars, news)

    provider = (settings.research_provider or "ollama").lower()

    if provider == "anthropic" and _anthropic() is not None:
        try:
            resp = _anthropic().messages.create(
                model=_ANTHROPIC_MODEL,
                max_tokens=1500,
                system=_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            )
            text = next((b.text for b in resp.content if b.type == "text"), "")
            data = _parse_json_loose(text)
            return _coerce(data, symbol, snapshot, "anthropic", _ANTHROPIC_MODEL)
        except Exception as exc:
            logger.warning("Anthropic analyze failed (%s) — falling back.", exc)

    # Default: Ollama / Gemma.
    try:
        content = _ollama_chat(_SYSTEM, prompt, json_format=True)
        data = _parse_json_loose(content)
        return _coerce(data, symbol, snapshot, "ollama", settings.research_model)
    except Exception as exc:
        logger.warning("Ollama analyze failed (%s) — returning mock.", exc)
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
    summary = (
        f"Watchlist breadth is {'positive' if avg > 0 else 'mixed'} this session. "
        f"Average sentiment {avg:+.2f}; regime reads {regime}."
    )

    provider = (settings.research_provider or "ollama").lower()
    user = (
        "Write a concise 2-sentence morning market briefing for this watchlist "
        f"snapshot: {json.dumps(items)}. Be concrete. Respond as JSON {{\"summary\": string}}."
    )
    try:
        if provider == "anthropic" and _anthropic() is not None:
            resp = _anthropic().messages.create(
                model=_ANTHROPIC_MODEL, max_tokens=400,
                messages=[{"role": "user", "content": user}],
            )
            txt = next((b.text for b in resp.content if b.type == "text"), "")
            summary = _parse_json_loose(txt).get("summary", summary)
        else:
            content = _ollama_chat(
                "You are a market strategist. Respond with STRICT JSON only.",
                user, json_format=True,
            )
            summary = _parse_json_loose(content).get("summary", summary)
    except Exception as exc:
        logger.warning("briefing LLM failed (%s) — using computed summary.", exc)

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
    vix_proxy = round((atr / price) * 100 * 16, 2)

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
