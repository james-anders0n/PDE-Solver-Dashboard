"""End-to-end economic forecast orchestration and immutable snapshot publishing."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from dataclasses import asdict
from pathlib import Path
from typing import cast

import pandas as pd

from macro_predictor.dashboard.contracts import SNAPSHOT_SCHEMA_VERSION, validate_snapshot
from macro_predictor.dashboard.distribution import DistributionSpec, build_forecast_distribution
from macro_predictor.features import FeatureSpec, build_feature_frame, build_forecast_feature_row
from macro_predictor.models import ModelResult, ModelSpec, evaluate_models, fit_final_forecast

INPUT_COLUMNS = (
    "series_id",
    "observation_date",
    "value",
    "source",
    "availability_date",
    "vintage_date",
    "fetched_at",
)
PIPELINE_VERSION = "economic-forecast-orchestrator.v1"


def run_pipeline(config_path: str | Path) -> dict[str, object]:
    """Run ingestion through immutable snapshot export from one JSON command config."""
    resolved_config_path = Path(config_path).resolve()
    config = _load_config(resolved_config_path)
    input_path = _resolve_path(resolved_config_path.parent, _string(config, "inputCsv"))
    output_directory = _resolve_path(
        resolved_config_path.parent,
        _string(config, "outputDirectory"),
    )
    run_as_of = _timestamp(config.get("runAsOf"), "runAsOf")
    input_bytes = input_path.read_bytes()
    ingested = pd.read_csv(input_path)
    validated, excluded_rows = validate_simulation_inputs(ingested, run_as_of)

    target_config = _mapping(config, "target")
    target_series_id = _string(target_config, "seriesId")
    target_date = _timestamp(target_config.get("targetDate"), "target.targetDate")
    target_availability = _timestamp(
        target_config.get("availabilityDate"),
        "target.availabilityDate",
    )
    feature_spec = _feature_spec(config, target_series_id)
    model_spec = _model_spec(config)
    distribution_spec = _distribution_spec(config)

    observation_frame = _to_model_observations(validated)
    feature_frame = build_feature_frame(observation_frame, feature_spec)
    model_results = evaluate_models(feature_frame, model_spec)
    selected = _select_model(config, model_results)
    forecast_row = build_forecast_feature_row(
        observation_frame,
        feature_spec,
        as_of_date=run_as_of.tz_localize(None),
        target_reference_date=target_date.tz_localize(None),
    )
    point_forecast = fit_final_forecast(
        selected.model_name,
        feature_frame,
        forecast_row,
        model_spec,
    )
    distribution = build_forecast_distribution(
        point_forecast,
        selected.predictions,
        distribution_spec,
    )

    input_sha256 = hashlib.sha256(input_bytes).hexdigest()
    run_id = _run_id(config, input_sha256, target_series_id, target_date)
    snapshot = _build_snapshot(
        config=config,
        run_id=run_id,
        run_as_of=run_as_of,
        validated_input=validated,
        excluded_rows=excluded_rows,
        target_config=target_config,
        target_date=target_date,
        target_availability=target_availability,
        feature_frame=feature_frame,
        feature_spec=feature_spec,
        model_spec=model_spec,
        selected=selected,
        point_forecast=point_forecast,
        distribution=distribution,
        input_path=input_path,
        input_sha256=input_sha256,
    )
    validate_snapshot(snapshot)
    _publish_snapshot(snapshot, output_directory)
    return snapshot


def validate_simulation_inputs(
    frame: pd.DataFrame,
    run_as_of: pd.Timestamp,
) -> tuple[pd.DataFrame, int]:
    """Validate explicit point-in-time date fields and exclude future vintages."""
    missing = [column for column in INPUT_COLUMNS if column not in frame.columns]
    if missing:
        msg = f"Simulation input missing columns: {', '.join(missing)}"
        raise ValueError(msg)
    if frame.empty:
        msg = "Simulation input contains no observations."
        raise ValueError(msg)
    normalized = frame.loc[:, INPUT_COLUMNS].copy()
    normalized["series_id"] = normalized["series_id"].astype("string")
    normalized["source"] = normalized["source"].astype("string")
    normalized["value"] = pd.to_numeric(normalized["value"], errors="raise")
    for column in ("observation_date", "availability_date", "vintage_date"):
        normalized[column] = pd.to_datetime(normalized[column], errors="raise")
    normalized["fetched_at"] = pd.to_datetime(normalized["fetched_at"], errors="raise", utc=True)
    if normalized[list(INPUT_COLUMNS)].isna().any().any():
        msg = "Simulation input contains missing required values."
        raise ValueError(msg)
    if not normalized["value"].map(math.isfinite).all():
        msg = "Simulation input contains non-finite values."
        raise ValueError(msg)
    if (normalized["observation_date"] > normalized["availability_date"]).any():
        msg = "Look-ahead rejected: observation_date is after availability_date."
        raise ValueError(msg)
    if (normalized["availability_date"] > normalized["vintage_date"]).any():
        msg = "Look-ahead rejected: availability_date is after vintage_date."
        raise ValueError(msg)
    fetched_dates = normalized["fetched_at"].dt.tz_convert(None).dt.normalize()
    if (normalized["vintage_date"].dt.normalize() > fetched_dates).any():
        msg = "Look-ahead rejected: vintage_date is after fetched_at."
        raise ValueError(msg)
    if normalized.duplicated(["series_id", "observation_date", "vintage_date"]).any():
        msg = "Simulation input contains duplicate series/observation/vintage rows."
        raise ValueError(msg)

    cutoff = run_as_of.tz_convert(None).normalize()
    eligible_mask = (normalized["availability_date"] <= cutoff) & (
        normalized["vintage_date"] <= cutoff
    )
    eligible = normalized.loc[eligible_mask].copy()
    if eligible.empty:
        msg = "No simulation inputs were available by runAsOf."
        raise ValueError(msg)
    return (
        eligible.sort_values(["series_id", "observation_date", "vintage_date"]).reset_index(
            drop=True
        ),
        int((~eligible_mask).sum()),
    )


def _build_snapshot(
    *,
    config: dict[str, object],
    run_id: str,
    run_as_of: pd.Timestamp,
    validated_input: pd.DataFrame,
    excluded_rows: int,
    target_config: dict[str, object],
    target_date: pd.Timestamp,
    target_availability: pd.Timestamp,
    feature_frame: pd.DataFrame,
    feature_spec: FeatureSpec,
    model_spec: ModelSpec,
    selected: ModelResult,
    point_forecast: float,
    distribution: dict[str, object],
    input_path: Path,
    input_sha256: str,
) -> dict[str, object]:
    latest_target_date = pd.Timestamp(feature_frame["target_reference_date"].max())
    target_date_naive = target_date.tz_localize(None)
    require_beats_naive = bool(config.get("requireBeatsNaive", True))
    point_checks = {
        "finite": math.isfinite(point_forecast),
        "targetAfterLatestObservation": target_date_naive > latest_target_date,
        "targetAvailableAfterRunAsOf": target_availability > run_as_of,
        "modelBeatsNaiveRmse": bool(selected.summary_metrics["beats_naive_rmse"]),
        "walkForwardOnly": True,
    }
    point_accepted = bool(
        point_checks["finite"]
        and point_checks["targetAfterLatestObservation"]
        and point_checks["targetAvailableAfterRunAsOf"]
        and point_checks["walkForwardOnly"]
        and (point_checks["modelBeatsNaiveRmse"] or not require_beats_naive)
    )
    distribution_accepted = bool(distribution["accepted"])
    accepted = point_accepted and distribution_accepted
    warnings = list(cast(list[str], distribution["warnings"]))
    if not point_accepted:
        warnings.append("Point forecast did not pass every configured acceptance check.")

    metrics = dict(selected.summary_metrics)
    snapshot: dict[str, object] = {
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "pipelineVersion": PIPELINE_VERSION,
        "runId": run_id,
        "status": "accepted" if accepted else "rejected",
        "generatedAt": run_as_of.isoformat().replace("+00:00", "Z"),
        "target": {
            "seriesId": _string(target_config, "seriesId"),
            "label": str(target_config.get("label", _string(target_config, "seriesId"))),
            "unit": str(target_config.get("unit", "decimal-change")),
            "targetDate": target_date.date().isoformat(),
            "availabilityDate": target_availability.date().isoformat(),
            "horizonMonths": int(target_config.get("horizonMonths", 1)),
        },
        "pointForecast": {
            "value": point_forecast,
            "accepted": point_accepted,
            "checks": point_checks,
        },
        "distribution": distribution,
        "model": {
            "name": selected.model_name,
            "trainedThroughObservationDate": latest_target_date.date().isoformat(),
            "trainingRows": len(feature_frame),
            "oosPredictionRows": len(selected.predictions),
            "featureSetVersion": "point-in-time-v1",
            "featureSpec": asdict(feature_spec),
            "modelSpec": asdict(model_spec),
        },
        "metrics": metrics,
        "backtest": {
            "history": _prediction_history(selected.predictions),
            "folds": _fold_history(selected.fold_results),
            "intervalCoverage": distribution["coverage"],
            "naiveComparison": str(selected.summary_metrics["naive_comparison"]),
        },
        "provenance": {
            "runAsOf": run_as_of.isoformat().replace("+00:00", "Z"),
            "inputFile": input_path.name,
            "inputSha256": input_sha256,
            "inputRows": len(validated_input),
            "inputRowsExcludedAfterRunAsOf": excluded_rows,
            "sourceSeries": sorted(str(item) for item in validated_input["series_id"].unique()),
            "observationDateRange": _date_range(validated_input["observation_date"]),
            "availabilityDateRange": _date_range(validated_input["availability_date"]),
            "vintageDateRange": _date_range(validated_input["vintage_date"]),
            "fetchedAtRange": _datetime_range(validated_input["fetched_at"]),
            "dateFields": [
                "observationDate",
                "availabilityDate",
                "targetDate",
                "vintageDate",
            ],
            "lookAheadChecked": True,
        },
        "acceptance": {
            "accepted": accepted,
            "pointForecastAccepted": point_accepted,
            "distributionAccepted": distribution_accepted,
            "latestUpdated": accepted,
            "warnings": warnings,
        },
    }
    return snapshot


def _publish_snapshot(snapshot: dict[str, object], output_directory: Path) -> None:
    runs_directory = output_directory / "runs"
    runs_directory.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(snapshot, indent=2, sort_keys=True, allow_nan=False) + "\n"
    run_path = runs_directory / f"{snapshot['runId']}.json"
    if run_path.exists():
        if run_path.read_text(encoding="utf-8") != payload:
            msg = f"Immutable runId collision: {snapshot['runId']}"
            raise FileExistsError(msg)
    else:
        _atomic_write(run_path, payload)
    acceptance = _mapping(snapshot, "acceptance")
    if bool(acceptance["accepted"]):
        _atomic_write(output_directory / "latest.json", payload)


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(payload, encoding="utf-8")
    os.replace(temporary, path)


def _load_config(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        msg = "Pipeline config must be a JSON object."
        raise ValueError(msg)
    return cast(dict[str, object], payload)


def _feature_spec(config: dict[str, object], target_series_id: str) -> FeatureSpec:
    item = cast(dict[str, object], config.get("features", {}))
    return FeatureSpec(
        target_series_id=target_series_id,
        mom_periods=_int_tuple(item.get("momPeriods", [1])),
        yoy_periods=_int_tuple(item.get("yoyPeriods", [12])),
        rolling_z_windows=_int_tuple(item.get("rollingZWindows", [12, 24])),
        target_lag_periods=_int_tuple(item.get("targetLagPeriods", [1])),
        pmi_series_ids=_string_tuple(item.get("pmiSeriesIds", [])),
        yield_curve_long_series_id=_optional_string(item.get("yieldCurveLongSeriesId")),
        yield_curve_short_series_id=_optional_string(item.get("yieldCurveShortSeriesId")),
        fed_funds_series_id=_optional_string(item.get("fedFundsSeriesId")),
        inflation_level_series_id=_optional_string(item.get("inflationLevelSeriesId")),
        inflation_rate_scale=float(item.get("inflationRateScale", 100.0)),
        cutoff_inclusive=bool(item.get("cutoffInclusive", False)),
    )


def _model_spec(config: dict[str, object]) -> ModelSpec:
    item = _mapping(config, "model")
    return ModelSpec(
        min_train_size=int(item["minTrainSize"]),
        test_size=int(item["testSize"]),
        step_size=int(item["stepSize"]),
        allow_partial_test_window=bool(item.get("allowPartialTestWindow", True)),
        imputation_strategy=str(item.get("imputationStrategy", "median")),
        ridge_alpha=float(item.get("ridgeAlpha", 1.0)),
        lightgbm_params=cast(dict[str, object], item.get("lightgbmParams", {})),
    )


def _distribution_spec(config: dict[str, object]) -> DistributionSpec:
    item = _mapping(config, "distribution")
    return DistributionSpec(
        seed=int(item["seed"]),
        thresholds=tuple(float(value) for value in cast(list[object], item.get("thresholds", []))),
        draw_count=int(item.get("drawCount", 10_000)),
        histogram_bins=int(item.get("histogramBins", 40)),
        minimum_residuals=int(item.get("minimumResiduals", 36)),
        method_version=str(item.get("methodVersion", "1.0.0")),
    )


def _select_model(
    config: dict[str, object],
    results: dict[str, ModelResult],
) -> ModelResult:
    model_config = _mapping(config, "model")
    selected_name = str(model_config.get("selectedModel", "auto"))
    if selected_name != "auto":
        if selected_name not in results:
            msg = f"Selected model is unavailable: {selected_name}"
            raise ValueError(msg)
        return results[selected_name]
    eligible = [
        result for result in results.values() if bool(result.summary_metrics["beats_naive_rmse"])
    ]
    candidates = eligible or list(results.values())
    return min(candidates, key=lambda result: float(result.summary_metrics["rmse"]))


def _to_model_observations(frame: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "series_id": frame["series_id"],
            "date": frame["observation_date"],
            "value": frame["value"],
            "source": frame["source"],
            "release_date": frame["availability_date"],
            "fetched_at": frame["fetched_at"],
            "vintage_date": frame["vintage_date"],
        }
    )


def _run_id(
    config: dict[str, object],
    input_sha256: str,
    target_series_id: str,
    target_date: pd.Timestamp,
) -> str:
    identity = {
        "pipelineVersion": PIPELINE_VERSION,
        "inputSha256": input_sha256,
        "runAsOf": config.get("runAsOf"),
        "target": config.get("target"),
        "features": config.get("features", {}),
        "model": config.get("model"),
        "distribution": config.get("distribution"),
        "requireBeatsNaive": config.get("requireBeatsNaive", True),
    }
    digest = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]
    slug = re.sub(r"[^a-z0-9]+", "-", target_series_id.lower()).strip("-")
    return f"{slug}-{target_date.date().isoformat()}-{digest}"


def _mapping(container: dict[str, object], key: str) -> dict[str, object]:
    value = container.get(key)
    if not isinstance(value, dict):
        msg = f"{key} must be a JSON object."
        raise ValueError(msg)
    return cast(dict[str, object], value)


def _string(container: dict[str, object], key: str) -> str:
    value = container.get(key)
    if not isinstance(value, str) or not value.strip():
        msg = f"{key} must be a non-empty string."
        raise ValueError(msg)
    return value


def _timestamp(value: object, label: str) -> pd.Timestamp:
    if not isinstance(value, str) or not value.strip():
        msg = f"{label} must be an ISO timestamp."
        raise ValueError(msg)
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp


def _resolve_path(base: Path, value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (base / path).resolve()


def _int_tuple(value: object) -> tuple[int, ...]:
    return tuple(int(item) for item in cast(list[object], value))


def _string_tuple(value: object) -> tuple[str, ...]:
    return tuple(str(item) for item in cast(list[object], value))


def _optional_string(value: object) -> str | None:
    return str(value) if value not in (None, "") else None


def _date_range(series: pd.Series) -> dict[str, str]:
    return {
        "start": pd.Timestamp(series.min()).date().isoformat(),
        "end": pd.Timestamp(series.max()).date().isoformat(),
    }


def _datetime_range(series: pd.Series) -> dict[str, str]:
    return {
        "start": pd.Timestamp(series.min()).isoformat().replace("+00:00", "Z"),
        "end": pd.Timestamp(series.max()).isoformat().replace("+00:00", "Z"),
    }


def _prediction_history(frame: pd.DataFrame) -> list[dict[str, object]]:
    ordered = frame.sort_values(["as_of_date", "target_reference_date"])
    return [
        {
            "foldId": int(row.fold_id),
            "targetDate": pd.Timestamp(row.target_reference_date).date().isoformat(),
            "availabilityDate": pd.Timestamp(row.as_of_date).date().isoformat(),
            "actual": float(row.actual),
            "prediction": float(row.prediction),
            "naivePrediction": float(row.naive_prediction),
        }
        for row in ordered.itertuples(index=False)
    ]


def _fold_history(frame: pd.DataFrame) -> list[dict[str, object]]:
    return [
        {
            "foldId": int(row.fold_id),
            "trainStart": pd.Timestamp(row.train_start).date().isoformat(),
            "trainEnd": pd.Timestamp(row.train_end).date().isoformat(),
            "testStart": pd.Timestamp(row.test_start).date().isoformat(),
            "testEnd": pd.Timestamp(row.test_end).date().isoformat(),
            "observations": int(row.observations),
            "rmse": float(row.rmse),
            "mae": float(row.mae),
            "directionalAccuracy": float(row.directional_accuracy),
            "hitRateVsNaive": float(row.hit_rate_vs_naive),
            "modelBeatsNaiveRmse": bool(row.model_beats_naive_rmse),
        }
        for row in frame.sort_values("fold_id").itertuples(index=False)
    ]
