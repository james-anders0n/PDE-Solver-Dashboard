"""Validation and data-quality logging shared by ingestion modules."""

from __future__ import annotations

import logging

import pandas as pd

from macro_predictor.data_sources.schema import OBSERVATION_COLUMNS


def validate_observations(frame: pd.DataFrame, source: str) -> pd.DataFrame:
    """Validate and normalize the shared observation schema."""
    if frame.empty:
        msg = f"{source} frame contains no observations."
        raise ValueError(msg)
    missing = [column for column in OBSERVATION_COLUMNS if column not in frame.columns]
    if missing:
        msg = f"{source} frame missing required columns: {', '.join(missing)}"
        raise ValueError(msg)
    normalized = frame.loc[:, OBSERVATION_COLUMNS].copy()
    normalized["series_id"] = normalized["series_id"].astype("string")
    normalized["source"] = normalized["source"].astype("string")
    normalized["date"] = pd.to_datetime(normalized["date"], errors="raise")
    normalized["release_date"] = pd.to_datetime(normalized["release_date"], errors="raise")
    normalized["fetched_at"] = pd.to_datetime(normalized["fetched_at"], errors="raise", utc=True)
    normalized["value"] = pd.to_numeric(normalized["value"], errors="raise")
    required_columns = ["series_id", "source", "date", "release_date", "fetched_at", "value"]
    required_values = normalized[required_columns]
    if required_values.isna().any().any():
        msg = f"{source} frame contains nulls after normalization."
        raise ValueError(msg)
    duplicate_keys = normalized.duplicated(subset=["series_id", "date", "source"])
    if duplicate_keys.any():
        msg = f"{source} frame contains duplicate series/date/source keys."
        raise ValueError(msg)
    return normalized.sort_values(["series_id", "date", "release_date"]).reset_index(drop=True)


def log_row_counts_and_gaps(frame: pd.DataFrame, source: str, logger: logging.Logger) -> None:
    """Log row counts and calendar gaps for each ingested series."""
    if frame.empty:
        logger.warning("No rows fetched", extra={"source": source})
        return
    logger.info("Rows fetched", extra={"source": source, "row_count": len(frame)})
    for series_id, group in frame.groupby("series_id", sort=True):
        ordered_dates = pd.to_datetime(group["date"]).sort_values()
        gaps = ordered_dates.diff().dropna()
        if gaps.empty:
            logger.info(
                "Series coverage",
                extra={
                    "source": source,
                    "series_id": series_id,
                    "row_count": len(group),
                    "gap_count": 0,
                },
            )
            continue
        expected_gap = gaps.mode().iloc[0]
        large_gap_count = int((gaps > expected_gap).sum())
        logger.info(
            "Series coverage",
            extra={
                "source": source,
                "series_id": series_id,
                "row_count": len(group),
                "first_date": ordered_dates.iloc[0].date().isoformat(),
                "last_date": ordered_dates.iloc[-1].date().isoformat(),
                "expected_gap_days": int(expected_gap.days),
                "large_gap_count": large_gap_count,
            },
        )
