"""SQLite persistence for normalized observations."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from sqlalchemy import (
    Column,
    Date,
    DateTime,
    Float,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    create_engine,
    delete,
    insert,
)
from sqlalchemy.engine import Engine

from macro_predictor.data_sources.schema import OBSERVATION_COLUMNS

metadata = MetaData()

observations = Table(
    "observations",
    metadata,
    Column("series_id", String, nullable=False),
    Column("date", Date, nullable=False),
    Column("value", Float, nullable=False),
    Column("source", String, nullable=False),
    Column("release_date", Date, nullable=False),
    Column("fetched_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint(
        "series_id",
        "date",
        "source",
        "release_date",
        name="uq_observations_series_date_source_release",
    ),
)


def create_sqlite_engine(database_url: str) -> Engine:
    """Create a SQLAlchemy engine and parent folders for SQLite paths."""
    if database_url.startswith("sqlite:///"):
        db_path = Path(database_url.removeprefix("sqlite:///"))
        if not db_path.is_absolute():
            db_path.parent.mkdir(parents=True, exist_ok=True)
        else:
            db_path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(database_url, future=True)


def initialize_database(engine: Engine) -> None:
    """Create ingestion tables if they do not already exist."""
    metadata.create_all(engine)


def store_observations(engine: Engine, frame: pd.DataFrame) -> int:
    """Replace matching observations and return the number of rows stored."""
    if frame.empty:
        return 0
    _ensure_columns(frame)
    payload = _to_records(frame)
    keys = {
        (row["series_id"], row["date"], row["source"], row["release_date"]) for row in payload
    }
    with engine.begin() as connection:
        for series_id, date_value, source, release_date in keys:
            connection.execute(
                delete(observations).where(
                    observations.c.series_id == series_id,
                    observations.c.date == date_value,
                    observations.c.source == source,
                    observations.c.release_date == release_date,
                )
            )
        connection.execute(insert(observations), payload)
    return len(payload)


def _ensure_columns(frame: pd.DataFrame) -> None:
    missing = [column for column in OBSERVATION_COLUMNS if column not in frame.columns]
    if missing:
        msg = f"Observation frame missing required columns: {', '.join(missing)}"
        raise ValueError(msg)


def _to_records(frame: pd.DataFrame) -> list[dict[str, object]]:
    normalized = frame.loc[:, OBSERVATION_COLUMNS].copy()
    normalized["date"] = pd.to_datetime(normalized["date"]).dt.date
    normalized["release_date"] = pd.to_datetime(normalized["release_date"]).dt.date
    normalized["fetched_at"] = [
        value.to_pydatetime() for value in pd.to_datetime(normalized["fetched_at"], utc=True)
    ]
    return normalized.to_dict(orient="records")
