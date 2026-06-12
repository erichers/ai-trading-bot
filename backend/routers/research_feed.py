"""Research feed: unified newest-first feed + deep research docs + worker control.

Mounted under the same /research prefix as routers/research.py.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

import db
from config import logger
from models import DeepResearchRequest, ResearchWorkerUpdate
from services import research as research_svc
from services import research_worker

router = APIRouter(prefix="/research", tags=["research"])


def _truncate(text: str | None, n: int = 280) -> str:
    text = text or ""
    return text[:n].rstrip() + ("…" if len(text) > n else "")


@router.get("/feed")
def feed(limit: int = Query(50, ge=1, le=200)):
    """Unified newest-first feed merging analyses + deep_research + briefings."""
    items: list[dict] = []

    for r in db.list_research(limit=limit):
        items.append({
            "id": f"analysis-{r['id']}",
            "source": "analysis",
            "symbol": r.get("symbol"),
            "title": f"{r.get('symbol')} analysis",
            "summary": _truncate(r.get("thesis")),
            "conviction": r.get("conviction"),
            "sentiment_score": r.get("sentiment_score"),
            "regime": r.get("regime"),
            "provider": r.get("provider"),
            "model": r.get("model"),
            "created_at": r.get("generated_at"),
        })

    for d in db.list_deep_research(limit=limit):
        # map deep_research.kind -> feed source
        kind = d.get("kind")
        source = {
            "analysis": "analysis", "deep": "deep", "earnings": "earnings",
            "market": "market", "briefing": "briefing",
        }.get(kind, "deep")
        if kind == "analysis":
            # analysis rows already covered by research_analyses above — skip dupes
            continue
        data = d.get("data") or {}
        items.append({
            "id": f"deep-{d['id']}",
            "source": source,
            "symbol": d.get("symbol"),
            "title": d.get("title"),
            "summary": d.get("summary"),
            "conviction": data.get("conviction"),
            "sentiment_score": data.get("sentiment_score"),
            "regime": data.get("regime"),
            "provider": d.get("provider"),
            "model": d.get("model"),
            "created_at": d.get("created_at"),
        })

    items.sort(key=lambda x: (x.get("created_at") or ""), reverse=True)
    return items[:limit]


@router.get("/deep")
def deep_list(
    symbol: str | None = None,
    kind: str | None = None,
    limit: int = Query(50, ge=1, le=200),
):
    return db.list_deep_research(symbol=symbol, kind=kind, limit=limit)


@router.get("/deep/{deep_id}")
def deep_get(deep_id: int):
    doc = db.get_deep_research(deep_id)
    if not doc:
        raise HTTPException(status_code=404, detail="deep_research not found")
    return doc


@router.post("/deep")
def deep_create(body: DeepResearchRequest):
    try:
        doc = research_svc.generate_deep(body.symbol, body.kind)
    except research_svc.ResearchUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Deep research unavailable: {exc}")
    try:
        saved = db.insert_deep_research(doc)
        return saved
    except Exception as exc:
        logger.warning("insert_deep_research failed (%s).", exc)
        return {**doc, "summary": doc.get("body", "")[:280]}


@router.get("/worker")
def worker_status():
    return research_worker.status()


@router.put("/worker")
async def worker_update(body: ResearchWorkerUpdate):
    # async so start()/stop() run on the event loop (asyncio.create_task needs a
    # running loop in the current thread; a sync endpoint runs in a threadpool).
    cfg = research_worker.set_config(body.model_dump(exclude_unset=True))
    # Start/stop the loop to match the new enabled flag.
    try:
        if cfg.get("enabled", True):
            research_worker.start()
        else:
            # Stop the loop so it actually halts and status().running -> false.
            research_worker.stop()
    except RuntimeError:
        # No running event loop (e.g. called outside async context) — ignore.
        pass
    return research_worker.status()


@router.post("/worker/run-once")
async def worker_run_once():
    """Run exactly ONE research cycle now with the configured provider/depth.

    For a manual refresh. Uses the worker's configured provider (default 'gemma')
    so it does not spend Kimi credits unless the worker is explicitly set to kimi.
    """
    return await research_worker.run_once()
