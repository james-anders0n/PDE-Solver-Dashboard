"""HTTP helpers with retry and exponential backoff."""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping

import requests

LOGGER = logging.getLogger(__name__)


def get_json_with_retry(
    session: requests.Session,
    url: str,
    params: Mapping[str, object],
    timeout_seconds: float,
    max_retries: int,
    backoff_seconds: float,
) -> dict[str, object]:
    """Fetch JSON with retry and exponential backoff."""
    last_error: Exception | None = None
    attempts = max_retries + 1
    for attempt in range(attempts):
        try:
            response = session.get(url, params=params, timeout=timeout_seconds)
            response.raise_for_status()
            payload: object = response.json()
            if not isinstance(payload, dict):
                msg = "HTTP response JSON payload must be an object."
                raise ValueError(msg)
            return payload
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt == max_retries:
                break
            sleep_seconds = backoff_seconds * (2**attempt)
            LOGGER.warning(
                "HTTP request failed; retrying",
                extra={"url": url, "attempt": attempt + 1, "sleep_seconds": sleep_seconds},
            )
            time.sleep(sleep_seconds)
    msg = f"HTTP request failed after {attempts} attempts: {url}"
    raise RuntimeError(msg) from last_error
