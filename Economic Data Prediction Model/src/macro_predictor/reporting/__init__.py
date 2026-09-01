"""Run report generation modules."""

from macro_predictor.reporting.baseline import (
    ReportSpec,
    render_baseline_report,
    save_baseline_report,
    spec_from_settings,
    write_predicted_vs_actual_plot,
)

__all__ = [
    "ReportSpec",
    "render_baseline_report",
    "save_baseline_report",
    "spec_from_settings",
    "write_predicted_vs_actual_plot",
]
