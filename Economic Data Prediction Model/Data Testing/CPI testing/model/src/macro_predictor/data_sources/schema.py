"""Shared ingestion schema definitions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import pandas as pd

OBSERVATION_COLUMNS = ("series_id", "date", "value", "source", "release_date", "fetched_at")


@dataclass(frozen=True)
class ObservationRecord:
    """Normalized observation persisted by every data source."""

    series_id: str
    date: str
    value: float
    source: str
    release_date: str
    fetched_at: datetime


def empty_observations() -> pd.DataFrame:
    """Return an empty DataFrame with the normalized observation columns."""
    return pd.DataFrame(columns=OBSERVATION_COLUMNS)
