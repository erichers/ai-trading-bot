"""Application configuration loaded from the repo-root .env via pydantic-settings."""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# .env lives one level up from backend/
_REPO_ROOT = Path(__file__).resolve().parent.parent
_ENV_PATH = _REPO_ROOT / ".env"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("trading-backend")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    alpaca_api_key: str = ""
    alpaca_secret_key: str = ""
    alpaca_api_base_url: str = "https://paper-api.alpaca.markets/v2"
    alpaca_paper_trade: bool = True
    anthropic_api_key: str = ""

    # SQLite DB lives inside backend/
    db_path: str = str(Path(__file__).resolve().parent / "trading.db")

    @property
    def alpaca_configured(self) -> bool:
        return bool(self.alpaca_api_key and self.alpaca_secret_key)

    @property
    def anthropic_configured(self) -> bool:
        return bool(self.anthropic_api_key)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if not s.alpaca_configured:
        logger.warning("Alpaca credentials missing — Alpaca calls will return mock data.")
    if not s.anthropic_configured:
        logger.warning("Anthropic API key missing — AI research will return mock data.")
    return s


settings = get_settings()
