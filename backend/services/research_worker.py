"""Background research worker.

Runs an asyncio loop (started from main.py's lifespan) that periodically calls
research.analyze() for a universe of symbols, persisting each result to both the
research_analyses and deep_research tables, and occasionally generating a market
briefing. Config is persisted in the ``settings`` table under ``research_worker``.

All blocking work (Ollama calls, Alpaca calls, DB writes) runs in a thread via
asyncio.to_thread so the event loop — and the rest of the API — stays responsive.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Optional

import db
from config import logger
from services import research as research_svc

WORKER_KEY = "research_worker"

# MAG7 universe for earnings research. The three priority names get an 'earnings'
# deep_research doc EVERY cycle at depth='deep'; the rest rotate one-per-cycle at
# standard depth so the DB steadily accumulates earnings research for all seven.
MAG7 = ["TSLA", "META", "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN"]
MAG7_PRIORITY = ["TSLA", "META", "NVDA"]
MAG7_ROTATION = ["AAPL", "MSFT", "GOOGL", "AMZN"]

# Continuous worker defaults to provider='gemma' (free/local) so 24/7 runs never
# spend Kimi cloud credits. Kimi is reserved for on-demand, user-initiated calls.
DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
    "provider": "gemma",
    "depth": "standard",
    "interval_sec": 900,
    "universe": ["SPY", "QQQ", "TSLA", "META", "NVDA", "AAPL", "AMZN", "GOOGL", "MSFT", "AMD"],
}

# Per-symbol pause so we never hammer Ollama back-to-back.
_SYMBOL_SLEEP = 2.0

# Module-level runtime state (single worker per process).
_task: Optional[asyncio.Task] = None
_state: dict[str, Any] = {
    "running": False,
    "last_run": None,
    "last_symbol": None,
    "cycles": 0,
}


def get_config() -> dict[str, Any]:
    stored = db.get_setting(WORKER_KEY)
    if not isinstance(stored, dict):
        stored = {}
    return {**DEFAULT_CONFIG, **stored}


def set_config(partial: dict[str, Any]) -> dict[str, Any]:
    current = get_config()
    merged = {**current, **{k: v for k, v in (partial or {}).items() if v is not None}}
    db.set_setting(WORKER_KEY, merged)
    return merged


def status() -> dict[str, Any]:
    cfg = get_config()
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "provider": str(cfg.get("provider", "gemma")),
        "depth": str(cfg.get("depth", "standard")),
        "interval_sec": int(cfg.get("interval_sec", 900)),
        "universe": cfg.get("universe", []),
        "last_run": _state.get("last_run"),
        "running": bool(_state.get("running")) and _task is not None and not _task.done(),
        "count_today": _safe_count_today(),
        "cycles": _state.get("cycles", 0),
    }


def _safe_count_today() -> int:
    try:
        return db.count_deep_research_today()
    except Exception:
        return 0


def _analyze_one(symbol: str, *, provider: str, depth: str) -> None:
    """Blocking: analyze a symbol and persist to research_analyses + deep_research.

    The provider is passed explicitly so the continuous worker uses ONLY the
    configured provider (default 'gemma'/local). There is NO fallback to Kimi —
    if the forced provider fails, analyze() raises and the caller logs + skips.
    """
    result = research_svc.analyze(symbol, provider=provider, depth=depth)
    # 'deep' depth additionally produces a full markdown deep-research doc, using
    # the SAME provider (no surprise Kimi spend in the background worker).
    if depth == "deep":
        try:
            doc = research_svc.generate_deep(symbol, "deep", provider=provider)
            db.insert_deep_research(doc)
        except Exception as exc:
            logger.warning("worker: deep doc failed for %s (%s).", symbol, exc)
    try:
        db.insert_research(result)
    except Exception as exc:
        logger.warning("worker: insert_research failed for %s (%s).", symbol, exc)
    body = (
        f"## Thesis\n{result.get('thesis', '').strip()}\n\n"
        f"## Bear case\n{result.get('bear_case', '').strip()}\n\n"
        f"## Key risks\n"
        + "\n".join(f"- {r}" for r in (result.get("key_risks") or []))
    )
    try:
        db.insert_deep_research({
            "symbol": symbol,
            "kind": "analysis",
            "title": f"{symbol} analysis",
            "body": body,
            "data": result,
            "provider": result.get("provider"),
            "model": result.get("model"),
        })
    except Exception as exc:
        logger.warning("worker: insert_deep_research failed for %s (%s).", symbol, exc)


def _briefing_once(provider: str) -> None:
    """Blocking: generate a market briefing, persist to briefings + deep_research.

    provider is forced (default 'gemma') so the continuous worker never spends
    Kimi credits on the per-cycle briefing.
    """
    try:
        universe = get_config().get("universe") or db.get_watchlist()
        result = research_svc.briefing(universe, provider=provider)
        db.insert_briefing(result)
        items = result.get("items") or []
        body = (
            f"## Market briefing\n{result.get('summary', '').strip()}\n\n"
            f"Regime: **{result.get('regime', 'range')}**\n\n"
            "## Watchlist\n"
            + "\n".join(f"- {i.get('note', '')}" for i in items)
        )
        db.insert_deep_research({
            "symbol": "MARKET",
            "kind": "market",
            "title": "Market briefing",
            "body": body,
            "data": result,
            "provider": research_svc._normalize_provider(provider),
            "model": research_svc.settings.research_model,
        })
    except Exception as exc:
        logger.warning("worker: briefing cycle failed (%s).", exc)


def _deep_once(symbol: str, kind: str, provider: str) -> None:
    try:
        doc = research_svc.generate_deep(symbol, kind, provider=provider)
        db.insert_deep_research(doc)
    except Exception as exc:
        logger.warning("worker: deep generation failed for %s (%s).", symbol, exc)


def _earnings_once(symbol: str, provider: str) -> None:
    """Blocking: generate an honest, news-based earnings deep_research doc.

    Uses the forced provider (default 'gemma'/local) — NO Kimi spend in the
    background worker. On failure: log + skip (never fabricate)."""
    try:
        doc = research_svc.generate_earnings(symbol, provider=provider)
        db.insert_deep_research(doc)
        logger.info("research worker: earnings doc for %s via %s.", symbol, provider)
    except Exception as exc:
        logger.warning("worker: earnings generation failed for %s (%s).", symbol, exc)


def _earnings_targets() -> list[tuple[str, str]]:
    """Return [(symbol, depth)] for this cycle's earnings research.

    TSLA/META/NVDA every cycle at depth='deep'. The remaining MAG7 names
    (AAPL/MSFT/GOOGL/AMZN) rotate one per cycle at standard depth.
    """
    targets: list[tuple[str, str]] = [(s, "deep") for s in MAG7_PRIORITY]
    if MAG7_ROTATION:
        idx = _state.get("cycles", 0) % len(MAG7_ROTATION)
        targets.append((MAG7_ROTATION[idx], "standard"))
    return targets


async def _run_cycle() -> None:
    cfg = get_config()
    universe = list(cfg.get("universe") or [])
    provider = str(cfg.get("provider", "gemma"))
    depth = str(cfg.get("depth", "standard"))
    logger.info(
        "research worker: starting cycle over %d symbols (provider=%s, depth=%s).",
        len(universe), provider, depth)
    for sym in universe:
        if not get_config().get("enabled", True):
            logger.info("research worker: disabled mid-cycle — stopping.")
            return
        _state["last_symbol"] = sym
        try:
            # provider passed explicitly => Gemma-only, NO fallback to Kimi.
            await asyncio.to_thread(_analyze_one, sym, provider=provider, depth=depth)
            logger.info("research worker: analyzed %s via %s.", sym, provider)
        except Exception as exc:
            # On failure: log + skip. Never fall back to a credit-spending provider.
            logger.warning("research worker: analyze %s via %s failed (%s) — skipping.",
                           sym, provider, exc)
        await asyncio.sleep(_SYMBOL_SLEEP)

    # One market briefing per cycle (same forced provider).
    await asyncio.to_thread(_briefing_once, provider)

    # Earnings research for MAG7 so the DB accumulates earnings docs. TSLA/META/
    # NVDA every cycle (deep); the rest rotate. Sequential + small sleeps so we
    # never hammer Ollama. Same forced provider (Gemma) — no Kimi spend.
    for sym, _depth in _earnings_targets():
        if not get_config().get("enabled", True):
            logger.info("research worker: disabled mid-earnings — stopping.")
            return
        await asyncio.to_thread(_earnings_once, sym, provider)
        await asyncio.sleep(_SYMBOL_SLEEP)

    # Occasionally produce a deep dive on a rotating symbol (same forced provider).
    if universe:
        idx = _state.get("cycles", 0) % len(universe)
        await asyncio.to_thread(_deep_once, universe[idx], "deep", provider)

    _state["cycles"] = _state.get("cycles", 0) + 1
    _state["last_run"] = datetime.now(timezone.utc).isoformat()
    logger.info("research worker: cycle complete (#%d).", _state["cycles"])


async def run_once() -> dict[str, Any]:
    """Run exactly ONE research cycle now with the configured provider/depth.

    Used by the manual-refresh endpoint. Returns {ran, count}. Does not require
    the background loop to be enabled.
    """
    before = _state.get("cycles", 0)
    try:
        await _run_cycle()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("research worker: run_once cycle error (%s).", exc)
        return {"ran": False, "count": 0}
    return {"ran": True, "count": _state.get("cycles", 0) - before}


async def _loop() -> None:
    _state["running"] = True
    # Small initial delay so app startup completes instantly.
    await asyncio.sleep(3.0)
    try:
        while True:
            cfg = get_config()
            interval = max(30, int(cfg.get("interval_sec", 900)))
            if not cfg.get("enabled", True):
                # Disabled => the loop exits so status().running becomes false.
                # PUT {enabled:true} restarts it. This guarantees the worker
                # actually stops (no idle background task burning anything).
                logger.info("research worker: disabled — loop exiting.")
                return
            try:
                await _run_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("research worker: cycle error (%s).", exc)
            # Sleep the interval in small chunks so a config change (e.g. a
            # disable) takes effect within ~10s rather than a full interval.
            slept = 0
            while slept < interval:
                if not get_config().get("enabled", True):
                    logger.info("research worker: disabled during sleep — loop exiting.")
                    return
                await asyncio.sleep(min(10, interval - slept))
                slept += 10
    except asyncio.CancelledError:
        logger.info("research worker: cancelled.")
        raise
    finally:
        _state["running"] = False


def start() -> None:
    global _task
    if _task is not None and not _task.done():
        return
    _task = asyncio.create_task(_loop())
    logger.info("research worker: background task started.")


def stop() -> None:
    global _task
    if _task is not None and not _task.done():
        _task.cancel()
    _task = None
    _state["running"] = False


def is_running() -> bool:
    return _task is not None and not _task.done()


async def shutdown() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):
            pass
    _task = None
    _state["running"] = False
