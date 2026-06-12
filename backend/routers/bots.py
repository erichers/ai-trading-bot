"""Weekly-options bot routes (prefix /api/bots)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

import db
from models import BotCreate, BotRunRequest, BotUpdate
from services import bots as bots_svc

router = APIRouter(prefix="/bots", tags=["bots"])


@router.get("")
def list_bots():
    return db.list_bots()


@router.post("")
def create_bot(body: BotCreate):
    payload = body.model_dump()
    return db.create_bot(payload)


@router.put("/{bot_id}")
def update_bot(bot_id: str, body: BotUpdate):
    updated = db.update_bot(bot_id, body.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="bot not found")
    return updated


@router.delete("/{bot_id}")
def delete_bot(bot_id: str):
    if not db.delete_bot(bot_id):
        raise HTTPException(status_code=404, detail="bot not found")
    return {"deleted": True, "id": bot_id}


@router.post("/{bot_id}/evaluate")
def evaluate_bot(bot_id: str):
    bot = db.get_bot(bot_id)
    if bot is None:
        raise HTTPException(status_code=404, detail="bot not found")
    return bots_svc.evaluate_bot(bot)


@router.post("/{bot_id}/run")
def run_bot(bot_id: str, body: BotRunRequest):
    bot = db.get_bot(bot_id)
    if bot is None:
        raise HTTPException(status_code=404, detail="bot not found")
    return bots_svc.run_bot(bot, place=body.place)
