"""Moonshot Kimi client (OpenAI-compatible chat completions).

POST {KIMI_BASE_URL}/chat/completions with Bearer auth. kimi-k2.5 ONLY accepts
temperature=1, so we always send temperature=1. Returns the assistant message
content string. Raises on any failure so callers can fall back to the backup
research provider.
"""
from __future__ import annotations

import httpx

from config import logger, settings

# k2.6 is a heavier reasoning model; give the read a generous budget so the
# full research prompt has time to complete (connect stays short to fail fast).
_KIMI_TIMEOUT = httpx.Timeout(connect=10.0, read=200.0, write=30.0, pool=200.0)


def configured() -> bool:
    return settings.kimi_configured


def chat(
    system: str,
    user: str,
    *,
    json_format: bool = True,
    max_tokens: int = 1500,
) -> str:
    """Single-shot chat completion against Kimi. Returns assistant content.

    kimi-k2.5 is a reasoning model: it spends tokens on ``reasoning_content``
    before emitting the final ``content``. We therefore request a generous
    ``max_tokens`` so the answer survives the reasoning budget. If the final
    ``content`` is empty but a full JSON object is present in the reasoning text,
    we recover it (robust JSON extraction lives in the research layer too).

    Raises RuntimeError if Kimi is not configured / returns no usable content.
    """
    if not settings.kimi_configured:
        raise RuntimeError("Kimi API key not configured")

    # Reasoning model: reserve plenty of headroom so content isn't truncated.
    effective_max = max(max_tokens, 4000)

    body: dict = {
        "model": settings.kimi_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        # kimi-k2.5 ONLY accepts temperature=1.
        "temperature": 1,
        "max_tokens": effective_max,
    }
    if json_format:
        body["response_format"] = {"type": "json_object"}

    headers = {
        "Authorization": f"Bearer {settings.kimi_api_key}",
        "Content-Type": "application/json",
    }
    url = f"{settings.kimi_base_url.rstrip('/')}/chat/completions"

    with httpx.Client(timeout=_KIMI_TIMEOUT) as client:
        r = client.post(url, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        logger.warning("Kimi response shape unexpected: %s", data)
        raise RuntimeError(f"Kimi returned no content: {exc}") from exc

    content = (msg.get("content") or "").strip()
    if content:
        return content
    # Fall back to reasoning_content (final answer may be embedded there).
    reasoning = (msg.get("reasoning_content") or "").strip()
    if reasoning:
        return reasoning
    finish = data["choices"][0].get("finish_reason")
    raise RuntimeError(f"Kimi returned empty content (finish_reason={finish})")
