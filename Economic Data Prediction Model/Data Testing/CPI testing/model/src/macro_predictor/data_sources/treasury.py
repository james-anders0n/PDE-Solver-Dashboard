"""US Treasury Fiscal Data ingestion source."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import pandas as pd
import requests
from sqlalchemy.engine import Engine

from macro_predictor.config import Settings, TreasurySeriesConfig, get_settings
from macro_predictor.data_sources.database import (
    create_sqlite_engine,
    initialize_database,
    store_observations,
)
from macro_predictor.data_sources.http import get_json_with_retry
from macro_predictor.data_sources.quality import log_row_counts_and_gaps, validate_observations
from macro_predictor.data_sources.schema import empty_observations

LOGGER = logging.getLogger(__name__)
SOURCE = "treasury"
FIRST_PAGE = 1


def fetch(
    settings: Settings | None = None,
    session: requests.Session | None = None,
    fetched_at: datetime | None = None,
) -> pd.DataFrame:
    """Fetch configured Treasury Fiscal Data series into the shared observation schema."""
    resolved_settings = settings or get_settings()
    if not resolved_settings.treasury_series:
        msg = "TREASURY_SERIES_CONFIG_JSON must include at least one series."
        raise ValueError(msg)
    resolved_session = session or requests.Session()
    observed_at = fetched_at or datetime.now(UTC)
    frames = [
        _fetch_series(resolved_settings, resolved_session, series_config, observed_at)
        for series_config in resolved_settings.treasury_series
    ]
    if not frames:
        return empty_observations()
    return pd.concat(frames, ignore_index=True)


def validate(frame: pd.DataFrame) -> pd.DataFrame:
    """Validate Treasury observations and log row counts and gaps."""
    validated = validate_observations(frame, SOURCE)
    log_row_counts_and_gaps(validated, SOURCE, LOGGER)
    return validated


def store(
    frame: pd.DataFrame,
    settings: Settings | None = None,
    engine: Engine | None = None,
) -> int:
    """Store validated Treasury observations in SQLite."""
    resolved_settings = settings or get_settings()
    resolved_engine = engine or create_sqlite_engine(resolved_settings.database_url)
    initialize_database(resolved_engine)
    return store_observations(resolved_engine, validate(frame))


def _fetch_series(
    settings: Settings,
    session: requests.Session,
    series_config: TreasurySeriesConfig,
    fetched_at: datetime,
) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    page_number = FIRST_PAGE
    while True:
        payload = get_json_with_retry(
            session=session,
            url=f"{settings.treasury_base_url}/{series_config.endpoint.lstrip('/')}",
            params=_params(series_config, settings.treasury_page_size, page_number),
            timeout_seconds=settings.request_timeout_seconds,
            max_retries=settings.request_max_retries,
            backoff_seconds=settings.request_backoff_seconds,
        )
        data = payload.get("data")
        if not isinstance(data, list):
            msg = f"Treasury response for {series_config.series_id} missing data list."
            raise ValueError(msg)
        rows.extend(_treasury_row(series_config, item, fetched_at) for item in data)
        meta = payload.get("meta", {})
        total_pages = _total_pages(meta)
        if page_number >= total_pages:
            break
        page_number += 1
    if not rows:
        msg = f"Treasury response for {series_config.series_id} produced no observations."
        raise ValueError(msg)
    return pd.DataFrame(rows)


def _params(
    series_config: TreasurySeriesConfig,
    page_size: int,
    page_number: int,
) -> dict[str, object]:
    fields = ",".join(
        {
            series_config.date_field,
            series_config.value_field,
            series_config.release_date_field,
        }
    )
    params: dict[str, object] = {
        "format": "json",
        "fields": fields,
        "page[size]": page_size,
        "page[number]": page_number,
        "sort": series_config.date_field,
    }
    if series_config.filters:
        params["filter"] = series_config.filters
    return params


def _treasury_row(
    series_config: TreasurySeriesConfig,
    item: object,
    fetched_at: datetime,
) -> dict[str, object]:
    if not isinstance(item, dict):
        msg = f"Treasury observation for {series_config.series_id} must be an object."
        raise ValueError(msg)
    try:
        value = float(str(item[series_config.value_field]).replace(",", ""))
    except (KeyError, TypeError, ValueError) as exc:
        msg = f"Treasury observation for {series_config.series_id} has invalid value."
        raise ValueError(msg) from exc
    return {
        "series_id": series_config.series_id,
        "date": item[series_config.date_field],
        "value": value,
        "source": SOURCE,
        "release_date": item[series_config.release_date_field],
        "fetched_at": fetched_at,
    }


def _total_pages(meta: object) -> int:
    if not isinstance(meta, dict):
        return FIRST_PAGE
    total_pages = meta.get("total-pages") or meta.get("total_pages") or FIRST_PAGE
    return int(total_pages)
