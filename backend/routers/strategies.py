"""Strategy CRUD + signal evaluation routes (SQLite persisted)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

import db
from config import logger
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
    result = signals.evaluate(req.symbol, req.timeframe, rules)
    try:
        db.insert_signal({
            "strategy_id": getattr(req, "strategy_id", None),
            "symbol": req.symbol,
            "timeframe": req.timeframe,
            "fired": result.get("fired"),
            "matched": result.get("matched"),
            "snapshot": result.get("snapshot"),
        })
    except Exception as exc:
        logger.warning("insert_signal failed (%s).", exc)
    return result


@router.get("/signals/history")
def signals_history(symbol: str | None = None, limit: int = Query(50, ge=1, le=200)):
    return db.list_signals(symbol=symbol, limit=limit)
