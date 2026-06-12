"""AI research. Primary provider = Moonshot Kimi (cloud); backup = local Gemma
via Ollama. NO MOCK FALLBACK — if every provider fails the caller raises a 503.

Calls go through providers in order (kimi -> ollama). Robustly parses the
returned JSON (strips code fences). The returned dict's ``provider``/``model``
reflect whoever actually answered.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from config import logger, settings
from services import alpaca_service, indicators, kimi

_OLLAMA_TIMEOUT = 120.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ollama_connected() -> bool:
    try:
        r = httpx.get(f"{settings.ollama_base_url}/api/tags", timeout=3.0)
        return r.status_code == 200
    except Exception:
        return False


def _provider_order() -> list[str]:
    """Ordered list of distinct providers to try: primary then backup."""
    out: list[str] = []
    for p in (settings.research_provider, settings.research_backup_provider):
        p = (p or "").lower().strip()
        if p and p not in out:
            out.append(p)
    return out or ["ollama"]


# 'gemma' is a user-facing alias for the local Ollama provider (free/local).
_PROVIDER_ALIASES = {"gemma": "ollama"}


def _normalize_provider(provider: str | None) -> str | None:
    """Map a user-supplied provider name to a canonical provider id.

    'gemma' -> 'ollama'. None passes through (means: use default fallback order).
    """
    if provider is None:
        return None
    p = provider.lower().strip()
    return _PROVIDER_ALIASES.get(p, p)


# Depth presets control cost/quality. 'quick' = cheap/fast, 'deep' = rich context.
_DEPTH_PRESETS: dict[str, dict[str, int]] = {
    "quick": {"bars": 40, "recent_bars": 10, "news": 0, "num_predict": 400},
    "standard": {"bars": 120, "recent_bars": 20, "news": 5, "num_predict": 900},
    "deep": {"bars": 120, "recent_bars": 40, "news": 8, "num_predict": 1200},
}


def _depth_preset(depth: str) -> dict[str, int]:
    return _DEPTH_PRESETS.get((depth or "standard").lower(), _DEPTH_PRESETS["standard"])


def _call_provider(provider: str, system: str, user: str, *,
                   json_format: bool, num_predict: int) -> tuple[str, str]:
    """Call one provider. Returns (content, model_id). Raises on failure."""
    if provider == "kimi":
        content = kimi.chat(system, user, json_format=json_format, max_tokens=max(num_predict, 1500))
        return content, settings.kimi_model
    if provider == "ollama":
        content = _ollama_chat(system, user, json_format=json_format, num_predict=num_predict)
        return content, settings.research_model
    raise RuntimeError(f"unknown research provider '{provider}'")


_SYSTEM = (
    "You are a disciplined equity analyst. You always respond with a single STRICT "
    "JSON object and nothing else. Keys: thesis (string), sentiment_score (number in "
    "[-1,1]), conviction (number in [0,100]), key_risks (array of strings), "
    "suggested_action (one of buy/hold/reduce/sell), suggested_stop (number, a price), "
    "suggested_target (number, a price), regime (one of trend-up/trend-down/range/"
    "high-vol), bear_case (string articulating the strongest opposing case)."
)


def _build_prompt(symbol: str, snapshot: dict, ind: dict, bars: list[dict],
                  news: list[dict], *, depth: str = "standard") -> str:
    preset = _depth_preset(depth)
    recent_bars = bars[-preset["recent_bars"]:]
    bar_lines = "\n".join(
        f"{b.get('t', '')[:10]} O{b['o']} H{b['h']} L{b['l']} C{b['c']} V{b['v']}"
        for b in recent_bars
    )
    if depth == "quick":
        # Leaner prompt to keep the token budget (and latency) down.
        return (
            f"Analyze {symbol} quickly.\n\n"
            f"Latest snapshot: {json.dumps(snapshot)}\n\n"
            f"Indicator snapshot: {json.dumps(ind)}\n\n"
            f"Recent daily bars (oldest->newest):\n{bar_lines}\n\n"
            "Give a brief trading thesis, a short bear_case, sentiment_score in "
            "[-1,1], conviction in [0,100], suggested_stop and suggested_target near "
            "the current price, a suggested_action, and the market regime. STRICT JSON only."
        )
    news_lines = "\n".join(f"- {n['headline']} ({n.get('source','')})" for n in news)
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


class ResearchUnavailable(Exception):
    """Raised when every research provider fails. Routers map this to a 503."""


def _ollama_chat(
    system: str,
    user: str,
    *,
    json_format: bool = True,
    num_predict: int = 700,
) -> str:
    payload = {
        "model": settings.research_model,
        "stream": False,
        # gemma4 is a reasoning model; thinking tokens otherwise starve the
        # actual output and we get empty content. Disable it.
        "think": False,
        # Keep the model resident so subsequent calls don't pay reload latency.
        "keep_alive": "30m",
        "options": {"num_predict": num_predict, "temperature": 0.4},
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


def _safe_news(symbols: list[str], limit: int) -> list[dict[str, Any]]:
    """News is supplementary context — never let its absence block research."""
    try:
        return alpaca_service.get_news(symbols, limit)
    except Exception as exc:
        logger.info("research: news unavailable for %s (%s) — proceeding without.",
                    symbols, exc)
        return []


def analyze(symbol: str, *, provider: str | None = None,
            depth: str = "standard") -> dict[str, Any]:
    """Analyze a symbol and return a structured research dict.

    provider:
        When given, ONLY that provider is used (no cross-fallback). This is the
        cost guard: passing 'gemma'/'ollama' guarantees the local free model is
        used and Kimi credits are never spent. 'gemma' aliases to 'ollama'.
        When None, the configured fallback order is used (kimi primary ->
        gemma backup) — intended for explicit, user-initiated calls.
    depth:
        'quick'    — ~40 bars, ~400 num_predict, leaner prompt.
        'standard' — current behavior (~120 bars, ~900 num_predict).
        'deep'     — ~120 bars + more news, ~1200 num_predict; the caller may
                     additionally persist a deep_research 'deep' doc.
    """
    symbol = symbol.upper()
    depth = (depth or "standard").lower()
    preset = _depth_preset(depth)

    forced = _normalize_provider(provider)
    providers = [forced] if forced else _provider_order()

    bars = alpaca_service.get_bars(symbol, "1Day", preset["bars"])
    ind = indicators.compute_all(bars)
    snapshot = alpaca_service.get_snapshot(symbol)
    news = _safe_news([symbol], preset["news"]) if preset["news"] else []
    prompt = _build_prompt(symbol, snapshot, ind, bars, news, depth=depth)

    last_err: Exception | None = None
    for prov in providers:
        try:
            content, model = _call_provider(
                prov, _SYSTEM, prompt, json_format=True,
                num_predict=preset["num_predict"])
            data = _parse_json_loose(content)
            result = _coerce(data, symbol, snapshot, prov, model)
            result["depth"] = depth
            return result
        except Exception as exc:
            last_err = exc
            logger.warning("research analyze(%s, depth=%s) via %s failed (%s)%s.",
                           symbol, depth, prov, exc,
                           " — no fallback (provider forced)" if forced
                           else " — trying next provider")
    raise ResearchUnavailable(
        f"research analyze failed for {symbol} (provider={provider}): {last_err}")


def briefing(watchlist: list[str], *, provider: str | None = None) -> dict[str, Any]:
    forced = _normalize_provider(provider)
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

    user = (
        "Write a concise 2-sentence morning market briefing for this watchlist "
        f"snapshot: {json.dumps(items)}. Be concrete. Respond as JSON {{\"summary\": string}}."
    )
    for prov in ([forced] if forced else _provider_order()):
        try:
            content, _ = _call_provider(
                prov, "You are a market strategist. Respond with STRICT JSON only.",
                user, json_format=True, num_predict=400)
            summary = _parse_json_loose(content).get("summary", summary)
            break
        except Exception as exc:
            logger.warning("briefing via %s failed (%s).", prov, exc)

    return {
        "generated_at": _now(),
        "summary": summary,
        "items": items,
        "regime": regime,
    }


_DEEP_SYSTEM = (
    "You are a senior equity research analyst writing an internal markdown report. "
    "Write clear, well-structured GitHub-flavored markdown with section headers (##), "
    "bullet points, and concrete numbers drawn from the supplied data. Do NOT invent "
    "specific figures you were not given. Be decisive but balanced."
)


def _deep_disclaimer(kind: str) -> str:
    if kind == "earnings":
        return (
            "> _Note: earnings detail below is LLM-synthesized from recent price action "
            "and available news headlines — it is NOT a verified earnings transcript or "
            "fundamentals feed. Treat dates/figures as indicative only._\n\n"
        )
    return (
        "> _Note: this report is LLM-synthesized from market data and news headlines "
        "available to the app. Verify any specific claims independently._\n\n"
    )


def generate_deep(symbol: str, kind: str = "deep", *,
                  provider: str | None = None) -> dict[str, Any]:
    """Build a longer markdown research report (deep dive or earnings synthesis).

    provider: when given, ONLY that provider is used (no fallback). 'gemma'
    aliases to 'ollama'. When None, the configured fallback order is used. The
    background worker passes provider explicitly so it never spends Kimi credits.
    """
    symbol = symbol.upper()
    kind = kind if kind in ("deep", "earnings") else "deep"
    forced = _normalize_provider(provider)
    bars = alpaca_service.get_bars(symbol, "1Day", 120)
    ind = indicators.compute_all(bars)
    snapshot = alpaca_service.get_snapshot(symbol)
    news = _safe_news([symbol], 8)

    recent_bars = bars[-30:]
    bar_lines = "\n".join(
        f"{b.get('t', '')[:10]} O{b['o']} H{b['h']} L{b['l']} C{b['c']} V{b['v']}"
        for b in recent_bars
    )
    news_lines = "\n".join(f"- {n['headline']} ({n.get('source','')})" for n in news)

    if kind == "earnings":
        ask = (
            f"Write an EARNINGS-FOCUSED markdown report for {symbol}. Sections: "
            "## Setup into earnings, ## What the market expects, ## Key items to watch, "
            "## Bull case, ## Bear case, ## Options-implied move (qualitative), "
            "## Trade plan. Be explicit that earnings specifics are synthesized from "
            "news, not a verified transcript."
        )
    else:
        ask = (
            f"Write a DEEP-DIVE markdown research report for {symbol}. Sections: "
            "## Overview, ## Technical picture, ## Momentum & trend, ## Catalysts & news, "
            "## Bull case, ## Bear case, ## Risks, ## Trade plan (entries, stops, targets)."
        )

    user = (
        f"{ask}\n\n"
        f"Latest snapshot: {json.dumps(snapshot)}\n\n"
        f"Indicator snapshot: {json.dumps(ind)}\n\n"
        f"Recent daily bars (oldest->newest):\n{bar_lines}\n\n"
        f"Recent headlines:\n{news_lines or '(none)'}\n\n"
        "Return ONLY markdown (no JSON, no preamble)."
    )

    provider_used = None
    model = None
    body = ""
    last_err: Exception | None = None
    for prov in ([forced] if forced else _provider_order()):
        try:
            content, mdl = _call_provider(
                prov, _DEEP_SYSTEM, user, json_format=False, num_predict=1400)
            content = (content or "").strip()
            if content:
                provider_used, model, body = prov, mdl, content
                break
        except Exception as exc:
            last_err = exc
            logger.warning("generate_deep via %s failed for %s (%s) — trying next.",
                           prov, symbol, exc)

    if not body:
        raise ResearchUnavailable(
            f"deep research unavailable for {symbol}: {last_err or 'empty response'}")

    title = f"{symbol} {'earnings preview' if kind == 'earnings' else 'deep dive'}"
    full_body = _deep_disclaimer(kind) + body
    return {
        "symbol": symbol,
        "kind": kind,
        "title": title,
        "body": full_body,
        "data": {
            "snapshot": snapshot,
            "indicators": ind,
            "news": news[:8],
        },
        "provider": provider_used,
        "model": model,
        "generated_at": _now(),
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
