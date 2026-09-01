"""Tests for yfinance ingestion."""

from __future__ import annotations

from datetime import UTC, datetime

import pandas as pd
from pytest import MonkeyPatch

from macro_predictor.config import Settings
from macro_predictor.data_sources import market


def test_market_fetch_validate_and_store(monkeypatch: MonkeyPatch) -> None:
    """Fetch, validate, and store normalized yfinance observations."""
    settings = Settings(
        fred_api_key=None,
        fred_series_ids=(),
        fred_observations_url="https://example.test/fred",
        database_url="sqlite:///:memory:",
        log_level="INFO",
        request_timeout_seconds=10.0,
        request_max_retries=0,
        request_backoff_seconds=0.0,
        treasury_series=(),
        treasury_base_url="https://example.test/treasury",
        treasury_page_size=100,
        market_tickers=("SPY_TEST",),
        market_start_date="2024-01-01",
        market_end_date="2024-01-03",
        market_release_lag_days=1,
        target_series_id=None,
    )

    def fake_download(**_: object) -> pd.DataFrame:
        index = pd.to_datetime(["2024-01-01", "2024-01-02"])
        return pd.DataFrame({"Close": [100.0, 101.0]}, index=index)

    monkeypatch.setattr(market.yf, "download", fake_download)

    frame = market.fetch(settings=settings, fetched_at=datetime(2024, 3, 1, tzinfo=UTC))
    validated = market.validate(frame)
    stored = market.store(validated, settings=settings)

    assert len(validated) == 2
    assert validated.loc[0, "series_id"] == "SPY_TEST"
    assert validated.loc[0, "release_date"].date().isoformat() == "2024-01-02"
    assert stored == 2
