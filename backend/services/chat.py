"""Vanna-style market/app chat: Gemma classifies, optionally produces a single
read-only MySQL SELECT against a fixed schema, which the backend validates and
executes before Gemma (or a template) phrases a short natural-language answer.

Robust by design: any failure returns a helpful answer with an ``error`` field
rather than raising — the route never 500s.
"""
from __future__ import annotations

import json
import re
from typing import Any

import db
from config import logger
from services import alpaca_service, research as research_svc

# ---- Queryable schema (hardcoded; mirrors db.py ORM) ------------------------
SCHEMA: list[dict[str, Any]] = [
    {"table": "trades", "columns": [
        {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
        {"name": "asset_class", "type": "string"}, {"name": "side", "type": "string"},
        {"name": "qty", "type": "float"}, {"name": "order_type", "type": "string"},
        {"name": "status", "type": "string"}, {"name": "filled_qty", "type": "float"},
        {"name": "filled_avg_price", "type": "float"}, {"name": "source", "type": "string"},
        {"name": "strategy_id", "type": "string"}, {"name": "created_at", "type": "datetime"},
    ]},
    {"table": "research_analyses", "columns": [
        {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
        {"name": "thesis", "type": "text"}, {"name": "sentiment_score", "type": "float"},
        {"name": "conviction", "type": "float"}, {"name": "suggested_action", "type": "string"},
        {"name": "regime", "type": "string"}, {"name": "provider", "type": "string"},
        {"name": "model", "type": "string"}, {"name": "generated_at", "type": "datetime"},
    ]},
    {"table": "deep_research", "columns": [
        {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
        {"name": "kind", "type": "string"}, {"name": "title", "type": "string"},
        {"name": "provider", "type": "string"}, {"name": "model", "type": "string"},
        {"name": "created_at", "type": "datetime"},
    ]},
    {"table": "signals", "columns": [
        {"name": "id", "type": "int"}, {"name": "strategy_id", "type": "string"},
        {"name": "symbol", "type": "string"}, {"name": "timeframe", "type": "string"},
        {"name": "fired", "type": "bool"}, {"name": "created_at", "type": "datetime"},
    ]},
    {"table": "risk_events", "columns": [
        {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
        {"name": "side", "type": "string"}, {"name": "qty", "type": "float"},
        {"name": "order_type", "type": "string"}, {"name": "decision", "type": "string"},
        {"name": "source", "type": "string"}, {"name": "created_at", "type": "datetime"},
    ]},
    {"table": "bots", "columns": [
        {"name": "id", "type": "string"}, {"name": "name", "type": "string"},
        {"name": "enabled", "type": "bool"}, {"name": "kind", "type": "string"},
        {"name": "mode", "type": "string"}, {"name": "created_at", "type": "datetime"},
    ]},
    {"table": "strategies", "columns": [
        {"name": "id", "type": "string"}, {"name": "name", "type": "string"},
        {"name": "timeframe", "type": "string"}, {"name": "mode", "type": "string"},
        {"name": "enabled", "type": "bool"}, {"name": "created_at", "type": "datetime"},
    ]},
    {"table": "watchlist", "columns": [
        {"name": "symbol", "type": "string"}, {"name": "added_at", "type": "datetime"},
    ]},
    {"table": "app_knowledge", "columns": [
        {"name": "id", "type": "int"}, {"name": "topic", "type": "string"},
        {"name": "title", "type": "string"}, {"name": "body", "type": "text"},
        {"name": "tags", "type": "json"}, {"name": "updated_at", "type": "datetime"},
    ]},
]

_ALLOWED_TABLES = {t["table"] for t in SCHEMA}

_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|"
    r"merge|call|exec|execute|attach|pragma|into|set)\b",
    re.IGNORECASE,
)


def get_schema() -> list[dict[str, Any]]:
    return SCHEMA


def _schema_text() -> str:
    lines = []
    for t in SCHEMA:
        cols = ", ".join(f"{c['name']} {c['type']}" for c in t["columns"])
        lines.append(f"- {t['table']}({cols})")
    return "\n".join(lines)


# ---- SQL validation ---------------------------------------------------------
class SqlValidationError(Exception):
    pass


def validate_sql(sql: str) -> str:
    """Validate a single read-only SELECT; returns the (possibly LIMIT-augmented) SQL."""
    if not sql:
        raise SqlValidationError("empty SQL")
    cleaned = sql.strip().rstrip(";").strip()
    # Reject multiple statements (any internal semicolon).
    if ";" in cleaned:
        raise SqlValidationError("only a single statement is allowed")
    if not re.match(r"^\s*SELECT\b", cleaned, re.IGNORECASE):
        raise SqlValidationError("only SELECT statements are allowed")
    # Strip string literals before scanning for forbidden keywords so e.g.
    # a symbol literal can't trip the matcher.
    scan = re.sub(r"'(?:[^'\\]|\\.)*'", "''", cleaned)
    scan = re.sub(r'"(?:[^"\\]|\\.)*"', '""', scan)
    if _FORBIDDEN.search(scan):
        raise SqlValidationError("forbidden keyword detected — read-only SELECT only")
    # Enforce a LIMIT.
    if not re.search(r"\blimit\b", cleaned, re.IGNORECASE):
        cleaned = f"{cleaned} LIMIT 200"
    return cleaned


# ---- LLM helpers ------------------------------------------------------------
_CLASSIFY_SYSTEM = (
    "You are a careful data analyst for a trading-terminal app. You answer with a "
    "single STRICT JSON object only. Decide if the user's question can be answered "
    "by querying the app's database. If yes, set mode='sql' and write ONE read-only "
    "MySQL SELECT (no semicolons, no writes) using ONLY the given tables/columns. "
    "If it's a general question about markets or the app, set mode='chat' and leave "
    "sql empty. JSON keys: mode ('sql'|'chat'), sql (string), reason (string)."
)


def _app_context() -> str:
    try:
        acct = alpaca_service.get_account()
        pos = alpaca_service.get_positions()
    except Exception:
        acct, pos = {}, []
    pos_summary = ", ".join(
        f"{p.get('symbol')}({p.get('qty')})" for p in (pos or [])[:8]
    ) or "none"
    return (
        "App: an AI trading terminal (Alpaca paper trading + local Gemma research). "
        "It has a deterministic risk engine (vetoes orders that breach position/loss/"
        "concentration limits, kill switch), a background research worker, weekly-options "
        "bots, strategies, and a watchlist.\n"
        f"Account equity ${acct.get('equity', 'n/a')}, buying power "
        f"${acct.get('buying_power', 'n/a')}, day P/L {acct.get('day_pl_pct', 'n/a')}%. "
        f"Open positions: {pos_summary}."
    )


def _summarize_rows(message: str, sql: str, result: dict[str, Any]) -> str:
    rows = result.get("rows", [])
    cols = result.get("columns", [])
    preview = json.dumps(rows[:20], default=str)
    user = (
        f"User asked: {message}\n"
        f"Executed SQL: {sql}\n"
        f"Columns: {cols}\n"
        f"Rows (up to 20): {preview}\n"
        f"Total rows returned: {len(rows)}.\n"
        "Write a concise, friendly markdown answer (1-3 sentences) summarizing the "
        "result for the user. Reference concrete numbers from the rows."
    )
    try:
        return research_svc._ollama_chat(
            "You summarize SQL query results in plain English markdown. No JSON.",
            user, json_format=False, num_predict=300,
        ).strip()
    except Exception:
        if not rows:
            return "The query ran successfully but returned no rows."
        return f"The query returned {len(rows)} row(s). Columns: {', '.join(cols)}."


def _knowledge_context(message: str) -> str:
    """Top app_knowledge docs relevant to the question (keyword-matched)."""
    try:
        docs = db.search_app_knowledge(message, limit=4)
    except Exception as exc:
        logger.warning("chat: app_knowledge search failed (%s).", exc)
        return ""
    if not docs:
        return ""
    blocks = []
    for d in docs:
        body = (d.get("body") or "")[:1500]
        blocks.append(f"### {d.get('title', d.get('topic', ''))}\n{body}")
    return (
        "Authoritative app documentation (ground your answer in this; do not "
        "contradict it):\n\n" + "\n\n".join(blocks)
    )


def _chat_answer(message: str, history: list[dict[str, Any]] | None) -> str:
    hist = ""
    for h in (history or [])[-6:]:
        hist += f"{h.get('role', 'user')}: {h.get('content', '')}\n"
    knowledge = _knowledge_context(message)
    user = (
        f"{_app_context()}\n\n"
        f"{knowledge}\n\n"
        f"Conversation so far:\n{hist}\n"
        f"User question: {message}\n\n"
        "Answer helpfully in concise markdown, grounded in the app documentation above."
    )
    try:
        return research_svc._ollama_chat(
            "You are the assistant inside an AI trading terminal app. Be concise, "
            "concrete, and helpful. Ground answers about the app in the supplied "
            "documentation. Plain markdown, no JSON.",
            user, json_format=False, num_predict=500,
        ).strip()
    except Exception as exc:
        logger.warning("chat: _chat_answer LLM failed (%s).", exc)
        return (
            "I can answer questions about your trades, research, signals, risk events, "
            "bots, and the app itself. (The language model is currently unavailable, so "
            "this is a fallback response.)"
        )


def ask(message: str, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    message = (message or "").strip()
    if not message:
        return {"answer": "Ask me about your trades, research, or how the app works.",
                "mode": "chat"}

    # 1) classify + maybe produce SQL
    classify_user = (
        f"Database schema (MySQL):\n{_schema_text()}\n\n"
        f"User question: {message}\n\n"
        "Respond with STRICT JSON: {mode, sql, reason}."
    )
    plan: dict[str, Any] = {}
    try:
        raw = research_svc._ollama_chat(_CLASSIFY_SYSTEM, classify_user,
                                        json_format=True, num_predict=400)
        plan = research_svc._parse_json_loose(raw)
    except Exception as exc:
        logger.warning("chat: classify failed (%s) — defaulting to chat.", exc)
        plan = {"mode": "chat"}

    mode = (plan.get("mode") or "chat").lower()
    sql = (plan.get("sql") or "").strip()

    if mode == "sql" and sql:
        try:
            safe_sql = validate_sql(sql)
        except SqlValidationError as exc:
            return {
                "answer": (
                    f"I couldn't run that query safely: {exc}. "
                    "I only execute read-only SELECT statements."
                ),
                "sql": sql, "mode": "sql", "error": str(exc),
            }
        try:
            result = db.run_readonly_sql(safe_sql)
        except Exception as exc:
            logger.warning("chat: SQL execution failed (%s).", exc)
            return {
                "answer": f"The query failed to execute: {exc}",
                "sql": safe_sql, "mode": "sql", "error": str(exc),
            }
        answer = _summarize_rows(message, safe_sql, result)
        return {
            "answer": answer, "sql": safe_sql, "mode": "sql",
            "rows": result["rows"], "columns": result["columns"],
        }

    # 2) general chat
    return {"answer": _chat_answer(message, history), "mode": "chat"}
