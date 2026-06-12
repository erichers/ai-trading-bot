"""Vanna-style market/app chat routes (prefix /api/chat)."""
from __future__ import annotations

from fastapi import APIRouter, Query

import db
from config import logger
from models import ChatRequest
from services import chat as chat_svc

router = APIRouter(prefix="/chat", tags=["chat"])


@router.get("/schema")
def schema():
    return chat_svc.get_schema()


@router.get("/history")
def history(limit: int = Query(50, ge=1, le=200)):
    try:
        return db.list_chat_messages(limit=limit)
    except Exception as exc:
        logger.warning("chat history failed (%s).", exc)
        return []


@router.post("")
def chat(body: ChatRequest):
    history = [t.model_dump() for t in (body.history or [])]
    try:
        result = chat_svc.ask(body.message, history)
    except Exception as exc:  # never 500
        logger.warning("chat ask failed (%s).", exc)
        result = {"answer": f"Something went wrong handling that: {exc}",
                  "mode": "chat", "error": str(exc)}
    # Persist turns (best-effort).
    try:
        db.insert_chat_message("user", body.message, {})
        db.insert_chat_message("assistant", result.get("answer", ""),
                               {"mode": result.get("mode"), "sql": result.get("sql")})
    except Exception as exc:
        logger.warning("chat persist failed (%s).", exc)
    return result
