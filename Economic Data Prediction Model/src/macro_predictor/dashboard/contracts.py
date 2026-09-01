"""Validation for the dashboard snapshot boundary."""

from __future__ import annotations

import math
from typing import cast

SNAPSHOT_SCHEMA_VERSION = "economic-forecast-snapshot.v2"


def validate_snapshot(snapshot: dict[str, object]) -> dict[str, object]:
    """Fail closed when a generated snapshot violates the Phase 2 contract."""
    required = {
        "schemaVersion",
        "runId",
        "status",
        "target",
        "pointForecast",
        "distribution",
        "model",
        "metrics",
        "backtest",
        "provenance",
        "acceptance",
    }
    missing = required.difference(snapshot)
    if missing:
        msg = f"Snapshot missing fields: {', '.join(sorted(missing))}"
        raise ValueError(msg)
    if snapshot["schemaVersion"] != SNAPSHOT_SCHEMA_VERSION:
        msg = "Snapshot schema version is not supported."
        raise ValueError(msg)
    distribution = _object(snapshot["distribution"], "distribution")
    if distribution.get("drawCount") != 10_000:
        msg = "Snapshot must record exactly 10,000 Python-generated draws."
        raise ValueError(msg)
    histogram = cast(list[object], distribution.get("histogram"))
    if not isinstance(histogram, list) or not histogram:
        msg = "Snapshot histogram must contain compact bins."
        raise ValueError(msg)
    if sum(int(_object(item, "histogram item")["count"]) for item in histogram) != 10_000:
        msg = "Snapshot histogram counts do not sum to the draw count."
        raise ValueError(msg)
    quantiles = _object(distribution.get("quantiles"), "distribution.quantiles")
    ordered = [float(quantiles[name]) for name in ("p10", "p25", "p50", "p75", "p90")]
    if any(not math.isfinite(value) for value in ordered) or ordered != sorted(ordered):
        msg = "Snapshot quantiles must be finite and ordered."
        raise ValueError(msg)
    if distribution.get("residualSource") != "expanding-window-out-of-sample-predictions-only":
        msg = "Snapshot distribution must be derived only from OOS residuals."
        raise ValueError(msg)
    if not isinstance(distribution.get("seed"), int):
        msg = "Snapshot distribution must record its integer seed."
        raise ValueError(msg)
    residual_count = distribution.get("residualSampleSize")
    if not isinstance(residual_count, int) or residual_count <= 0:
        msg = "Snapshot distribution must record a positive OOS residual sample size."
        raise ValueError(msg)
    coverage = cast(list[object], distribution.get("coverage"))
    if not isinstance(coverage, list) or [
        float(_object(item, "coverage item")["nominal"]) for item in coverage
    ] != [0.5, 0.8, 0.9]:
        msg = "Snapshot must report 50%, 80%, and 90% interval coverage."
        raise ValueError(msg)
    target = _object(snapshot["target"], "target")
    if not isinstance(target.get("targetDate"), str):
        msg = "Snapshot target must record its targetDate separately."
        raise ValueError(msg)
    provenance = _object(snapshot["provenance"], "provenance")
    date_fields = cast(list[object], provenance.get("dateFields"))
    if date_fields != ["observationDate", "availabilityDate", "targetDate", "vintageDate"]:
        msg = "Snapshot must keep observation, availability, target, and vintage dates distinct."
        raise ValueError(msg)
    acceptance = _object(snapshot["acceptance"], "acceptance")
    accepted = bool(acceptance.get("accepted"))
    expected_status = "accepted" if accepted else "rejected"
    if snapshot["status"] != expected_status:
        msg = "Snapshot status disagrees with its acceptance checks."
        raise ValueError(msg)
    point_forecast = _object(snapshot["pointForecast"], "pointForecast")
    if accepted and (
        not bool(point_forecast.get("accepted"))
        or not bool(distribution.get("accepted"))
        or bool(distribution.get("preliminary"))
        or residual_count < 36
        or not all(bool(_object(item, "coverage item").get("accepted")) for item in coverage)
    ):
        msg = "An accepted snapshot must pass point, residual-count, and calibration gates."
        raise ValueError(msg)
    return snapshot


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        msg = f"{label} must be an object."
        raise ValueError(msg)
    return cast(dict[str, object], value)
