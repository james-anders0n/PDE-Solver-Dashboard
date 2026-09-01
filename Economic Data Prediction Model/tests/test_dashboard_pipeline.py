"""Tests for point-in-time orchestration inputs and immutable publishing."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from macro_predictor.dashboard.pipeline import (
    _publish_snapshot,
    run_pipeline,
    validate_simulation_inputs,
)


def test_orchestrating_command_is_reproducible_and_publishes_accepted_latest(
    tmp_path: Path,
) -> None:
    """One configuration deterministically executes every Phase 2 pipeline stage."""
    input_path = tmp_path / "observations.csv"
    config_path = tmp_path / "run.json"
    output_path = tmp_path / "snapshots"
    _synthetic_point_in_time_observations().to_csv(input_path, index=False)
    config_path.write_text(
        json.dumps(_pipeline_config(input_path.name, output_path.name)),
        encoding="utf-8",
    )

    first = run_pipeline(config_path)
    second = run_pipeline(config_path)

    assert first["runId"] == second["runId"]
    assert first["distribution"]["drawDigestSha256"] == second["distribution"]["drawDigestSha256"]
    assert first["status"] == "accepted"
    assert first["distribution"]["drawCount"] == 10_000
    assert first["distribution"]["residualSampleSize"] >= 36
    assert (output_path / "runs" / f"{first['runId']}.json").exists()
    assert json.loads((output_path / "latest.json").read_text())["runId"] == first["runId"]


def test_simulation_input_dates_remain_distinct_and_future_rows_are_excluded() -> None:
    """Validate each time concept separately and remove vintages unavailable at run time."""
    frame = pd.DataFrame(
        [
            _input_row("2024-01-01", "2024-02-14", "2024-02-14"),
            _input_row("2024-02-01", "2024-03-14", "2024-03-14"),
        ]
    )

    eligible, excluded = validate_simulation_inputs(
        frame,
        pd.Timestamp("2024-03-01T00:00:00Z"),
    )

    assert list(eligible.columns) == [
        "series_id",
        "observation_date",
        "value",
        "source",
        "availability_date",
        "vintage_date",
        "fetched_at",
    ]
    assert len(eligible) == 1
    assert excluded == 1


def test_simulation_input_missing_values_are_rejected() -> None:
    """A missing vintage cannot silently flow into a point-in-time run."""
    frame = pd.DataFrame([_input_row("2024-01-01", "2024-02-14", None)])

    with pytest.raises(ValueError, match="missing"):
        validate_simulation_inputs(frame, pd.Timestamp("2024-03-01T00:00:00Z"))


def test_simulation_input_look_ahead_is_rejected() -> None:
    """An observation timestamped after its availability date fails closed."""
    frame = pd.DataFrame([_input_row("2024-03-01", "2024-02-14", "2024-02-14")])

    with pytest.raises(ValueError, match="Look-ahead rejected"):
        validate_simulation_inputs(frame, pd.Timestamp("2024-03-01T00:00:00Z"))


def test_latest_is_updated_only_for_an_accepted_snapshot(tmp_path: Path) -> None:
    """Rejected runs remain immutable without replacing the latest accepted snapshot."""
    rejected = _minimal_snapshot("run-rejected", accepted=False)
    _publish_snapshot(rejected, tmp_path)

    assert (tmp_path / "runs" / "run-rejected.json").exists()
    assert not (tmp_path / "latest.json").exists()

    accepted = _minimal_snapshot("run-accepted", accepted=True)
    _publish_snapshot(accepted, tmp_path)

    assert (tmp_path / "runs" / "run-accepted.json").exists()
    assert '"runId": "run-accepted"' in (tmp_path / "latest.json").read_text()


def test_immutable_run_id_cannot_be_overwritten(tmp_path: Path) -> None:
    """A runId collision with different content is rejected."""
    first = _minimal_snapshot("same-run", accepted=False)
    _publish_snapshot(first, tmp_path)
    changed = _minimal_snapshot("same-run", accepted=False)
    changed["status"] = "changed"

    with pytest.raises(FileExistsError, match="Immutable runId collision"):
        _publish_snapshot(changed, tmp_path)


def _input_row(
    observation_date: str,
    availability_date: str,
    vintage_date: str | None,
) -> dict[str, object]:
    return {
        "series_id": "CPI",
        "observation_date": observation_date,
        "value": 100.0,
        "source": "test",
        "availability_date": availability_date,
        "vintage_date": vintage_date,
        "fetched_at": "2024-04-01T00:00:00Z",
    }


def _minimal_snapshot(run_id: str, accepted: bool) -> dict[str, object]:
    return {
        "runId": run_id,
        "status": "accepted" if accepted else "rejected",
        "acceptance": {"accepted": accepted},
    }


def _synthetic_point_in_time_observations() -> pd.DataFrame:
    observation_dates = pd.date_range("2010-01-01", periods=121, freq="MS")
    generator = np.random.default_rng(4921)
    signal = 0.002 + 0.0012 * np.sin(np.arange(121) * 0.47)
    rates = signal + generator.normal(0.0, 0.00045, size=121)
    levels = 100.0 * np.cumprod(1.0 + rates)
    fetched_at = "2020-02-10T00:00:00Z"
    rows: list[dict[str, object]] = []
    for index, observation_date in enumerate(observation_dates):
        signal_availability = observation_date + pd.offsets.MonthBegin(1) + pd.offsets.Day(4)
        rows.append(
            {
                "series_id": "LEADING_SIGNAL",
                "observation_date": observation_date.date().isoformat(),
                "value": signal[index],
                "source": "deterministic-test",
                "availability_date": signal_availability.date().isoformat(),
                "vintage_date": signal_availability.date().isoformat(),
                "fetched_at": fetched_at,
            }
        )
        if index < 120:
            target_availability = observation_date + pd.offsets.MonthBegin(1) + pd.offsets.Day(13)
            rows.append(
                {
                    "series_id": "CPI_TEST",
                    "observation_date": observation_date.date().isoformat(),
                    "value": levels[index],
                    "source": "deterministic-test",
                    "availability_date": target_availability.date().isoformat(),
                    "vintage_date": target_availability.date().isoformat(),
                    "fetched_at": fetched_at,
                }
            )
    return pd.DataFrame(rows)


def _pipeline_config(input_csv: str, output_directory: str) -> dict[str, object]:
    return {
        "inputCsv": input_csv,
        "outputDirectory": output_directory,
        "runAsOf": "2020-02-10T00:00:00Z",
        "target": {
            "seriesId": "CPI_TEST",
            "label": "Synthetic CPI MoM",
            "unit": "decimal-change",
            "targetDate": "2020-01-01",
            "availabilityDate": "2020-02-14",
            "horizonMonths": 1,
        },
        "features": {
            "momPeriods": [],
            "yoyPeriods": [],
            "rollingZWindows": [],
            "targetLagPeriods": [1],
            "cutoffInclusive": False,
        },
        "model": {
            "selectedModel": "ridge",
            "minTrainSize": 48,
            "testSize": 1,
            "stepSize": 1,
            "allowPartialTestWindow": True,
            "imputationStrategy": "median",
            "ridgeAlpha": 0.01,
            "lightgbmParams": {
                "n_estimators": 5,
                "learning_rate": 0.1,
                "min_child_samples": 4,
                "n_jobs": 1,
                "verbosity": -1,
                "random_state": 7,
            },
        },
        "distribution": {
            "drawCount": 10_000,
            "seed": 1729,
            "histogramBins": 40,
            "minimumResiduals": 36,
            "thresholds": [0.0, 0.003],
            "methodVersion": "1.0.0",
        },
        "requireBeatsNaive": True,
    }
