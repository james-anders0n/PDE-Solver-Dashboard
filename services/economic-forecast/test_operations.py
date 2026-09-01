from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from operations import prune_local_artifacts, structured_log
from scheduler import eligible_releases, load_official_calendar


def _calendar(now: datetime) -> dict[str, object]:
    return {
        "sourceName": "Agency official release calendar",
        "sourceUrl": "https://example.gov/releases",
        "sourceRevision": "v1",
        "fetchedAt": now.isoformat(),
        "releases": [
            {"releaseId": "agency-cpi-001", "seriesId": "CPI", "releaseTimestamp": (now - timedelta(minutes=20)).isoformat()},
            {"releaseId": "agency-cpi-002", "seriesId": "CPI", "releaseTimestamp": (now + timedelta(days=1)).isoformat()},
        ],
    }


def test_release_eligibility_is_deduplicated_and_windowed() -> None:
    now = datetime(2026, 8, 24, 12, tzinfo=UTC)
    calendar = _calendar(now)
    assert [item["releaseId"] for item in eligible_releases(calendar, now, set())] == ["agency-cpi-001"]
    assert eligible_releases(calendar, now, {"agency-cpi-001"}) == []


def test_calendar_requires_fresh_official_provenance(tmp_path: Path) -> None:
    payload = _calendar(datetime.now(UTC) - timedelta(days=46))
    path = tmp_path / "calendar.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="older than 45 days"):
        load_official_calendar(path)


def test_retention_never_deletes_latest_accepted(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    jobs = tmp_path / "jobs"
    runs.mkdir()
    jobs.mkdir()
    latest = {"runId": "run-protected", "status": "accepted", "acceptance": {"accepted": True}}
    (tmp_path / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
    protected = runs / "run-protected.json"
    expired = runs / "run-rejected.json"
    protected.write_text(json.dumps(latest), encoding="utf-8")
    expired.write_text(json.dumps({"runId": "run-rejected", "status": "rejected", "acceptance": {"accepted": False}}), encoding="utf-8")
    old = datetime.now(UTC).timestamp() - 200 * 86400
    import os
    os.utime(protected, (old, old))
    os.utime(expired, (old, old))
    removed = prune_local_artifacts(tmp_path)
    assert protected.exists()
    assert not expired.exists()
    assert removed["runs"] == 1


def test_structured_logs_redact_secret_material(capsys: pytest.CaptureFixture[str]) -> None:
    structured_log("error", "refresh.failed", message="api_key=abcdefghijklmnop token=12345678901234567890123456789012")
    output = capsys.readouterr().out
    assert "abcdefghijklmnop" not in output
    assert "1234567890" not in output
