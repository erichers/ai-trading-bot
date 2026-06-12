"""AI research routes (Kimi primary -> Gemma backup, NO MOCK); persisted to MySQL."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

import db
from config import logger
from models import AnalyzeRequest
from services import research as research_svc

router = APIRouter(prefix="/research", tags=["research"])


@router.post("/analyze")
def analyze(body: AnalyzeRequest):
    # On-demand (user-initiated): provider None => kimi-primary for quality.
    # Pass provider='gemma' to force the free local model instead.
    try:
        result = research_svc.analyze(
            body.symbol, provider=body.provider, depth=body.depth)
    except research_svc.ResearchUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Research unavailable: {exc}")
    try:
        db.insert_research(result)
    except Exception as exc:
        logger.warning("insert_research failed (%s).", exc)
    return result


@router.get("/history")
def history(symbol: str | None = None, limit: int = Query(50, ge=1, le=200)):
    return db.list_research(symbol=symbol, limit=limit)


@router.get("/briefing")
def briefing():
    result = research_svc.briefing(db.get_watchlist())
    try:
        db.insert_briefing(result)
    except Exception as exc:
        logger.warning("insert_briefing failed (%s).", exc)
    return result


@router.get("/regime")
def regime():
    return research_svc.regime()
