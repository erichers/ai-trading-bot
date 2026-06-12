"""AI research routes (Anthropic-backed with mock fallback)."""
from __future__ import annotations

from fastapi import APIRouter

import db
from models import AnalyzeRequest
from services import research as research_svc

router = APIRouter(prefix="/research", tags=["research"])


@router.post("/analyze")
def analyze(body: AnalyzeRequest):
    return research_svc.analyze(body.symbol)


@router.get("/briefing")
def briefing():
    return research_svc.briefing(db.get_watchlist())


@router.get("/regime")
def regime():
    return research_svc.regime()
