"""yfinance market data ingestion source."""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime

import pandas as pd
import yfinance as yf
from sqlalchemy.engine import Engine

from macro_predictor.config import Settings, get_settings
from macro_predictor.data_sources.database import (
    create_sqlite_engine,
    initialize_database,
    store_observations,
)
from macro_predictor.data_sources.quality import log_row_counts_and_gaps, validate_observations
from macro_predictor.data_sources.schema import empty_observations

LOGGER = logging.getLogger(__name__)
SOURCE = "yfinance"


def fetch(settings: Settings | None = None, fetched_at: datetime | None = None) -> pd.DataFrame:
    """Fetch configured yfinance tickers into the shared observation schema."""
    resolved_settings = settings or get_settings()
    if not resolved_settings.market_tickers:
        msg = "MARKET_TICKERS must include at least one ticker."
        raise ValueError(msg)
    observed_at = fetched_at or datetime.now(UTC)
    frames = [
        _fetch_ticker(resolved_settings, ticker, observed_at)
        for ticker in resolved_settings.market_tickers
    ]
    if not frames:
        return empty_observations()
    return pd.concat(frames, ignore_index=True)


def validate(frame: pd.DataFrame) -> pd.DataFrame:
    """Validate yfinance observations and log row counts and gaps."""
    validated = validate_observations(frame, SOURCE)
    log_row_counts_and_gaps(validated, SOURCE, LOGGER)
    return validated


def store(
    frame: pd.DataFrame,
    settings: Settings | None = None,
    engine: Engine | None = None,
) -> int:
    """Store validated yfinance observations in SQLite."""
    resolved_settings = settings or get_settings()
    resolved_engine = engine or create_sqlite_engine(resolved_settings.database_url)
    initialize_database(resolved_engine)
    return store_observations(resolved_engine, validate(frame))


def _fetch_ticker(settings: Settings, ticker: str, fetched_at: datetime) -> pd.DataFrame:
    history = _download_with_retry(settings, ticker)
    if history.empty:
        msg = f"yfinance response for {ticker} produced no rows."
        raise ValueError(msg)
    close = _close_series(history)
    if close.empty:
        msg = f"yfinance response for {ticker} produced no close prices."
        raise ValueError(msg)
    frame = close.rename("value").reset_index()
    date_column = frame.columns[0]
    frame = frame.rename(columns={date_column: "date"})
    frame["series_id"] = ticker
    frame["source"] = SOURCE
    frame["release_date"] = pd.to_datetime(frame["date"]) + pd.to_timedelta(
        settings.market_release_lag_days,
        unit="D",
    )
    frame["fetched_at"] = fetched_at
    return frame[["series_id", "date", "value", "source", "release_date", "fetched_at"]]


def _close_series(history: pd.DataFrame) -> pd.Series:
    if isinstance(history.columns, pd.MultiIndex):
        if "Adj Close" in history.columns.get_level_values(0):
            return history["Adj Close"].iloc[:, 0].dropna()
        if "Close" in history.columns.get_level_values(0):
            return history["Close"].iloc[:, 0].dropna()
    if "Adj Close" in history.columns:
        return history["Adj Close"].dropna()
    if "Close" in history.columns:
        return history["Close"].dropna()
    msg = "yfinance response must include Close or Adj Close."
    raise ValueError(msg)


def _download_with_retry(settings: Settings, ticker: str) -> pd.DataFrame:
    last_error: Exception | None = None
    attempts = settings.request_max_retries + 1
    for attempt in range(attempts):
        try:
            return yf.download(
                tickers=ticker,
                start=settings.market_start_date,
                end=settings.market_end_date,
                progress=False,
                auto_adjust=False,
                group_by="column",
                threads=False,
            )
        except Exception as exc:
            last_error = exc
            if attempt == settings.request_max_retries:
                break
            sleep_seconds = settings.request_backoff_seconds * (2**attempt)
            LOGGER.warning(
                "yfinance download failed; retrying",
                extra={"ticker": ticker, "attempt": attempt + 1, "sleep_seconds": sleep_seconds},
            )
            time.sleep(sleep_seconds)
    msg = f"yfinance download failed after {attempts} attempts: {ticker}"
    raise RuntimeError(msg) from last_error
