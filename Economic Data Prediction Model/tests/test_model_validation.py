"""Tests for expanding-window model validation."""

from __future__ import annotations

import numpy as np
import pandas as pd
from pytest import approx

from macro_predictor.models import ModelSpec, evaluate_models, expanding_window_splits


def test_expanding_window_splits_are_walk_forward_only() -> None:
    """Create expanding train windows with forward-only test windows."""
    splits = expanding_window_splits(
        row_count=8,
        min_train_size=3,
        test_size=2,
        step_size=2,
        allow_partial_test_window=True,
    )

    assert [(train.tolist(), test.tolist()) for train, test in splits] == [
        ([0, 1, 2], [3, 4]),
        ([0, 1, 2, 3, 4], [5, 6]),
        ([0, 1, 2, 3, 4, 5, 6], [7]),
    ]


def test_evaluate_models_outputs_metrics_and_naive_comparison() -> None:
    """Evaluate Ridge and LightGBM with out-of-sample metrics."""
    feature_frame = _feature_frame()
    spec = ModelSpec(
        min_train_size=8,
        test_size=2,
        step_size=2,
        allow_partial_test_window=False,
        imputation_strategy="median",
        ridge_alpha=1.0,
        lightgbm_params={
            "n_estimators": 5,
            "learning_rate": 0.1,
            "min_child_samples": 1,
            "n_jobs": 1,
            "verbosity": -1,
            "random_state": 7,
        },
    )

    results = evaluate_models(feature_frame, spec)

    assert set(results) == {"ridge", "lightgbm"}
    assert results["ridge"].summary_metrics["rmse"] >= 0.0
    assert results["ridge"].summary_metrics["mae"] >= 0.0
    assert 0.0 <= results["ridge"].summary_metrics["directional_accuracy"] <= 1.0
    assert 0.0 <= results["ridge"].summary_metrics["hit_rate_vs_naive"] <= 1.0
    assert "naive last-value baseline" in str(results["ridge"].summary_metrics["naive_comparison"])
    assert len(results["ridge"].fold_results) == 4
    assert len(results["lightgbm"].predictions) == len(results["ridge"].predictions)


def test_ridge_can_beat_naive_on_trending_synthetic_data() -> None:
    """Flag a model as beating naive when its aggregate RMSE is lower."""
    feature_frame = _feature_frame()
    spec = ModelSpec(
        min_train_size=8,
        test_size=1,
        step_size=1,
        allow_partial_test_window=False,
        imputation_strategy="median",
        ridge_alpha=0.1,
        lightgbm_params={
            "n_estimators": 5,
            "learning_rate": 0.1,
            "min_child_samples": 1,
            "n_jobs": 1,
            "verbosity": -1,
            "random_state": 7,
        },
    )

    ridge = evaluate_models(feature_frame, spec)["ridge"]

    assert ridge.summary_metrics["beats_naive_rmse"] is True
    assert ridge.summary_metrics["rmse"] == approx(0.0, abs=0.02)


def _feature_frame() -> pd.DataFrame:
    periods = 16
    index = np.arange(periods, dtype=float)
    target = 0.01 + index * 0.002
    return pd.DataFrame(
        {
            "as_of_date": pd.date_range("2020-01-31", periods=periods, freq="ME"),
            "target_reference_date": pd.date_range("2019-12-31", periods=periods, freq="ME"),
            "target_mom": target,
            "signal": target,
            "lagged_signal": np.roll(target, shift=1),
        }
    )
