"""Environment-driven application configuration."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class TreasurySeriesConfig:
    """Configuration for one Treasury Fiscal Data API series."""

    series_id: str
    endpoint: str
    date_field: str
    value_field: str
    release_date_field: str
    filters: str | None = None


@dataclass(frozen=True)
class Settings:
    """Runtime settings loaded from environment variables."""

    fred_api_key: str | None
    fred_series_ids: tuple[str, ...]
    fred_observations_url: str
    database_url: str
    log_level: str
    request_timeout_seconds: float
    request_max_retries: int
    request_backoff_seconds: float
    treasury_series: tuple[TreasurySeriesConfig, ...]
    treasury_base_url: str
    treasury_page_size: int
    market_tickers: tuple[str, ...]
    market_start_date: str | None
    market_end_date: str | None
    market_release_lag_days: int
    target_series_id: str | None
    feature_mom_periods: tuple[int, ...] = (1,)
    feature_yoy_periods: tuple[int, ...] = (12,)
    feature_rolling_z_windows: tuple[int, ...] = (12, 24)
    target_lag_periods: tuple[int, ...] = (1,)
    pmi_series_ids: tuple[str, ...] = ()
    yield_curve_long_series_id: str | None = None
    yield_curve_short_series_id: str | None = None
    fed_funds_series_id: str | None = None
    inflation_level_series_id: str | None = None
    inflation_rate_scale: float = 100.0
    feature_cutoff_inclusive: bool = False
    model_min_train_size: int | None = None
    model_test_size: int | None = None
    model_step_size: int | None = None
    model_allow_partial_test_window: bool | None = None
    model_imputation_strategy: str | None = None
    ridge_alpha: float | None = None
    lightgbm_params: dict[str, object] | None = None
    report_output_dir: str = "reports"
    report_plot_width: int = 960
    report_plot_height: int = 420
    report_plot_padding: int = 48


def get_settings() -> Settings:
    """Return settings sourced from environment variables."""
    return Settings(
        fred_api_key=os.getenv("FRED_API_KEY"),
        fred_series_ids=_csv_env("FRED_SERIES_IDS"),
        fred_observations_url=os.getenv(
            "FRED_OBSERVATIONS_URL",
            "https://api.stlouisfed.org/fred/series/observations",
        ),
        database_url=os.getenv("DATABASE_URL", "sqlite:///data/macro.sqlite"),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "30")),
        request_max_retries=int(os.getenv("REQUEST_MAX_RETRIES", "3")),
        request_backoff_seconds=float(os.getenv("REQUEST_BACKOFF_SECONDS", "1.0")),
        treasury_series=_treasury_series_env(),
        treasury_base_url=os.getenv(
            "TREASURY_BASE_URL",
            "https://api.fiscaldata.treasury.gov/services/api/fiscal_service",
        ),
        treasury_page_size=int(os.getenv("TREASURY_PAGE_SIZE", "5000")),
        market_tickers=_csv_env("MARKET_TICKERS"),
        market_start_date=os.getenv("MARKET_START_DATE"),
        market_end_date=os.getenv("MARKET_END_DATE"),
        market_release_lag_days=int(os.getenv("MARKET_RELEASE_LAG_DAYS", "0")),
        target_series_id=os.getenv("TARGET_SERIES_ID"),
        feature_mom_periods=_int_csv_env("FEATURE_MOM_PERIODS", "1"),
        feature_yoy_periods=_int_csv_env("FEATURE_YOY_PERIODS", "12"),
        feature_rolling_z_windows=_int_csv_env("FEATURE_ROLLING_Z_WINDOWS", "12,24"),
        target_lag_periods=_int_csv_env("TARGET_LAG_PERIODS", "1"),
        pmi_series_ids=_csv_env("PMI_SERIES_IDS"),
        yield_curve_long_series_id=os.getenv("YIELD_CURVE_LONG_SERIES_ID"),
        yield_curve_short_series_id=os.getenv("YIELD_CURVE_SHORT_SERIES_ID"),
        fed_funds_series_id=os.getenv("FED_FUNDS_SERIES_ID"),
        inflation_level_series_id=os.getenv("INFLATION_LEVEL_SERIES_ID"),
        inflation_rate_scale=float(os.getenv("INFLATION_RATE_SCALE", "100.0")),
        feature_cutoff_inclusive=_bool_env("FEATURE_CUTOFF_INCLUSIVE", default=False),
        model_min_train_size=_optional_int_env("MODEL_MIN_TRAIN_SIZE"),
        model_test_size=_optional_int_env("MODEL_TEST_SIZE"),
        model_step_size=_optional_int_env("MODEL_STEP_SIZE"),
        model_allow_partial_test_window=_optional_bool_env("MODEL_ALLOW_PARTIAL_TEST_WINDOW"),
        model_imputation_strategy=os.getenv("MODEL_IMPUTATION_STRATEGY"),
        ridge_alpha=_optional_float_env("RIDGE_ALPHA"),
        lightgbm_params=_json_object_env("LIGHTGBM_PARAMS_JSON"),
        report_output_dir=os.getenv("REPORT_OUTPUT_DIR", "reports"),
        report_plot_width=int(os.getenv("REPORT_PLOT_WIDTH", "960")),
        report_plot_height=int(os.getenv("REPORT_PLOT_HEIGHT", "420")),
        report_plot_padding=int(os.getenv("REPORT_PLOT_PADDING", "48")),
    )


def _csv_env(name: str) -> tuple[str, ...]:
    value = os.getenv(name, "")
    return tuple(item.strip() for item in value.split(",") if item.strip())


def _int_csv_env(name: str, default: str) -> tuple[int, ...]:
    value = os.getenv(name, default)
    return tuple(int(item.strip()) for item in value.split(",") if item.strip())


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y"}


def _optional_bool_env(name: str) -> bool | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip().lower() in {"1", "true", "yes", "y"}


def _optional_int_env(name: str) -> int | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return int(value)


def _optional_float_env(name: str) -> float | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return float(value)


def _json_object_env(name: str) -> dict[str, object] | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    payload = json.loads(value)
    if not isinstance(payload, dict):
        msg = f"{name} must be a JSON object."
        raise ValueError(msg)
    return payload


def _treasury_series_env() -> tuple[TreasurySeriesConfig, ...]:
    raw_value = os.getenv("TREASURY_SERIES_CONFIG_JSON", "[]")
    payload = json.loads(raw_value)
    if not isinstance(payload, list):
        msg = "TREASURY_SERIES_CONFIG_JSON must be a JSON list."
        raise ValueError(msg)
    return tuple(_treasury_series_config(item) for item in payload)


def _treasury_series_config(item: object) -> TreasurySeriesConfig:
    if not isinstance(item, dict):
        msg = "Each Treasury series config must be a JSON object."
        raise ValueError(msg)
    required = ("series_id", "endpoint", "date_field", "value_field", "release_date_field")
    missing = [field for field in required if not item.get(field)]
    if missing:
        msg = f"Treasury series config missing required fields: {', '.join(missing)}"
        raise ValueError(msg)
    return TreasurySeriesConfig(
        series_id=str(item["series_id"]),
        endpoint=str(item["endpoint"]),
        date_field=str(item["date_field"]),
        value_field=str(item["value_field"]),
        release_date_field=str(item["release_date_field"]),
        filters=str(item["filters"]) if item.get("filters") else None,
    )
