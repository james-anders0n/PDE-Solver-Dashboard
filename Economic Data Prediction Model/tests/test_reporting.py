"""Tests for baseline report generation."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pandas as pd

from macro_predictor.models import ModelResult, ModelSpec
from macro_predictor.reporting import ReportSpec, save_baseline_report


def test_save_baseline_report_writes_markdown_and_plot(tmp_path: object) -> None:
    """Save a markdown baseline report with data, metrics, params, folds, and plot."""
    output_dir = tmp_path / "reports"
    report_spec = ReportSpec(
        output_dir=output_dir,
        plot_width=640,
        plot_height=320,
        plot_padding=40,
    )
    report_path = save_baseline_report(
        observation_frame=_observation_frame(),
        feature_frame=_feature_frame(),
        model_results={"ridge": _model_result("ridge")},
        model_spec=_model_spec(),
        report_spec=report_spec,
        run_date=date(2024, 5, 1),
    )
    plot_path = output_dir / "2024-05-01_predicted_vs_actual.svg"

    content = report_path.read_text(encoding="utf-8")
    plot_content = plot_path.read_text(encoding="utf-8")

    assert report_path == output_dir / "2024-05-01_baseline.md"
    assert "# Baseline CPI MoM Forecast Report" in content
    assert "## Data Coverage" in content
    assert "## Features" in content
    assert "## Parameters" in content
    assert "## Fold Results" in content
    assert "## Summary Metrics" in content
    assert "Model does not beat the naive last-value baseline" in content
    assert "![Predicted versus actual](2024-05-01_predicted_vs_actual.svg)" in content
    assert "<svg" in plot_content
    assert "ridge prediction" in plot_content


def _observation_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "series_id": "TGT",
                "date": "2024-01-01",
                "value": 100.0,
                "source": "test",
                "release_date": "2024-02-15",
                "fetched_at": datetime(2024, 5, 1, tzinfo=UTC),
            },
            {
                "series_id": "TGT",
                "date": "2024-02-01",
                "value": 101.0,
                "source": "test",
                "release_date": "2024-03-15",
                "fetched_at": datetime(2024, 5, 1, tzinfo=UTC),
            },
        ]
    )


def _feature_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "as_of_date": pd.to_datetime(["2024-03-15", "2024-04-15"]),
            "target_reference_date": pd.to_datetime(["2024-02-01", "2024-03-01"]),
            "target_mom": [0.01, 0.02],
            "tgt__mom_1": [0.005, 0.01],
        }
    )


def _model_result(model_name: str) -> ModelResult:
    fold_results = pd.DataFrame(
        [
            {
                "model_name": model_name,
                "fold_id": 0,
                "train_start": pd.Timestamp("2024-01-15"),
                "train_end": pd.Timestamp("2024-02-15"),
                "test_start": pd.Timestamp("2024-03-15"),
                "test_end": pd.Timestamp("2024-03-15"),
                "observations": 1,
                "rmse": 0.02,
                "mae": 0.02,
                "directional_accuracy": 1.0,
                "hit_rate_vs_naive": 0.0,
                "model_beats_naive_rmse": False,
            }
        ]
    )
    predictions = pd.DataFrame(
        {
            "model_name": [model_name, model_name],
            "fold_id": [0, 1],
            "as_of_date": pd.to_datetime(["2024-03-15", "2024-04-15"]),
            "target_reference_date": pd.to_datetime(["2024-02-01", "2024-03-01"]),
            "actual": [0.01, 0.02],
            "prediction": [0.03, 0.01],
            "naive_prediction": [0.01, 0.01],
        }
    )
    summary_metrics = {
        "rmse": 0.015,
        "mae": 0.015,
        "directional_accuracy": 1.0,
        "hit_rate_vs_naive": 0.0,
        "naive_rmse": 0.01,
        "naive_mae": 0.01,
        "beats_naive_rmse": False,
        "naive_comparison": (
            "Model does not beat the naive last-value baseline on out-of-sample RMSE."
        ),
    }
    return ModelResult(model_name, fold_results, predictions, summary_metrics)


def _model_spec() -> ModelSpec:
    return ModelSpec(
        min_train_size=12,
        test_size=1,
        step_size=1,
        allow_partial_test_window=False,
        imputation_strategy="median",
        ridge_alpha=1.0,
        lightgbm_params={"n_estimators": 10, "n_jobs": 1},
    )
