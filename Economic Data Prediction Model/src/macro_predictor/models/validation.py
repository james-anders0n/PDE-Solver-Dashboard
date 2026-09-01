"""Expanding-window model validation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from macro_predictor.config import Settings, get_settings
from macro_predictor.features.point_in_time import (
    AS_OF_DATE_COLUMN,
    TARGET_REFERENCE_DATE_COLUMN,
    TARGET_VALUE_COLUMN,
    validate_feature_frame,
)


class RegressorFactory(Protocol):
    """Factory protocol for fold-local estimators."""

    def __call__(self) -> object:
        """Return a new unfitted estimator."""


@dataclass(frozen=True)
class ModelSpec:
    """Resolved model and walk-forward validation settings."""

    min_train_size: int
    test_size: int
    step_size: int
    allow_partial_test_window: bool
    imputation_strategy: str
    ridge_alpha: float
    lightgbm_params: dict[str, object]


@dataclass(frozen=True)
class FoldResult:
    """Prediction output for one walk-forward fold."""

    model_name: str
    fold_id: int
    train_start: pd.Timestamp
    train_end: pd.Timestamp
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    observations: int
    rmse: float
    mae: float
    directional_accuracy: float
    hit_rate_vs_naive: float
    model_beats_naive_rmse: bool


@dataclass(frozen=True)
class ModelResult:
    """Out-of-sample validation result for one model."""

    model_name: str
    fold_results: pd.DataFrame
    predictions: pd.DataFrame
    summary_metrics: dict[str, float | bool | str]


def spec_from_settings(settings: Settings | None = None) -> ModelSpec:
    """Build a model validation specification from runtime settings."""
    resolved = settings or get_settings()
    missing = [
        name
        for name, value in {
            "MODEL_MIN_TRAIN_SIZE": resolved.model_min_train_size,
            "MODEL_TEST_SIZE": resolved.model_test_size,
            "MODEL_STEP_SIZE": resolved.model_step_size,
            "MODEL_ALLOW_PARTIAL_TEST_WINDOW": resolved.model_allow_partial_test_window,
            "MODEL_IMPUTATION_STRATEGY": resolved.model_imputation_strategy,
            "RIDGE_ALPHA": resolved.ridge_alpha,
            "LIGHTGBM_PARAMS_JSON": resolved.lightgbm_params,
        }.items()
        if value is None
    ]
    if missing:
        msg = f"Missing required model config: {', '.join(missing)}"
        raise ValueError(msg)
    return ModelSpec(
        min_train_size=_positive_int(resolved.model_min_train_size, "MODEL_MIN_TRAIN_SIZE"),
        test_size=_positive_int(resolved.model_test_size, "MODEL_TEST_SIZE"),
        step_size=_positive_int(resolved.model_step_size, "MODEL_STEP_SIZE"),
        allow_partial_test_window=bool(resolved.model_allow_partial_test_window),
        imputation_strategy=str(resolved.model_imputation_strategy),
        ridge_alpha=_positive_float(resolved.ridge_alpha, "RIDGE_ALPHA"),
        lightgbm_params=dict(resolved.lightgbm_params or {}),
    )


def evaluate_models(feature_frame: pd.DataFrame, spec: ModelSpec) -> dict[str, ModelResult]:
    """Evaluate Ridge and LightGBM with expanding-window walk-forward validation."""
    prepared_frame = _prepare_feature_frame(feature_frame)
    feature_columns = feature_column_names(prepared_frame)
    folds = expanding_window_splits(
        row_count=len(prepared_frame),
        min_train_size=spec.min_train_size,
        test_size=spec.test_size,
        step_size=spec.step_size,
        allow_partial_test_window=spec.allow_partial_test_window,
    )
    return {
        "ridge": evaluate_single_model(
            model_name="ridge",
            feature_frame=prepared_frame,
            feature_columns=feature_columns,
            spec=spec,
            folds=folds,
            estimator_factory=lambda: _ridge_pipeline(spec),
        ),
        "lightgbm": evaluate_single_model(
            model_name="lightgbm",
            feature_frame=prepared_frame,
            feature_columns=feature_columns,
            spec=spec,
            folds=folds,
            estimator_factory=lambda: _lightgbm_pipeline(spec),
        ),
    }


def evaluate_single_model(
    model_name: str,
    feature_frame: pd.DataFrame,
    feature_columns: list[str],
    spec: ModelSpec,
    folds: list[tuple[np.ndarray, np.ndarray]],
    estimator_factory: RegressorFactory,
) -> ModelResult:
    """Evaluate one estimator over explicit expanding-window folds."""
    del spec
    predictions = [
        _fit_predict_fold(
            model_name,
            feature_frame,
            feature_columns,
            fold_id,
            split,
            estimator_factory,
        )
        for fold_id, split in enumerate(folds)
    ]
    prediction_frame = pd.concat(predictions, ignore_index=True)
    fold_frame = _fold_results(prediction_frame)
    summary = summary_metrics(prediction_frame)
    return ModelResult(
        model_name=model_name,
        fold_results=fold_frame,
        predictions=prediction_frame,
        summary_metrics=summary,
    )


def expanding_window_splits(
    row_count: int,
    min_train_size: int,
    test_size: int,
    step_size: int,
    allow_partial_test_window: bool,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Return expanding-window train/test index splits."""
    _validate_positive_window_config(min_train_size, test_size, step_size)
    splits: list[tuple[np.ndarray, np.ndarray]] = []
    train_end = min_train_size
    while train_end < row_count:
        test_end = train_end + test_size
        if test_end > row_count and not allow_partial_test_window:
            break
        bounded_test_end = min(test_end, row_count)
        if bounded_test_end <= train_end:
            break
        splits.append((np.arange(train_end), np.arange(train_end, bounded_test_end)))
        train_end += step_size
    if not splits:
        msg = "No walk-forward folds could be created with the configured window sizes."
        raise ValueError(msg)
    return splits


def feature_column_names(feature_frame: pd.DataFrame) -> list[str]:
    """Return model feature columns from a validated feature frame."""
    excluded_columns = {AS_OF_DATE_COLUMN, TARGET_REFERENCE_DATE_COLUMN, TARGET_VALUE_COLUMN}
    feature_columns = [column for column in feature_frame.columns if column not in excluded_columns]
    if not feature_columns:
        msg = "Feature frame contains no model feature columns."
        raise ValueError(msg)
    return feature_columns


def fit_final_forecast(
    model_name: str,
    feature_frame: pd.DataFrame,
    forecast_row: pd.DataFrame,
    spec: ModelSpec,
) -> float:
    """Fit a selected model on all labeled rows and forecast one future row."""
    prepared = _prepare_feature_frame(feature_frame)
    feature_columns = feature_column_names(prepared)
    missing = [column for column in feature_columns if column not in forecast_row.columns]
    if missing:
        msg = f"Forecast row missing model features: {', '.join(missing)}"
        raise ValueError(msg)
    estimator = estimator_for_model(model_name, spec)
    estimator.fit(prepared[feature_columns], prepared[TARGET_VALUE_COLUMN])
    prediction = estimator.predict(forecast_row.loc[:, feature_columns])
    value = float(prediction[0])
    if not np.isfinite(value):
        msg = "Final model produced a non-finite point forecast."
        raise ValueError(msg)
    return value


def estimator_for_model(model_name: str, spec: ModelSpec) -> Pipeline:
    """Return a configured estimator for a supported model name."""
    if model_name == "ridge":
        return _ridge_pipeline(spec)
    if model_name == "lightgbm":
        return _lightgbm_pipeline(spec)
    msg = f"Unsupported model name: {model_name}"
    raise ValueError(msg)


def summary_metrics(prediction_frame: pd.DataFrame) -> dict[str, float | bool | str]:
    """Compute aggregate out-of-sample metrics and naive comparison."""
    actual = prediction_frame["actual"].to_numpy(dtype=float)
    predicted = prediction_frame["prediction"].to_numpy(dtype=float)
    naive = prediction_frame["naive_prediction"].to_numpy(dtype=float)
    rmse = _rmse(actual, predicted)
    naive_rmse = _rmse(actual, naive)
    beats_naive = rmse < naive_rmse
    return {
        "rmse": rmse,
        "mae": _mae(actual, predicted),
        "directional_accuracy": _directional_accuracy(actual, predicted),
        "hit_rate_vs_naive": _hit_rate_vs_naive(actual, predicted, naive),
        "naive_rmse": naive_rmse,
        "naive_mae": _mae(actual, naive),
        "beats_naive_rmse": beats_naive,
        "naive_comparison": _naive_message(beats_naive),
    }


def _prepare_feature_frame(feature_frame: pd.DataFrame) -> pd.DataFrame:
    validated = validate_feature_frame(feature_frame)
    prepared = validated.copy()
    for column in feature_column_names(prepared):
        prepared[column] = pd.to_numeric(prepared[column], errors="raise")
    return prepared.dropna(subset=[TARGET_VALUE_COLUMN]).reset_index(drop=True)


def _fit_predict_fold(
    model_name: str,
    feature_frame: pd.DataFrame,
    feature_columns: list[str],
    fold_id: int,
    split: tuple[np.ndarray, np.ndarray],
    estimator_factory: RegressorFactory,
) -> pd.DataFrame:
    train_index, test_index = split
    train = feature_frame.iloc[train_index]
    test = feature_frame.iloc[test_index]
    estimator = estimator_factory()
    estimator.fit(train[feature_columns], train[TARGET_VALUE_COLUMN])
    prediction = estimator.predict(test[feature_columns])
    naive_prediction = np.repeat(
        float(train[TARGET_VALUE_COLUMN].iloc[-1]),
        repeats=len(test),
    )
    return pd.DataFrame(
        {
            "model_name": model_name,
            "fold_id": fold_id,
            AS_OF_DATE_COLUMN: test[AS_OF_DATE_COLUMN].to_numpy(),
            TARGET_REFERENCE_DATE_COLUMN: test[TARGET_REFERENCE_DATE_COLUMN].to_numpy(),
            "actual": test[TARGET_VALUE_COLUMN].to_numpy(dtype=float),
            "prediction": prediction.astype(float),
            "naive_prediction": naive_prediction,
            "train_start": train[AS_OF_DATE_COLUMN].iloc[0],
            "train_end": train[AS_OF_DATE_COLUMN].iloc[-1],
            "test_start": test[AS_OF_DATE_COLUMN].iloc[0],
            "test_end": test[AS_OF_DATE_COLUMN].iloc[-1],
        }
    )


def _fold_results(prediction_frame: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for fold_id, fold in prediction_frame.groupby("fold_id", sort=True):
        actual = fold["actual"].to_numpy(dtype=float)
        predicted = fold["prediction"].to_numpy(dtype=float)
        naive = fold["naive_prediction"].to_numpy(dtype=float)
        rmse = _rmse(actual, predicted)
        naive_rmse = _rmse(actual, naive)
        rows.append(
            FoldResult(
                model_name=str(fold["model_name"].iloc[0]),
                fold_id=int(fold_id),
                train_start=pd.Timestamp(fold["train_start"].iloc[0]),
                train_end=pd.Timestamp(fold["train_end"].iloc[0]),
                test_start=pd.Timestamp(fold["test_start"].iloc[0]),
                test_end=pd.Timestamp(fold["test_end"].iloc[0]),
                observations=len(fold),
                rmse=rmse,
                mae=_mae(actual, predicted),
                directional_accuracy=_directional_accuracy(actual, predicted),
                hit_rate_vs_naive=_hit_rate_vs_naive(actual, predicted, naive),
                model_beats_naive_rmse=rmse < naive_rmse,
            ).__dict__
        )
    return pd.DataFrame(rows)


def _ridge_pipeline(spec: ModelSpec) -> Pipeline:
    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy=spec.imputation_strategy)),
            ("scaler", StandardScaler()),
            ("model", Ridge(alpha=spec.ridge_alpha)),
        ]
    ).set_output(transform="pandas")


def _lightgbm_pipeline(spec: ModelSpec) -> Pipeline:
    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy=spec.imputation_strategy)),
            ("model", lgb.LGBMRegressor(**spec.lightgbm_params)),
        ]
    ).set_output(transform="pandas")


def _validate_positive_window_config(min_train_size: int, test_size: int, step_size: int) -> None:
    for name, value in {
        "min_train_size": min_train_size,
        "test_size": test_size,
        "step_size": step_size,
    }.items():
        if value <= 0:
            msg = f"{name} must be positive."
            raise ValueError(msg)


def _positive_int(value: int | None, name: str) -> int:
    if value is None or value <= 0:
        msg = f"{name} must be a positive integer."
        raise ValueError(msg)
    return value


def _positive_float(value: float | None, name: str) -> float:
    if value is None or value <= 0:
        msg = f"{name} must be a positive float."
        raise ValueError(msg)
    return value


def _rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.sqrt(np.mean((actual - predicted) ** 2)))


def _mae(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.abs(actual - predicted)))


def _directional_accuracy(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.sign(actual) == np.sign(predicted)))


def _hit_rate_vs_naive(actual: np.ndarray, predicted: np.ndarray, naive: np.ndarray) -> float:
    return float(np.mean(np.abs(actual - predicted) < np.abs(actual - naive)))


def _naive_message(beats_naive: bool) -> str:
    if beats_naive:
        return "Model beats the naive last-value baseline on out-of-sample RMSE."
    return "Model does not beat the naive last-value baseline on out-of-sample RMSE."
