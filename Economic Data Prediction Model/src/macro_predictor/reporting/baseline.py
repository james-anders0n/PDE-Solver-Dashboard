"""Markdown baseline report generation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date
from html import escape
from pathlib import Path

import pandas as pd

from macro_predictor.config import Settings, get_settings
from macro_predictor.data_sources.schema import OBSERVATION_COLUMNS
from macro_predictor.features.point_in_time import (
    AS_OF_DATE_COLUMN,
    TARGET_REFERENCE_DATE_COLUMN,
    TARGET_VALUE_COLUMN,
)
from macro_predictor.models.validation import ModelResult, ModelSpec


@dataclass(frozen=True)
class ReportSpec:
    """Resolved report output settings."""

    output_dir: Path
    plot_width: int
    plot_height: int
    plot_padding: int


def spec_from_settings(settings: Settings | None = None) -> ReportSpec:
    """Build report settings from runtime configuration."""
    resolved = settings or get_settings()
    return ReportSpec(
        output_dir=Path(resolved.report_output_dir),
        plot_width=_positive_int(resolved.report_plot_width, "REPORT_PLOT_WIDTH"),
        plot_height=_positive_int(resolved.report_plot_height, "REPORT_PLOT_HEIGHT"),
        plot_padding=_positive_int(resolved.report_plot_padding, "REPORT_PLOT_PADDING"),
    )


def save_baseline_report(
    observation_frame: pd.DataFrame,
    feature_frame: pd.DataFrame,
    model_results: dict[str, ModelResult],
    model_spec: ModelSpec,
    report_spec: ReportSpec,
    run_date: date | None = None,
) -> Path:
    """Save a baseline markdown report and predicted-versus-actual SVG plot."""
    resolved_run_date = run_date or date.today()
    report_spec.output_dir.mkdir(parents=True, exist_ok=True)
    plot_path = report_spec.output_dir / f"{resolved_run_date.isoformat()}_predicted_vs_actual.svg"
    report_path = report_spec.output_dir / f"{resolved_run_date.isoformat()}_baseline.md"
    write_predicted_vs_actual_plot(model_results, plot_path, report_spec)
    report_path.write_text(
        render_baseline_report(
            observation_frame=observation_frame,
            feature_frame=feature_frame,
            model_results=model_results,
            model_spec=model_spec,
            plot_path=plot_path,
            report_path=report_path,
            run_date=resolved_run_date,
        ),
        encoding="utf-8",
    )
    return report_path


def render_baseline_report(
    observation_frame: pd.DataFrame,
    feature_frame: pd.DataFrame,
    model_results: dict[str, ModelResult],
    model_spec: ModelSpec,
    plot_path: Path,
    report_path: Path,
    run_date: date,
) -> str:
    """Render the baseline markdown report body."""
    _validate_report_inputs(observation_frame, feature_frame, model_results)
    if plot_path.parent == report_path.parent:
        relative_plot_path = plot_path.name
    else:
        relative_plot_path = str(plot_path)
    sections = [
        f"# Baseline CPI MoM Forecast Report\n\nRun date: `{run_date.isoformat()}`",
        "## Data Coverage\n\n" + _markdown_table(_data_coverage(observation_frame)),
        "## Features\n\n" + _feature_summary(feature_frame),
        "## Parameters\n\n" + _parameters_section(model_spec),
        "## Fold Results\n\n" + _fold_results_section(model_results),
        "## Summary Metrics\n\n" + _summary_metrics_section(model_results),
        f"## Predicted Versus Actual\n\n![Predicted versus actual]({relative_plot_path})",
    ]
    return "\n\n".join(sections) + "\n"


def write_predicted_vs_actual_plot(
    model_results: dict[str, ModelResult],
    plot_path: Path,
    report_spec: ReportSpec,
) -> Path:
    """Write a predicted-versus-actual SVG plot for all model results."""
    plot_frame = _plot_frame(model_results)
    svg = _render_svg(plot_frame, report_spec)
    plot_path.write_text(svg, encoding="utf-8")
    return plot_path


def _validate_report_inputs(
    observation_frame: pd.DataFrame,
    feature_frame: pd.DataFrame,
    model_results: dict[str, ModelResult],
) -> None:
    missing_observation_columns = [
        column for column in OBSERVATION_COLUMNS if column not in observation_frame.columns
    ]
    if missing_observation_columns:
        msg = f"Observation frame missing columns: {', '.join(missing_observation_columns)}"
        raise ValueError(msg)
    required_feature_columns = {
        AS_OF_DATE_COLUMN,
        TARGET_REFERENCE_DATE_COLUMN,
        TARGET_VALUE_COLUMN,
    }
    missing_feature_columns = required_feature_columns.difference(feature_frame.columns)
    if missing_feature_columns:
        msg = f"Feature frame missing columns: {', '.join(sorted(missing_feature_columns))}"
        raise ValueError(msg)
    if observation_frame.empty:
        msg = "Observation frame is empty."
        raise ValueError(msg)
    if feature_frame.empty:
        msg = "Feature frame is empty."
        raise ValueError(msg)
    if not model_results:
        msg = "Model results are required for report generation."
        raise ValueError(msg)


def _data_coverage(observation_frame: pd.DataFrame) -> pd.DataFrame:
    frame = observation_frame.copy()
    frame["date"] = pd.to_datetime(frame["date"], errors="raise")
    frame["release_date"] = pd.to_datetime(frame["release_date"], errors="raise")
    coverage = (
        frame.groupby(["source", "series_id"], dropna=False)
        .agg(
            rows=("value", "count"),
            first_date=("date", "min"),
            last_date=("date", "max"),
            first_release=("release_date", "min"),
            last_release=("release_date", "max"),
        )
        .reset_index()
    )
    for column in ("first_date", "last_date", "first_release", "last_release"):
        coverage[column] = coverage[column].dt.date.astype(str)
    return coverage


def _feature_summary(feature_frame: pd.DataFrame) -> str:
    feature_columns = [
        column
        for column in feature_frame.columns
        if column not in {AS_OF_DATE_COLUMN, TARGET_REFERENCE_DATE_COLUMN, TARGET_VALUE_COLUMN}
    ]
    missing_values = feature_frame[feature_columns].isna().sum().rename("missing_values")
    summary = pd.DataFrame(
        {
            "feature": feature_columns,
            "missing_values": [int(missing_values[column]) for column in feature_columns],
        }
    )
    return f"Feature count: `{len(feature_columns)}`\n\n" + _markdown_table(summary)


def _parameters_section(model_spec: ModelSpec) -> str:
    rows = pd.DataFrame(
        [
            {"parameter": key, "value": _format_value(value)}
            for key, value in asdict(model_spec).items()
        ]
    )
    return _markdown_table(rows)


def _fold_results_section(model_results: dict[str, ModelResult]) -> str:
    frames = []
    for result in model_results.values():
        frame = result.fold_results.copy()
        frame.insert(0, "model", result.model_name)
        frames.append(frame)
    return _markdown_table(pd.concat(frames, ignore_index=True))


def _summary_metrics_section(model_results: dict[str, ModelResult]) -> str:
    rows = []
    messages = []
    for result in model_results.values():
        row = {"model": result.model_name}
        row.update(result.summary_metrics)
        rows.append(row)
        messages.append(f"- `{result.model_name}`: {result.summary_metrics['naive_comparison']}")
    return _markdown_table(pd.DataFrame(rows)) + "\n\n" + "\n".join(messages)


def _plot_frame(model_results: dict[str, ModelResult]) -> pd.DataFrame:
    rows = []
    actual_seen = False
    for result in model_results.values():
        predictions = result.predictions.copy()
        predictions[AS_OF_DATE_COLUMN] = pd.to_datetime(predictions[AS_OF_DATE_COLUMN])
        if not actual_seen:
            rows.append(
                predictions[[AS_OF_DATE_COLUMN, "actual"]].rename(columns={"actual": "Actual"})
            )
            actual_seen = True
        rows.append(
            predictions[[AS_OF_DATE_COLUMN, "prediction"]].rename(
                columns={"prediction": f"{result.model_name} prediction"}
            )
        )
    merged = rows[0]
    for frame in rows[1:]:
        merged = merged.merge(frame, on=AS_OF_DATE_COLUMN, how="outer")
    return merged.sort_values(AS_OF_DATE_COLUMN).reset_index(drop=True)


def _render_svg(plot_frame: pd.DataFrame, report_spec: ReportSpec) -> str:
    width = report_spec.plot_width
    height = report_spec.plot_height
    padding = report_spec.plot_padding
    x_values = pd.to_datetime(plot_frame[AS_OF_DATE_COLUMN]).map(pd.Timestamp.toordinal).to_numpy()
    y_values = plot_frame.drop(columns=[AS_OF_DATE_COLUMN]).to_numpy(dtype=float).ravel()
    y_values = y_values[~pd.isna(y_values)]
    if len(y_values) == 0:
        msg = "No prediction values available for plotting."
        raise ValueError(msg)
    x_min, x_max = float(x_values.min()), float(x_values.max())
    y_min, y_max = float(y_values.min()), float(y_values.max())
    if x_min == x_max:
        x_max = x_min + 1.0
    if y_min == y_max:
        y_max = y_min + 1.0
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="white"/>',
        _axis_svg(width, height, padding),
    ]
    for index, column in enumerate(plot_frame.columns.drop(AS_OF_DATE_COLUMN)):
        points = _polyline_points(
            plot_frame[[AS_OF_DATE_COLUMN, column]].dropna(),
            x_min,
            x_max,
            y_min,
            y_max,
            report_spec,
        )
        if points:
            color = _series_color(index)
            lines.append(
                f'<polyline fill="none" stroke="{color}" stroke-width="2" '
                f'points="{escape(points)}"/>'
            )
            lines.append(_legend_svg(str(column), color, index, padding))
    lines.append("</svg>")
    return "\n".join(lines)


def _axis_svg(width: int, height: int, padding: int) -> str:
    x_axis_y = height - padding
    return (
        f'<line x1="{padding}" y1="{padding}" x2="{padding}" y2="{x_axis_y}" '
        'stroke="#334155" stroke-width="1"/>'
        f'<line x1="{padding}" y1="{x_axis_y}" x2="{width - padding}" y2="{x_axis_y}" '
        'stroke="#334155" stroke-width="1"/>'
    )


def _polyline_points(
    frame: pd.DataFrame,
    x_min: float,
    x_max: float,
    y_min: float,
    y_max: float,
    report_spec: ReportSpec,
) -> str:
    if frame.empty:
        return ""
    width = report_spec.plot_width
    height = report_spec.plot_height
    padding = report_spec.plot_padding
    inner_width = width - padding * 2
    inner_height = height - padding * 2
    points = []
    for row in frame.itertuples(index=False):
        x_raw = float(pd.Timestamp(row[0]).toordinal())
        y_raw = float(row[1])
        x = padding + ((x_raw - x_min) / (x_max - x_min)) * inner_width
        y = height - padding - ((y_raw - y_min) / (y_max - y_min)) * inner_height
        points.append(f"{x:.2f},{y:.2f}")
    return " ".join(points)


def _legend_svg(label: str, color: str, index: int, padding: int) -> str:
    y = padding + index * 18
    return (
        f'<line x1="{padding}" y1="{y}" x2="{padding + 18}" y2="{y}" '
        f'stroke="{color}" stroke-width="2"/>'
        f'<text x="{padding + 24}" y="{y + 4}" font-size="12" '
        f'font-family="Arial, sans-serif" fill="#0f172a">{escape(label)}</text>'
    )


def _series_color(index: int) -> str:
    palette = ("#0f766e", "#2563eb", "#b45309", "#7c3aed", "#be123c", "#475569")
    return palette[index % len(palette)]


def _markdown_table(frame: pd.DataFrame) -> str:
    if frame.empty:
        return "_No rows._"
    formatted = frame.copy()
    for column in formatted.columns:
        formatted[column] = formatted[column].map(_format_value)
    headers = [str(column) for column in formatted.columns]
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in formatted.itertuples(index=False):
        lines.append("| " + " | ".join(str(value) for value in row) + " |")
    return "\n".join(lines)


def _format_value(value: object) -> str:
    if isinstance(value, float):
        return f"{value:.6g}"
    if isinstance(value, pd.Timestamp):
        return value.date().isoformat()
    if isinstance(value, dict):
        return ", ".join(f"{key}={_format_value(item)}" for key, item in value.items())
    return str(value)


def _positive_int(value: int, name: str) -> int:
    if value <= 0:
        msg = f"{name} must be positive."
        raise ValueError(msg)
    return value
