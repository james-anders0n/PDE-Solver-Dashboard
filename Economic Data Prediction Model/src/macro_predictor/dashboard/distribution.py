"""Deterministic forecast distributions from walk-forward out-of-sample errors."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np
import pandas as pd

METHOD = "walk-forward-signed-residual-bootstrap"
METHOD_VERSION = "1.0.0"
DEFAULT_DRAW_COUNT = 10_000
DEFAULT_MINIMUM_RESIDUALS = 36
QUANTILE_LEVELS = (0.10, 0.25, 0.50, 0.75, 0.90)
COVERAGE_LEVELS = (0.50, 0.80, 0.90)


@dataclass(frozen=True)
class DistributionSpec:
    """Reproducible signed-residual bootstrap configuration."""

    seed: int
    thresholds: tuple[float, ...]
    draw_count: int = DEFAULT_DRAW_COUNT
    histogram_bins: int = 40
    minimum_residuals: int = DEFAULT_MINIMUM_RESIDUALS
    method_version: str = METHOD_VERSION


def audit_oos_predictions(prediction_frame: pd.DataFrame) -> pd.DataFrame:
    """Validate that every residual comes from a forward-only OOS prediction."""
    required = {
        "actual",
        "prediction",
        "as_of_date",
        "target_reference_date",
        "train_end",
        "test_start",
    }
    missing = required.difference(prediction_frame.columns)
    if missing:
        msg = f"OOS prediction frame missing columns: {', '.join(sorted(missing))}"
        raise ValueError(msg)
    if prediction_frame.empty:
        msg = "OOS prediction frame contains no rows."
        raise ValueError(msg)

    audited = prediction_frame.copy()
    for column in ("as_of_date", "target_reference_date", "train_end", "test_start"):
        audited[column] = pd.to_datetime(audited[column], errors="raise")
    for column in ("actual", "prediction"):
        audited[column] = pd.to_numeric(audited[column], errors="raise")
    if audited[list(required)].isna().any().any():
        msg = "OOS prediction frame contains missing required values."
        raise ValueError(msg)
    numeric = audited[["actual", "prediction"]].to_numpy(dtype=float)
    if not np.isfinite(numeric).all():
        msg = "OOS prediction frame contains non-finite values."
        raise ValueError(msg)
    if (audited["train_end"] >= audited["test_start"]).any():
        msg = "Look-ahead rejected: a training window overlaps its test window."
        raise ValueError(msg)
    if (audited["target_reference_date"] > audited["as_of_date"]).any():
        msg = "Look-ahead rejected: a target was observed after its forecast availability date."
        raise ValueError(msg)
    if audited["target_reference_date"].duplicated().any():
        msg = "OOS prediction frame contains duplicate target dates."
        raise ValueError(msg)
    audited["residual"] = audited["actual"] - audited["prediction"]
    return audited.sort_values(["as_of_date", "target_reference_date"]).reset_index(drop=True)


def calculate_interval_coverage(
    prediction_frame: pd.DataFrame,
    minimum_history: int = DEFAULT_MINIMUM_RESIDUALS,
) -> list[dict[str, object]]:
    """Backtest central intervals using only residuals available before each prediction."""
    audited = audit_oos_predictions(prediction_frame)
    residuals = audited["residual"].to_numpy(dtype=float)
    actual = audited["actual"].to_numpy(dtype=float)
    predicted = audited["prediction"].to_numpy(dtype=float)
    rows: list[dict[str, object]] = []

    for level in COVERAGE_LEVELS:
        hits: list[bool] = []
        widths: list[float] = []
        tail = (1.0 - level) / 2.0
        for index in range(minimum_history, len(audited)):
            prior = residuals[:index]
            lower_error, upper_error = np.quantile(prior, [tail, 1.0 - tail])
            lower = predicted[index] + float(lower_error)
            upper = predicted[index] + float(upper_error)
            hits.append(lower <= actual[index] <= upper)
            widths.append(upper - lower)
        sample_size = len(hits)
        observed = float(np.mean(hits)) if hits else None
        average_width = float(np.mean(widths)) if widths else None
        tolerance = (
            max(0.05, 1.96 * float(np.sqrt(level * (1.0 - level) / sample_size)))
            if sample_size
            else None
        )
        accepted = bool(
            observed is not None and tolerance is not None and abs(observed - level) <= tolerance
        )
        rows.append(
            {
                "nominal": level,
                "observed": observed,
                "averageIntervalWidth": average_width,
                "sampleSize": sample_size,
                "acceptanceTolerance": tolerance,
                "accepted": accepted,
            }
        )
    return rows


def build_forecast_distribution(
    point_forecast: float,
    prediction_frame: pd.DataFrame,
    spec: DistributionSpec,
) -> dict[str, object]:
    """Bootstrap signed OOS residuals and return a compact distribution snapshot."""
    if spec.draw_count != DEFAULT_DRAW_COUNT:
        msg = f"Phase 2 distributions require exactly {DEFAULT_DRAW_COUNT} draws."
        raise ValueError(msg)
    if spec.histogram_bins <= 0:
        msg = "Histogram bin count must be positive."
        raise ValueError(msg)
    if not np.isfinite(point_forecast):
        msg = "Point forecast must be finite."
        raise ValueError(msg)

    audited = audit_oos_predictions(prediction_frame)
    residuals = audited["residual"].to_numpy(dtype=np.float64)
    rng = np.random.default_rng(spec.seed)
    sampled_errors = rng.choice(residuals, size=spec.draw_count, replace=True)
    draws = np.asarray(point_forecast + sampled_errors, dtype=np.float64)
    counts, edges = np.histogram(draws, bins=spec.histogram_bins)
    quantile_values = np.quantile(draws, QUANTILE_LEVELS)
    quantiles = {
        name: float(value)
        for name, value in zip(("p10", "p25", "p50", "p75", "p90"), quantile_values, strict=True)
    }
    coverage = calculate_interval_coverage(audited, minimum_history=spec.minimum_residuals)
    preliminary = len(residuals) < spec.minimum_residuals
    histogram = [
        {"lower": float(edges[index]), "upper": float(edges[index + 1]), "count": int(count)}
        for index, count in enumerate(counts)
    ]
    threshold_probabilities = [
        {
            "threshold": float(threshold),
            "probabilityAbove": float(np.mean(draws > threshold)),
            "probabilityBelow": float(np.mean(draws < threshold)),
        }
        for threshold in spec.thresholds
    ]
    ordered = list(quantiles.values()) == sorted(quantiles.values())
    accepted = bool(
        not preliminary
        and ordered
        and sum(item["count"] for item in histogram) == spec.draw_count
        and all(item["accepted"] for item in coverage)
    )
    warnings = []
    if preliminary:
        warnings.append(
            f"Preliminary: {len(residuals)} eligible OOS residuals; at least "
            f"{spec.minimum_residuals} are required."
        )
    if not all(item["accepted"] for item in coverage):
        warnings.append("Historical interval coverage did not pass every calibration check.")

    return {
        "method": METHOD,
        "methodVersion": spec.method_version,
        "drawCount": spec.draw_count,
        "seed": spec.seed,
        "drawDigestSha256": hashlib.sha256(draws.tobytes()).hexdigest(),
        "residualSource": "expanding-window-out-of-sample-predictions-only",
        "residualSampleSize": int(len(residuals)),
        "residualDateRange": {
            "start": audited["target_reference_date"].min().date().isoformat(),
            "end": audited["target_reference_date"].max().date().isoformat(),
        },
        "mean": float(np.mean(draws)),
        "standardDeviation": float(np.std(draws, ddof=0)),
        "quantiles": quantiles,
        "thresholdProbabilities": threshold_probabilities,
        "histogram": histogram,
        "coverage": coverage,
        "preliminary": preliminary,
        "accepted": accepted,
        "warnings": warnings,
    }
