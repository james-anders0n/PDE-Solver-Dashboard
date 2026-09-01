"""Release-calendar trigger intended for cron/Worker scheduled invocations."""

from __future__ import annotations

import argparse
import json
import os
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from operations import post_dashboard, structured_log


def load_official_calendar(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    source_name = str(payload.get("sourceName", ""))
    source_url = str(payload.get("sourceUrl", ""))
    if "official" not in source_name.lower() or not source_url.startswith("https://"):
        raise ValueError("Calendar must carry official HTTPS provenance")
    fetched_at = _timestamp(payload.get("fetchedAt"), "fetchedAt")
    if datetime.now(UTC) - fetched_at > timedelta(days=45):
        raise ValueError("Official release calendar is older than 45 days")
    releases = payload.get("releases")
    if not isinstance(releases, list):
        raise ValueError("Calendar releases must be an array")
    for release in releases:
        if not isinstance(release, dict) or not release.get("releaseId") or not release.get("seriesId"):
            raise ValueError("Calendar release identity is incomplete")
        _timestamp(release.get("releaseTimestamp"), "releaseTimestamp")
    return payload


def eligible_releases(calendar: dict[str, Any], now: datetime, triggered: set[str], delay_minutes: int = 15, grace_hours: int = 12) -> list[dict[str, Any]]:
    eligible = []
    for release in calendar["releases"]:
        release_id = str(release["releaseId"])
        release_time = _timestamp(release["releaseTimestamp"], "releaseTimestamp")
        if release_id not in triggered and release_time + timedelta(minutes=delay_minutes) <= now <= release_time + timedelta(hours=grace_hours):
            eligible.append(release)
    return sorted(eligible, key=lambda item: str(item["releaseTimestamp"]))


def run_once(calendar_path: Path, now: datetime | None = None) -> int:
    calendar = load_official_calendar(calendar_path)
    state_path = Path(os.getenv("ECONOMIC_FORECAST_SCHEDULER_STATE", calendar_path.with_name("scheduler-state.json")))
    triggered = _load_state(state_path)
    current = now or datetime.now(UTC)
    delay = _positive_env("ECONOMIC_FORECAST_RELEASE_DELAY_MINUTES", 15)
    grace = _positive_env("ECONOMIC_FORECAST_RELEASE_GRACE_HOURS", 12)
    post_dashboard(calendar, "operations/calendar")
    candidates = eligible_releases(calendar, current, triggered, delay, grace)
    if not candidates:
        structured_log("info", "schedule.noop", stage="calendar", status="outside-window")
        return 0
    release = candidates[0]
    service_url = os.getenv("ECONOMIC_FORECAST_SERVICE_URL", "").rstrip("/")
    token = os.getenv("ECONOMIC_FORECAST_SERVICE_TOKEN", "")
    if not service_url or not token:
        raise RuntimeError("Authenticated forecast service endpoint is not configured")
    request = urllib.request.Request(f"{service_url}/refresh", data=b"{}", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=20) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError("Forecast service rejected scheduled refresh")
    triggered.add(str(release["releaseId"]))
    _write_state(state_path, triggered)
    structured_log("info", "schedule.triggered", stage="calendar", status="queued", release_id=str(release["releaseId"]))
    return 1


def _timestamp(value: object, label: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Invalid {label}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed.astimezone(UTC)


def _load_state(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return {str(item) for item in payload.get("triggeredReleaseIds", [])}
    except (json.JSONDecodeError, OSError, AttributeError):
        return set()


def _write_state(path: Path, triggered: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"triggeredReleaseIds": sorted(triggered)}, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


def _positive_env(name: str, fallback: int) -> int:
    try:
        return max(0, int(os.getenv(name, str(fallback))))
    except ValueError:
        return fallback


def main() -> None:
    parser = argparse.ArgumentParser(description="Trigger forecast refreshes only around verified official releases")
    parser.add_argument("--calendar", type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(0 if run_once(args.calendar) >= 0 else 1)


if __name__ == "__main__":
    main()
