"""Deterministic tests for the dashboard forecast distribution."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from macro_predictor.dashboard.distribution import (
    DistributionSpec,
    audit_oos_predictions,
    build_forecast_distribution,
    calculate_interval_coverage,
)


def test_seed_reproducibility_and_histogram_contract() -> None:
    """The same OOS errors and seed produce exactly the same compact distribution."""
    predictions = _predictions(80)
    spec = DistributionSpec(seed=1729, thresholds=(0.0, 0.003), histogram_bins=32)

    first = build_forecast_distribution(0.0025, predictions, spec)
    second = build_forecast_distribution(0.0025, predictions, spec)

    assert first["drawDigestSha256"] == second["drawDigestSha256"]
    assert first["histogram"] == second["histogram"]
    assert sum(item["count"] for item in first["histogram"]) == 10_000
    assert first["residualSource"] == "expanding-window-out-of-sample-predictions-only"


def test_quantiles_are_ordered_and_threshold_probabilities_are_bounded() -> None:
    """Export ordered empirical quantiles and valid threshold probabilities."""
    distribution = build_forecast_distribution(
        0.0025,
        _predictions(80),
        DistributionSpec(seed=23, thresholds=(0.0, 0.003)),
    )

    quantiles = distribution["quantiles"]
    values = [quantiles[name] for name in ("p10", "p25", "p50", "p75", "p90")]
    assert values == sorted(values)
    for item in distribution["thresholdProbabilities"]:
        assert 0.0 <= item["probabilityAbove"] <= 1.0
        assert 0.0 <= item["probabilityBelow"] <= 1.0


def test_interval_coverage_uses_only_prior_residuals() -> None:
    """Coverage evaluation starts only after the configured residual history."""
    coverage = calculate_interval_coverage(_predictions(20), minimum_history=8)

    assert [item["nominal"] for item in coverage] == [0.5, 0.8, 0.9]
    assert all(item["sampleSize"] == 12 for item in coverage)
    assert all(item["averageIntervalWidth"] is not None for item in coverage)
    assert all(0.0 <= item["observed"] <= 1.0 for item in coverage)


def test_fewer_than_36_residuals_is_preliminary_and_rejected() -> None:
    """Small residual samples cannot pass the Phase 2 distribution gate."""
    distribution = build_forecast_distribution(
        0.0025,
        _predictions(35),
        DistributionSpec(seed=7, thresholds=()),
    )

    assert distribution["preliminary"] is True
    assert distribution["accepted"] is False
    assert "Preliminary" in distribution["warnings"][0]


def test_missing_prediction_value_is_rejected() -> None:
    """Missing OOS errors fail before any bootstrap draw is made."""
    predictions = _predictions(40)
    predictions.loc[4, "actual"] = np.nan

    with pytest.raises(ValueError, match="missing"):
        build_forecast_distribution(
            0.0025,
            predictions,
            DistributionSpec(seed=7, thresholds=()),
        )


def test_look_ahead_training_overlap_is_rejected() -> None:
    """A fold whose training window touches its test window is not OOS evidence."""
    predictions = _predictions(40)
    predictions.loc[0, "train_end"] = predictions.loc[0, "test_start"]

    with pytest.raises(ValueError, match="Look-ahead rejected"):
        audit_oos_predictions(predictions)


def _predictions(count: int) -> pd.DataFrame:
    dates = pd.date_range("2010-01-01", periods=count, freq="MS")
    phase = np.arange(count, dtype=float)
    residuals = 0.0015 * np.sin(phase * 0.73) + 0.0004 * np.cos(phase * 0.17)
    prediction = 0.002 + 0.0003 * np.sin(phase * 0.11)
    return pd.DataFrame(
        {
            "actual": prediction + residuals,
            "prediction": prediction,
            "as_of_date": dates + pd.offsets.Day(14),
            "target_reference_date": dates,
            "train_end": dates - pd.offsets.Day(1),
            "test_start": dates,
        }
    )
