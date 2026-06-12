"""Earnings-call transcript provider — extension point ONLY.

This app has NO verified transcript feed wired. Alpaca does not provide earnings
transcripts, and no transcript API key is present in .env. Per the project's
NO-MOCK rule we therefore NEVER fabricate a transcript: this module returns
``None`` unless a real provider is configured via the ``TRANSCRIPT_API_KEY``
environment variable.

If/when a real transcript provider is wired, implement ``fetch_transcript`` to
return a dict ::

    {"symbol", "quarter", "date", "text", "source", "url"}

and ``is_configured()`` will flip to True automatically. Until then callers must
treat the absence of a transcript as "skip gracefully" — see
``services.research.generate_earnings``.
"""
from __future__ import annotations

import os
from typing import Any, Optional

from config import logger

# Env var name for a (future) real transcript provider API key. Intentionally
# read from os.environ (not pydantic settings) so it is a pure optional add-on.
_ENV_KEY = "TRANSCRIPT_API_KEY"


def is_configured() -> bool:
    """True only if a real transcript provider key is present in the environment."""
    return bool(os.environ.get(_ENV_KEY, "").strip())


def fetch_transcript(symbol: str) -> Optional[dict[str, Any]]:
    """Return a REAL earnings-call transcript dict, or None when unconfigured.

    Returns None (skip) when ``TRANSCRIPT_API_KEY`` is not set. We never invent a
    transcript. When a key IS present this is the single place to call the real
    provider; the stub below intentionally returns None so that no fabricated
    transcript can ever leak into the database.
    """
    if not is_configured():
        return None
    # A real provider would be called here. We deliberately do NOT ship a
    # fabricated transcript: returning None keeps the NO-MOCK guarantee intact
    # until a verified integration is implemented.
    logger.warning(
        "transcripts: %s is set but no real transcript provider is implemented "
        "yet — returning None (no fabricated transcript).", _ENV_KEY)
    return None
