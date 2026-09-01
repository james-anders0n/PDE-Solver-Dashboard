"""FRED ingestion source."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import pandas as pd
import requests
from sqlalchemy.engine import Engine

from macro_predictor.config import Settings, get_settings
from macro_predictor.data_sources.database import (
    create_sqlite_engine,
    initialize_database,
    store_observations,
)
from macro_predictor.data_sources.http import get_json_with_retry
from macro_predictor.data_sources.quality import log_row_counts_and_gaps, validate_observations
from macro_predictor.data_sources.schema import empty_observations

LOGGER = logging.getLogger(__name__)
SOURCE = "fred"


def fetch(
    settings: Settings | None = None,
    session: requests.Session | None = None,
    fetched_at: datetime | None = None,
) -> pd.DataFrame:
    """Fetch configured FRED series into the shared observation schema."""
    resolved_settings = settings or get_settings()
    _require_config(resolved_settings)
    resolved_session = session or requests.Session()
    observed_at = fetched_at or datetime.now(UTC)
    frames = [
        _fetch_series(resolved_settings, resolved_session, series_id, observed_at)
        for series_id in resolved_settings.fred_series_ids
    ]
    if not frames:
        return empty_observations()
    return pd.concat(frames, ignore_index=True)


def validate(frame: pd.DataFrame) -> pd.DataFrame:
    """Validate FRED observations and log row counts and gaps."""
    validated = validate_observations(frame, SOURCE)
    log_row_counts_and_gaps(validated, SOURCE, LOGGER)
    return validated


def store(
    frame: pd.DataFrame,
    settings: Settings | None = None,
    engine: Engine | None = None,
) -> int:
    """Store validated FRED observations in SQLite."""
    resolved_settings = settings or get_settings()
    resolved_engine = engine or create_sqlite_engine(resolved_settings.database_url)
    initialize_database(resolved_engine)
    return store_observations(resolved_engine, validate(frame))


def _require_config(settings: Settings) -> None:
    if not settings.fred_api_key:
        msg = "FRED_API_KEY is required for FRED ingestion."
        raise ValueError(msg)
    if not settings.fred_series_ids:
        msg = "FRED_SERIES_IDS must include at least one series."
        raise ValueError(msg)


def _fetch_series(
    settings: Settings,
    session: requests.Session,
    series_id: str,
    fetched_at: datetime,
) -> pd.DataFrame:
    payload = get_json_with_retry(
        session=session,
        url=settings.fred_observations_url,
        params={
            "series_id": series_id,
            "api_key": settings.fred_api_key or "",
            "file_type": "json",
        },
        timeout_seconds=settings.request_timeout_seconds,
        max_retries=settings.request_max_retries,
        backoff_seconds=settings.request_backoff_seconds,
    )
    observations = payload.get("observations")
    if not isinstance(observations, list):
        msg = f"FRED response for {series_id} missing observations list."
        raise ValueError(msg)
    rows = [_fred_row(series_id, item, fetched_at) for item in observations]
    rows = [row for row in rows if row is not None]
    if not rows:
        msg = f"FRED response for {series_id} produced no usable observations."
        raise ValueError(msg)
    return pd.DataFrame(rows)


def _fred_row(series_id: str, item: object, fetched_at: datetime) -> dict[str, object] | None:
    if not isinstance(item, dict):
        msg = f"FRED observation for {series_id} must be an object."
        raise ValueError(msg)
    raw_value = item.get("value")
    if raw_value in (None, "."):
        return None
    release_date = item.get("realtime_start")
    if not release_date:
        msg = f"FRED observation for {series_id} missing realtime_start release date."
        raise ValueError(msg)
    return {
        "series_id": series_id,
        "date": item["date"],
        "value": float(raw_value),
        "source": SOURCE,
        "release_date": release_date,
        "fetched_at": fetched_at,
    }
