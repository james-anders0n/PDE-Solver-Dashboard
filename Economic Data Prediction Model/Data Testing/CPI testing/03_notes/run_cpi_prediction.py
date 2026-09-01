"""Run sandbox CPI predictions using the copied model code.

This runner lives outside the original project code and writes outputs only under
Data Testing/CPI testing. It uses the copied model package in ./model/src.
"""

from __future__ import annotations

import sys
from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parents[1]
MODEL_SRC = BASE_DIR / "model" / "src"
PROCESSED_DIR = BASE_DIR / "02_processed"
PREDICTION_DIR = BASE_DIR / "04_predictions"
REPORT_DIR = BASE_DIR / "05_reports"

sys.path.insert(0, str(MODEL_SRC))

from macro_predictor.models import ModelSpec, evaluate_models, feature_column_names  # noqa: E402
from macro_predictor.models.validation import _lightgbm_pipeline, _ridge_pipeline  # noqa: E402
from macro_predictor.reporting import ReportSpec, save_baseline_report  # noqa: E402


def load_cpi_metrics() -> pd.DataFrame:
    """Load CPI metrics produced by the FRED testing data pull."""
    path = PROCESSED_DIR / "cpi_inflation_metrics.csv"
    frame = pd.read_csv(path, parse_dates=["date"])
    for column in ("index_value", "mom_inflation_pct", "yoy_inflation_pct"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame.sort_values(["series_id", "date"]).reset_index(drop=True)


def build_training_features(metrics: pd.DataFrame) -> pd.DataFrame:
    """Build leakage-safe CPI features for historical walk-forward prediction."""
    wide = _wide_cpi_frame(metrics)
    feature_frame = pd.DataFrame(
        {
            "as_of_date": wide.index,
            "target_reference_date": wide.index,
            "target_mom": wide["headline_mom_decimal"],
        }
    )
    _add_lag_features(
        feature_frame,
        wide,
        source_column="headline_mom_decimal",
        prefix="headline_mom",
    )
    _add_lag_features(feature_frame, wide, source_column="core_mom_decimal", prefix="core_mom")
    _add_lag_features(
        feature_frame,
        wide,
        source_column="headline_yoy_decimal",
        prefix="headline_yoy",
    )
    _add_lag_features(feature_frame, wide, source_column="core_yoy_decimal", prefix="core_yoy")
    _add_lag_features(feature_frame, wide, source_column="headline_index", prefix="headline_index")
    _add_lag_features(feature_frame, wide, source_column="core_index", prefix="core_index")

    lagged_spread = wide["core_mom_decimal"] - wide["headline_mom_decimal"]
    feature_frame["core_minus_headline_mom_lag_1"] = lagged_spread.shift(1).to_numpy()

    for window in (3, 6, 12):
        feature_frame[f"headline_mom_rolling_mean_{window}"] = (
            wide["headline_mom_decimal"].shift(1).rolling(window).mean().to_numpy()
        )
        feature_frame[f"headline_mom_rolling_std_{window}"] = (
            wide["headline_mom_decimal"].shift(1).rolling(window).std().to_numpy()
        )
        feature_frame[f"core_mom_rolling_mean_{window}"] = (
            wide["core_mom_decimal"].shift(1).rolling(window).mean().to_numpy()
        )
        feature_frame[f"core_mom_rolling_std_{window}"] = (
            wide["core_mom_decimal"].shift(1).rolling(window).std().to_numpy()
        )

    return feature_frame.dropna(subset=["target_mom"]).reset_index(drop=True)


def build_next_feature_row(feature_frame: pd.DataFrame) -> pd.DataFrame:
    """Build the next-month feature row from the latest lagged feature state."""
    latest = feature_frame.sort_values("as_of_date").iloc[-1:].copy()
    next_reference_date = pd.Timestamp(latest["target_reference_date"].iloc[0]) + (
        pd.offsets.MonthBegin(1)
    )
    next_row = latest.copy()
    next_row["as_of_date"] = next_reference_date
    next_row["target_reference_date"] = next_reference_date
    next_row["target_mom"] = 0.0
    return next_row


def _wide_cpi_frame(metrics: pd.DataFrame) -> pd.DataFrame:
    headline = _series(metrics, "CPIAUCSL", "headline")
    core = _series(metrics, "CPILFESL", "core")
    return headline.join(core, how="outer").sort_index()


def _series(metrics: pd.DataFrame, series_id: str, prefix: str) -> pd.DataFrame:
    frame = metrics.loc[metrics["series_id"] == series_id].copy()
    return (
        frame.set_index("date")
        .rename(
            columns={
                "index_value": f"{prefix}_index",
                "mom_inflation_pct": f"{prefix}_mom_pct",
                "yoy_inflation_pct": f"{prefix}_yoy_pct",
            }
        )[[f"{prefix}_index", f"{prefix}_mom_pct", f"{prefix}_yoy_pct"]]
        .assign(
            **{
                f"{prefix}_mom_decimal": lambda item: item[f"{prefix}_mom_pct"] / 100.0,
                f"{prefix}_yoy_decimal": lambda item: item[f"{prefix}_yoy_pct"] / 100.0,
            }
        )
    )


def _add_lag_features(
    feature_frame: pd.DataFrame,
    wide: pd.DataFrame,
    source_column: str,
    prefix: str,
) -> None:
    for lag in (1, 2, 3, 6, 12):
        feature_frame[f"{prefix}_lag_{lag}"] = wide[source_column].shift(lag).to_numpy()


def observation_frame(metrics: pd.DataFrame) -> pd.DataFrame:
    """Build a minimal observation frame for Stage 5 report generation."""
    fetched_at = datetime.now(UTC)
    rows = []
    for row in metrics.itertuples(index=False):
        rows.append(
            {
                "series_id": row.series_id,
                "date": row.date,
                "value": row.index_value,
                "source": "fred_public_csv_cpi_testing",
                "release_date": row.date,
                "fetched_at": fetched_at,
            }
        )
    return pd.DataFrame(rows)


def save_outputs(
    metrics: pd.DataFrame,
    feature_frame: pd.DataFrame,
    results: dict[str, object],
    next_forecasts: pd.DataFrame,
    spec: ModelSpec,
) -> None:
    """Write prediction CSVs and the Stage 5 baseline report."""
    PREDICTION_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    historical = pd.concat(
        [result.predictions.assign(model_name=name) for name, result in results.items()],
        ignore_index=True,
    )
    historical["actual_mom_pct"] = historical["actual"] * 100.0
    historical["predicted_mom_pct"] = historical["prediction"] * 100.0
    historical["naive_predicted_mom_pct"] = historical["naive_prediction"] * 100.0
    historical.to_csv(PREDICTION_DIR / "historical_cpi_predictions.csv", index=False)

    next_forecasts.to_csv(PREDICTION_DIR / "next_cpi_forecast.csv", index=False)

    save_baseline_report(
        observation_frame=observation_frame(metrics),
        feature_frame=feature_frame,
        model_results=results,
        model_spec=spec,
        report_spec=ReportSpec(
            output_dir=REPORT_DIR,
            plot_width=960,
            plot_height=420,
            plot_padding=48,
        ),
        run_date=date.today(),
    )


def next_forecast_table(
    feature_frame: pd.DataFrame,
    metrics: pd.DataFrame,
    spec: ModelSpec,
) -> pd.DataFrame:
    """Fit each model on all history and forecast the next CPI MoM value."""
    prepared = feature_frame.dropna(subset=["target_mom"]).reset_index(drop=True)
    feature_columns = feature_column_names(prepared)
    next_row = build_next_feature_row(prepared)
    latest_headline = (
        metrics.loc[metrics["series_id"] == "CPIAUCSL"].sort_values("date").iloc[-1]
    )
    latest_index = float(latest_headline["index_value"])
    latest_date = pd.Timestamp(latest_headline["date"])
    forecast_date = latest_date + pd.offsets.MonthBegin(1)

    rows = []
    for model_name, estimator in {
        "ridge": _ridge_pipeline(spec),
        "lightgbm": _lightgbm_pipeline(spec),
    }.items():
        estimator.fit(prepared[feature_columns], prepared["target_mom"])
        predicted_mom_decimal = float(estimator.predict(next_row[feature_columns])[0])
        rows.append(
            {
                "model_name": model_name,
                "forecast_reference_date": forecast_date.date().isoformat(),
                "latest_actual_cpi_date": latest_date.date().isoformat(),
                "latest_actual_cpi_index": latest_index,
                "predicted_mom_decimal": predicted_mom_decimal,
                "predicted_mom_pct": predicted_mom_decimal * 100.0,
                "implied_predicted_cpi_index": latest_index * (1.0 + predicted_mom_decimal),
            }
        )
    return pd.DataFrame(rows)


def main() -> None:
    """Run historical predictions and next-month CPI forecast."""
    metrics = load_cpi_metrics()
    feature_frame = build_training_features(metrics)
    spec = ModelSpec(
        min_train_size=120,
        test_size=12,
        step_size=12,
        allow_partial_test_window=True,
        imputation_strategy="median",
        ridge_alpha=1.0,
        lightgbm_params={
            "n_estimators": 150,
            "learning_rate": 0.03,
            "min_child_samples": 12,
            "n_jobs": 1,
            "verbosity": -1,
            "random_state": 7,
        },
    )
    results = evaluate_models(feature_frame, spec)
    forecasts = next_forecast_table(feature_frame, metrics, spec)
    save_outputs(metrics, feature_frame, results, forecasts, spec)
    print(forecasts.to_string(index=False))


if __name__ == "__main__":
    main()
