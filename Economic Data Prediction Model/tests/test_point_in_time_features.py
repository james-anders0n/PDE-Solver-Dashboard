"""Tests for point-in-time feature generation."""

from __future__ import annotations

from datetime import UTC, datetime

import pandas as pd
from pytest import approx

from macro_predictor.features import FeatureSpec, build_feature_frame


def test_feature_frame_excludes_same_day_and_future_releases() -> None:
    """Build features without using observations published on or after target release."""
    observations = pd.DataFrame(
        [
            _row("TGT", "2024-01-01", 100.0, "2024-02-15"),
            _row("TGT", "2024-02-01", 102.0, "2024-03-15"),
            _row("TGT", "2024-03-01", 105.0, "2024-04-15"),
            _row("X", "2024-01-01", 10.0, "2024-03-10"),
            _row("X", "2024-02-01", 20.0, "2024-03-20"),
        ]
    )
    spec = _spec()

    features = build_feature_frame(observations, spec)
    february_row = features.loc[
        features["target_reference_date"] == pd.Timestamp("2024-02-01")
    ].iloc[0]
    march_row = features.loc[features["target_reference_date"] == pd.Timestamp("2024-03-01")].iloc[
        0
    ]

    assert february_row["target_mom"] == approx(0.02)
    assert february_row["x__level"] == 10.0
    assert "target_mom__lag_1" not in february_row.dropna().index
    assert march_row["x__level"] == 20.0
    assert march_row["target_mom__lag_1"] == approx(0.02)


def test_feature_frame_excludes_future_vintage_revisions() -> None:
    """Do not use a revised value whose vintage post-dates the historical feature cutoff."""
    observations = pd.DataFrame(
        [
            {**_row("TGT", "2024-01-01", 100.0, "2024-02-15"), "vintage_date": "2024-02-15"},
            {**_row("TGT", "2024-02-01", 102.0, "2024-03-15"), "vintage_date": "2024-03-15"},
            {**_row("X", "2024-01-01", 10.0, "2024-03-01"), "vintage_date": "2024-03-01"},
            {**_row("X", "2024-01-01", 99.0, "2024-03-01"), "vintage_date": "2024-04-01"},
        ]
    )

    features = build_feature_frame(observations, _spec())
    row = features.loc[features["target_reference_date"] == pd.Timestamp("2024-02-01")].iloc[0]

    assert row["x__level"] == 10.0


def test_feature_frame_builds_default_derived_features() -> None:
    """Build PMI, curve slope, real fed funds, and rolling feature columns."""
    rows = [
        _row("TGT", "2024-01-01", 100.0, "2024-02-15"),
        _row("TGT", "2024-02-01", 102.0, "2024-03-15"),
        _row("LONG", "2024-02-01", 4.0, "2024-03-01"),
        _row("SHORT", "2024-02-01", 3.0, "2024-03-01"),
        _row("PMI", "2024-02-01", 51.0, "2024-03-01"),
        _row("FED", "2024-02-01", 5.0, "2024-03-01"),
    ]
    rows.extend(
        _row("CPI", f"2023-{month:02d}-01", 100.0 + month, f"2023-{month + 1:02d}-15")
        for month in range(1, 12)
    )
    rows.extend(
        [
            _row("CPI", "2023-12-01", 112.0, "2024-01-15"),
            _row("CPI", "2024-01-01", 124.0, "2024-02-15"),
            _row("CPI", "2024-02-01", 126.0, "2024-03-01"),
        ]
    )
    spec = _spec(
        pmi_series_ids=("PMI",),
        yield_curve_long_series_id="LONG",
        yield_curve_short_series_id="SHORT",
        fed_funds_series_id="FED",
        inflation_level_series_id="CPI",
        rolling_z_windows=(2,),
    )

    features = build_feature_frame(pd.DataFrame(rows), spec)
    row = features.loc[features["target_reference_date"] == pd.Timestamp("2024-02-01")].iloc[0]

    assert row["pmi_diffusion__pmi"] == 51.0
    assert row["pmi_diffusion__mean"] == 51.0
    assert row["yield_curve__long_minus_short"] == 1.0
    assert round(row["real_fed_funds__proxy"], 6) == round(5.0 - ((126.0 / 102.0) - 1.0) * 100.0, 6)
    assert "cpi__z_2" in row.index


def _row(series_id: str, date: str, value: float, release_date: str) -> dict[str, object]:
    return {
        "series_id": series_id,
        "date": date,
        "value": value,
        "source": "test",
        "release_date": release_date,
        "fetched_at": datetime(2024, 5, 1, tzinfo=UTC),
    }


def _spec(
    pmi_series_ids: tuple[str, ...] = (),
    yield_curve_long_series_id: str | None = None,
    yield_curve_short_series_id: str | None = None,
    fed_funds_series_id: str | None = None,
    inflation_level_series_id: str | None = None,
    rolling_z_windows: tuple[int, ...] = (),
) -> FeatureSpec:
    return FeatureSpec(
        target_series_id="TGT",
        mom_periods=(1,),
        yoy_periods=(12,),
        rolling_z_windows=rolling_z_windows,
        target_lag_periods=(1,),
        pmi_series_ids=pmi_series_ids,
        yield_curve_long_series_id=yield_curve_long_series_id,
        yield_curve_short_series_id=yield_curve_short_series_id,
        fed_funds_series_id=fed_funds_series_id,
        inflation_level_series_id=inflation_level_series_id,
        inflation_rate_scale=100.0,
        cutoff_inclusive=False,
    )
