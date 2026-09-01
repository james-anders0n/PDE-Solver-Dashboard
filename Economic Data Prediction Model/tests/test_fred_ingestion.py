"""Tests for FRED ingestion."""

from __future__ import annotations

from datetime import UTC, datetime

from macro_predictor.config import Settings
from macro_predictor.data_sources import fred


class FakeResponse:
    """Minimal response object for mocked HTTP calls."""

    def __init__(self, payload: dict[str, object]) -> None:
        """Store the fake JSON payload."""
        self.payload = payload

    def raise_for_status(self) -> None:
        """Return without error for successful fake responses."""

    def json(self) -> dict[str, object]:
        """Return the configured JSON payload."""
        return self.payload


class FakeSession:
    """Minimal session object for mocked HTTP calls."""

    def __init__(self, payload: dict[str, object]) -> None:
        """Store the fake response payload and request history."""
        self.payload = payload
        self.calls: list[dict[str, object]] = []

    def get(self, url: str, params: dict[str, object], timeout: float) -> FakeResponse:
        """Record the request and return a fake response."""
        self.calls.append({"url": url, "params": params, "timeout": timeout})
        return FakeResponse(self.payload)


def test_fred_fetch_validate_and_store(tmp_path: object) -> None:
    """Fetch, validate, and store normalized FRED observations."""
    settings = Settings(
        fred_api_key="test-key",
        fred_series_ids=("CPI_TEST",),
        fred_observations_url="https://example.test/fred",
        database_url="sqlite:///:memory:",
        log_level="INFO",
        request_timeout_seconds=10.0,
        request_max_retries=0,
        request_backoff_seconds=0.0,
        treasury_series=(),
        treasury_base_url="https://example.test/treasury",
        treasury_page_size=100,
        market_tickers=(),
        market_start_date=None,
        market_end_date=None,
        market_release_lag_days=0,
        target_series_id=None,
    )
    payload = {
        "observations": [
            {"realtime_start": "2024-02-13", "date": "2024-01-01", "value": "310.326"},
            {"realtime_start": "2024-03-12", "date": "2024-02-01", "value": "."},
        ]
    }
    session = FakeSession(payload)

    frame = fred.fetch(
        settings=settings,
        session=session,
        fetched_at=datetime(2024, 3, 1, tzinfo=UTC),
    )
    validated = fred.validate(frame)
    stored = fred.store(validated, settings=settings)

    assert len(validated) == 1
    assert validated.loc[0, "series_id"] == "CPI_TEST"
    assert validated.loc[0, "release_date"].date().isoformat() == "2024-02-13"
    assert stored == 1
