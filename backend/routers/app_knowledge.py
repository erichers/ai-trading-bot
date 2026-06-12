"""App-knowledge routes (prefix /api/app-knowledge).

Lists or keyword-searches the seeded docs describing this app — used by the
frontend help/schema views and to verify the knowledge base is populated.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

import db
from config import logger

router = APIRouter(prefix="/app-knowledge", tags=["app-knowledge"])


@router.get("")
def list_knowledge(
    topic: str | None = Query(None),
    q: str | None = Query(None, description="keyword search over topic/title/tags/body"),
    limit: int = Query(50, ge=1, le=200),
):
    try:
        if q:
            return db.search_app_knowledge(q, limit=limit)
        return db.list_app_knowledge(topic=topic, limit=limit)
    except Exception as exc:
        logger.warning("app-knowledge list failed (%s).", exc)
        return []
