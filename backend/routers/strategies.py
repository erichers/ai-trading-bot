"""Strategy CRUD + signal evaluation routes (SQLite persisted)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

import db
from models import SignalEvaluateRequest, Strategy
from services import signals

router = APIRouter(tags=["strategies"])


@router.get("/strategies")
def list_strategies():
    return db.list_strategies()


@router.post("/strategies")
def create_strategy(strategy: Strategy):
    return db.create_strategy(strategy.model_dump())


@router.put("/strategies/{strategy_id}")
def update_strategy(strategy_id: str, strategy: Strategy):
    updated = db.update_strategy(strategy_id, strategy.model_dump(exclude_none=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="strategy not found")
    return updated


@router.delete("/strategies/{strategy_id}")
def delete_strategy(strategy_id: str):
    ok = db.delete_strategy(strategy_id)
    if not ok:
        raise HTTPException(status_code=404, detail="strategy not found")
    return {"deleted": strategy_id}


@router.post("/signals/evaluate")
def evaluate_signal(req: SignalEvaluateRequest):
    rules = [r.model_dump() for r in req.rules]
    return signals.evaluate(req.symbol, req.timeframe, rules)
