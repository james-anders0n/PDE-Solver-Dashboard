"""Point-in-time feature engineering."""

from __future__ import annotations

import re
from dataclasses import dataclass

import pandas as pd
from sqlalchemy import select
from sqlalchemy.engine import Engine

from macro_predictor.config import Settings, get_settings
from macro_predictor.data_sources.database import observations
from macro_predictor.data_sources.schema import OBSERVATION_COLUMNS

AS_OF_DATE_COLUMN = "as_of_date"
TARGET_REFERENCE_DATE_COLUMN = "target_reference_date"
TARGET_VALUE_COLUMN = "target_mom"


@dataclass(frozen=True)
class FeatureSpec:
    """Resolved feature-generation settings."""

    target_series_id: str
    mom_periods: tuple[int, ...]
    yoy_periods: tuple[int, ...]
    rolling_z_windows: tuple[int, ...]
    target_lag_periods: tuple[int, ...]
    pmi_series_ids: tuple[str, ...]
    yield_curve_long_series_id: str | None
    yield_curve_short_series_id: str | None
    fed_funds_series_id: str | None
    inflation_level_series_id: str | None
    inflation_rate_scale: float
    cutoff_inclusive: bool


def spec_from_settings(settings: Settings | None = None) -> FeatureSpec:
    """Build a feature specification from runtime settings."""
    resolved = settings or get_settings()
    if not resolved.target_series_id:
        msg = "TARGET_SERIES_ID is required for point-in-time feature generation."
        raise ValueError(msg)
    return FeatureSpec(
        target_series_id=resolved.target_series_id,
        mom_periods=resolved.feature_mom_periods,
        yoy_periods=resolved.feature_yoy_periods,
        rolling_z_windows=resolved.feature_rolling_z_windows,
        target_lag_periods=resolved.target_lag_periods,
        pmi_series_ids=resolved.pmi_series_ids,
        yield_curve_long_series_id=resolved.yield_curve_long_series_id,
        yield_curve_short_series_id=resolved.yield_curve_short_series_id,
        fed_funds_series_id=resolved.fed_funds_series_id,
        inflation_level_series_id=resolved.inflation_level_series_id,
        inflation_rate_scale=resolved.inflation_rate_scale,
        cutoff_inclusive=resolved.feature_cutoff_inclusive,
    )


def load_observations(engine: Engine) -> pd.DataFrame:
    """Load normalized observations from SQLite."""
    return pd.read_sql(select(observations), engine)


def build_feature_frame(observation_frame: pd.DataFrame, spec: FeatureSpec) -> pd.DataFrame:
    """Build strict point-in-time features and target labels."""
    observations_frame = _normalize_observations(observation_frame)
    target_rows = _target_rows(observations_frame, spec.target_series_id)
    feature_rows = [
        _build_row(observations_frame, target_row, spec)
        for target_row in target_rows.itertuples(index=False)
    ]
    if not feature_rows:
        msg = "No feature rows could be built from target observations."
        raise ValueError(msg)
    return validate_feature_frame(pd.DataFrame(feature_rows))


def validate_feature_frame(feature_frame: pd.DataFrame) -> pd.DataFrame:
    """Validate generated feature rows."""
    required_columns = {AS_OF_DATE_COLUMN, TARGET_REFERENCE_DATE_COLUMN, TARGET_VALUE_COLUMN}
    missing = required_columns.difference(feature_frame.columns)
    if missing:
        msg = f"Feature frame missing required columns: {', '.join(sorted(missing))}"
        raise ValueError(msg)
    if feature_frame.empty:
        msg = "Feature frame contains no rows."
        raise ValueError(msg)
    normalized = feature_frame.copy()
    normalized[AS_OF_DATE_COLUMN] = pd.to_datetime(normalized[AS_OF_DATE_COLUMN], errors="raise")
    normalized[TARGET_REFERENCE_DATE_COLUMN] = pd.to_datetime(
        normalized[TARGET_REFERENCE_DATE_COLUMN],
        errors="raise",
    )
    normalized[TARGET_VALUE_COLUMN] = pd.to_numeric(
        normalized[TARGET_VALUE_COLUMN],
        errors="raise",
    )
    required_values = normalized[
        [AS_OF_DATE_COLUMN, TARGET_REFERENCE_DATE_COLUMN, TARGET_VALUE_COLUMN]
    ]
    if required_values.isna().any().any():
        msg = "Feature frame contains nulls in required columns."
        raise ValueError(msg)
    return normalized.sort_values(AS_OF_DATE_COLUMN).reset_index(drop=True)


def _normalize_observations(frame: pd.DataFrame) -> pd.DataFrame:
    missing = [column for column in OBSERVATION_COLUMNS if column not in frame.columns]
    if missing:
        msg = f"Observation frame missing required columns: {', '.join(missing)}"
        raise ValueError(msg)
    normalized = frame.loc[:, OBSERVATION_COLUMNS].copy()
    normalized["series_id"] = normalized["series_id"].astype("string")
    normalized["date"] = pd.to_datetime(normalized["date"], errors="raise")
    normalized["release_date"] = pd.to_datetime(normalized["release_date"], errors="raise")
    normalized["fetched_at"] = pd.to_datetime(normalized["fetched_at"], errors="raise", utc=True)
    normalized["value"] = pd.to_numeric(normalized["value"], errors="raise")
    if normalized[["series_id", "date", "release_date", "value"]].isna().any().any():
        msg = "Observation frame contains nulls in required feature inputs."
        raise ValueError(msg)
    return normalized.sort_values(["series_id", "release_date", "date"]).reset_index(drop=True)


def _target_rows(frame: pd.DataFrame, target_series_id: str) -> pd.DataFrame:
    target = frame.loc[frame["series_id"] == target_series_id].copy()
    if target.empty:
        msg = f"Target series not found in observations: {target_series_id}"
        raise ValueError(msg)
    sorted_target = target.sort_values(["release_date", "date"]).reset_index(drop=True)
    labeled_target = sorted_target.loc[
        [
            _has_prior_target_observation(frame, target_series_id, row.date, row.release_date)
            for row in sorted_target.itertuples(index=False)
        ]
    ]
    if labeled_target.empty:
        msg = f"Target series has no observations with computable MoM labels: {target_series_id}"
        raise ValueError(msg)
    return labeled_target.reset_index(drop=True)


def _has_prior_target_observation(
    frame: pd.DataFrame,
    target_series_id: str,
    reference_date: pd.Timestamp,
    release_date: pd.Timestamp,
) -> bool:
    target_history = frame.loc[
        (frame["series_id"] == target_series_id)
        & (frame["release_date"] <= release_date)
        & (frame["date"] < reference_date)
    ]
    return not target_history.empty


def _build_row(
    frame: pd.DataFrame,
    target_row: object,
    spec: FeatureSpec,
) -> dict[str, object]:
    as_of_date = target_row.release_date
    reference_date = target_row.date
    target_value = _target_mom_at_release(
        frame,
        spec.target_series_id,
        reference_date,
        as_of_date,
    )
    history = _available_history(frame, as_of_date, inclusive=spec.cutoff_inclusive)
    features = _latest_series_features(history, spec)
    features.update(_pmi_features(history, spec))
    features.update(_yield_curve_features(history, spec))
    features.update(_real_fed_funds_features(history, spec))
    features.update(_lagged_target_features(history, spec))
    return {
        AS_OF_DATE_COLUMN: as_of_date,
        TARGET_REFERENCE_DATE_COLUMN: reference_date,
        TARGET_VALUE_COLUMN: target_value,
        **features,
    }


def _available_history(
    frame: pd.DataFrame,
    as_of_date: pd.Timestamp,
    inclusive: bool,
) -> pd.DataFrame:
    if inclusive:
        available = frame.loc[frame["release_date"] <= as_of_date].copy()
    else:
        available = frame.loc[frame["release_date"] < as_of_date].copy()
    if available.empty:
        msg = f"No observations available before feature date {as_of_date.date().isoformat()}."
        raise ValueError(msg)
    return _latest_vintage_by_reference_date(available)


def _latest_vintage_by_reference_date(frame: pd.DataFrame) -> pd.DataFrame:
    return (
        frame.sort_values(["series_id", "date", "release_date"])
        .drop_duplicates(subset=["series_id", "date"], keep="last")
        .sort_values(["series_id", "date"])
        .reset_index(drop=True)
    )


def _target_mom_at_release(
    frame: pd.DataFrame,
    target_series_id: str,
    reference_date: pd.Timestamp,
    release_date: pd.Timestamp,
) -> float:
    target_history = frame.loc[
        (frame["series_id"] == target_series_id) & (frame["release_date"] <= release_date)
    ]
    vintage = _latest_vintage_by_reference_date(target_history)
    series = _series_values(vintage, target_series_id)
    mom = _percent_change(series, period=1)
    try:
        value = mom.loc[reference_date]
    except KeyError as exc:
        msg = f"Target MoM cannot be computed for {reference_date.date().isoformat()}."
        raise ValueError(msg) from exc
    if pd.isna(value):
        msg = f"Target MoM is not available for {reference_date.date().isoformat()}."
        raise ValueError(msg)
    return float(value)


def _latest_series_features(history: pd.DataFrame, spec: FeatureSpec) -> dict[str, float]:
    features: dict[str, float] = {}
    for series_id in sorted(history["series_id"].dropna().unique()):
        series = _series_values(history, str(series_id))
        prefix = _series_prefix(str(series_id))
        latest = series.dropna()
        if latest.empty:
            continue
        features[f"{prefix}__level"] = float(latest.iloc[-1])
        for period in spec.mom_periods:
            features[f"{prefix}__mom_{period}"] = _latest_non_null(_percent_change(series, period))
        for period in spec.yoy_periods:
            features[f"{prefix}__yoy_{period}"] = _latest_non_null(_percent_change(series, period))
        for window in spec.rolling_z_windows:
            features[f"{prefix}__z_{window}"] = _latest_non_null(_rolling_z_score(series, window))
    return features


def _pmi_features(history: pd.DataFrame, spec: FeatureSpec) -> dict[str, float]:
    features: dict[str, float] = {}
    pmi_values: list[float] = []
    for series_id in spec.pmi_series_ids:
        series = _series_values(history, series_id)
        latest = series.dropna()
        if latest.empty:
            continue
        value = float(latest.iloc[-1])
        features[f"pmi_diffusion__{_series_prefix(series_id)}"] = value
        pmi_values.append(value)
    if pmi_values:
        features["pmi_diffusion__mean"] = float(pd.Series(pmi_values).mean())
    return features


def _yield_curve_features(history: pd.DataFrame, spec: FeatureSpec) -> dict[str, float]:
    if not spec.yield_curve_long_series_id or not spec.yield_curve_short_series_id:
        return {}
    long_value = _latest_value(history, spec.yield_curve_long_series_id)
    short_value = _latest_value(history, spec.yield_curve_short_series_id)
    if long_value is None or short_value is None:
        return {}
    return {"yield_curve__long_minus_short": long_value - short_value}


def _real_fed_funds_features(history: pd.DataFrame, spec: FeatureSpec) -> dict[str, float]:
    if not spec.fed_funds_series_id or not spec.inflation_level_series_id:
        return {}
    fed_funds = _latest_value(history, spec.fed_funds_series_id)
    inflation = _latest_non_null(
        _percent_change(_series_values(history, spec.inflation_level_series_id), period=12)
    )
    if fed_funds is None or pd.isna(inflation):
        return {}
    return {"real_fed_funds__proxy": fed_funds - inflation * spec.inflation_rate_scale}


def _lagged_target_features(history: pd.DataFrame, spec: FeatureSpec) -> dict[str, float]:
    series = _series_values(history, spec.target_series_id)
    mom = _percent_change(series, period=1).dropna()
    features: dict[str, float] = {}
    for lag in spec.target_lag_periods:
        if len(mom) > lag - 1:
            features[f"target_mom__lag_{lag}"] = float(mom.iloc[-lag])
    return features


def _series_values(history: pd.DataFrame, series_id: str) -> pd.Series:
    series_frame = history.loc[history["series_id"] == series_id, ["date", "value"]].copy()
    if series_frame.empty:
        return pd.Series(dtype="float64")
    return (
        series_frame.sort_values("date")
        .drop_duplicates(subset=["date"], keep="last")
        .set_index("date")["value"]
        .astype("float64")
    )


def _percent_change(series: pd.Series, period: int) -> pd.Series:
    if period <= 0:
        msg = "Percent-change period must be positive."
        raise ValueError(msg)
    return series.pct_change(periods=period, fill_method=None)


def _rolling_z_score(series: pd.Series, window: int) -> pd.Series:
    if window <= 1:
        msg = "Rolling z-score window must be greater than one."
        raise ValueError(msg)
    rolling_mean = series.rolling(window=window).mean()
    rolling_std = series.rolling(window=window).std()
    return (series - rolling_mean) / rolling_std


def _latest_value(history: pd.DataFrame, series_id: str) -> float | None:
    series = _series_values(history, series_id).dropna()
    if series.empty:
        return None
    return float(series.iloc[-1])


def _latest_non_null(series: pd.Series) -> float:
    cleaned = series.dropna()
    if cleaned.empty:
        return float("nan")
    return float(cleaned.iloc[-1])


def _series_prefix(series_id: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z]+", "_", series_id).strip("_").lower()
    if not normalized:
        msg = "Series ID cannot produce an empty feature prefix."
        raise ValueError(msg)
    return normalized
