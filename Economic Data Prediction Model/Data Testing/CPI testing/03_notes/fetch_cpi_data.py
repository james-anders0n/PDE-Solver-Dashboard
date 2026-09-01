"""Download CPI test data from FRED and build simple inflation metrics.

This script is intentionally scoped to the Data Testing/CPI testing folder.
It does not import or write to the main macro_predictor model pipeline.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import requests

BASE_DIR = Path(__file__).resolve().parents[1]
RAW_DIR = BASE_DIR / "01_raw"
PROCESSED_DIR = BASE_DIR / "02_processed"

SERIES = {
    "CPIAUCSL": {
        "label": "headline_cpi",
        "description": (
            "Consumer Price Index for All Urban Consumers: All Items in U.S. City "
            "Average, seasonally adjusted"
        ),
    },
    "CPILFESL": {
        "label": "core_cpi",
        "description": (
            "Consumer Price Index for All Urban Consumers: All Items Less Food and "
            "Energy, seasonally adjusted"
        ),
    },
}


def fred_csv_url(series_id: str) -> str:
    """Return the public FRED chart CSV URL for a series."""
    return f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"


def download_series(session: requests.Session, series_id: str, label: str) -> pd.DataFrame:
    """Download a FRED CSV series and save its raw file."""
    response = session.get(
        fred_csv_url(series_id),
        headers={"User-Agent": "cpi-testing-data-download/1.0"},
        timeout=30,
    )
    response.raise_for_status()

    raw_path = RAW_DIR / f"fred_{series_id}_{label}.csv"
    raw_path.write_bytes(response.content)

    frame = pd.read_csv(raw_path)
    frame.columns = ["date", series_id]
    frame["date"] = pd.to_datetime(frame["date"])
    frame[series_id] = pd.to_numeric(frame[series_id], errors="coerce")
    return frame.dropna(subset=[series_id])


def build_inflation_metrics(frame: pd.DataFrame, series_id: str, label: str) -> pd.DataFrame:
    """Build MoM and YoY percent changes for one CPI index series."""
    result = frame.sort_values("date").copy()
    result["series_id"] = series_id
    result["series_label"] = label
    result["index_value"] = result[series_id]
    result["mom_inflation_pct"] = result["index_value"].pct_change(1) * 100
    result["yoy_inflation_pct"] = result["index_value"].pct_change(12) * 100
    result["annualized_mom_inflation_pct"] = (
        (1 + result["index_value"].pct_change(1)) ** 12 - 1
    ) * 100
    return result[
        [
            "date",
            "series_id",
            "series_label",
            "index_value",
            "mom_inflation_pct",
            "annualized_mom_inflation_pct",
            "yoy_inflation_pct",
        ]
    ]


def main() -> None:
    """Download raw CPI data and save processed inflation metrics."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    with requests.Session() as session:
        metric_frames = []
        for series_id, metadata in SERIES.items():
            frame = download_series(session, series_id, metadata["label"])
            metric_frames.append(build_inflation_metrics(frame, series_id, metadata["label"]))

    metrics = pd.concat(metric_frames, ignore_index=True)
    metrics.to_csv(PROCESSED_DIR / "cpi_inflation_metrics.csv", index=False)

    latest_rows = metrics.dropna(subset=["yoy_inflation_pct"]).groupby("series_id").tail(1)
    latest_rows.to_csv(PROCESSED_DIR / "latest_cpi_inflation_snapshot.csv", index=False)


if __name__ == "__main__":
    main()
