"""Secret-safe operations helpers for the forecast sidecar."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

METHOD_REGISTRY = (
    {"id": "signed-oos-residual-bootstrap", "version": "1.0.0", "status": "baseline", "enabled": True},
    {"id": "model-mixture", "version": "0.1.0", "status": "follow-up", "enabled": False},
    {"id": "direct-quantile", "version": "0.1.0", "status": "follow-up", "enabled": False},
    {"id": "conformal", "version": "0.1.0", "status": "follow-up", "enabled": False},
    {"id": "bootstrap-refit", "version": "0.1.0", "status": "follow-up", "enabled": False},
    {"id": "vintage-revision", "version": "0.1.0", "status": "follow-up", "enabled": False},
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def structured_log(level: str, event: str, **fields: object) -> None:
    """Emit an allowlisted JSON record without environment values or credentials."""
    allowed = {key: _sanitize(value) for key, value in fields.items() if key in {
        "run_id", "job_id", "stage", "status", "release_id", "message", "duration_ms"
    }}
    print(json.dumps({
        "timestamp": utc_now().isoformat().replace("+00:00", "Z"),
        "level": level,
        "event": event,
        **allowed,
    }, sort_keys=True), flush=True)


def post_dashboard(payload: dict[str, object], path: str = "operations/ingest") -> bool:
    base = os.getenv("ECONOMIC_FORECAST_DASHBOARD_URL", "").rstrip("/")
    token = os.getenv("ECONOMIC_FORECAST_INGEST_TOKEN", "")
    if not base or not token:
        structured_log("warning", "dashboard.ingest.skipped", stage="persistence", message="Dashboard ingestion is not configured")
        return False
    request = urllib.request.Request(
        f"{base}/api/economic-forecast/{path}",
        data=json.dumps(payload, allow_nan=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        timeout = _positive_env("ECONOMIC_FORECAST_OUTBOUND_TIMEOUT_SECONDS", 20)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        structured_log("error", "dashboard.ingest.failed", stage="persistence", message=type(exc).__name__)
        return False


def prune_local_artifacts(snapshot_directory: Path, now: datetime | None = None) -> dict[str, int]:
    """Apply bounded local retention while protecting the latest accepted run."""
    current = now or utc_now()
    failed_days = _positive_env("ECONOMIC_FORECAST_FAILED_RETENTION_DAYS", 180)
    accepted_days = _positive_env("ECONOMIC_FORECAST_ACCEPTED_RETENTION_DAYS", 2555)
    job_days = _positive_env("ECONOMIC_FORECAST_JOB_RETENTION_DAYS", 30)
    latest_path = snapshot_directory / "latest.json"
    latest_id = None
    if latest_path.exists():
        try:
            latest_id = json.loads(latest_path.read_text(encoding="utf-8")).get("runId")
        except (json.JSONDecodeError, OSError):
            pass
    removed = {"runs": 0, "jobs": 0}
    for path in (snapshot_directory / "runs").glob("*.json"):
        if path.stem == latest_id:
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            accepted = payload.get("status") == "accepted" and payload.get("acceptance", {}).get("accepted") is True
            age = current - datetime.fromtimestamp(path.stat().st_mtime, UTC)
            if age > timedelta(days=accepted_days if accepted else failed_days):
                path.unlink()
                removed["runs"] += 1
        except (json.JSONDecodeError, OSError, TypeError):
            continue
    for path in (snapshot_directory / "jobs").glob("*.json"):
        try:
            if current - datetime.fromtimestamp(path.stat().st_mtime, UTC) > timedelta(days=job_days):
                path.unlink()
                removed["jobs"] += 1
        except OSError:
            continue
    return removed


def health_summary(snapshot_directory: Path) -> dict[str, object]:
    latest_path = snapshot_directory / "latest.json"
    jobs = sorted((snapshot_directory / "jobs").glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)[:20]
    latest: dict[str, Any] | None = None
    if latest_path.exists():
        try:
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            latest = None
    failures = 0
    for path in jobs:
        try:
            if json.loads(path.read_text(encoding="utf-8")).get("status") == "failed":
                failures += 1
            else:
                break
        except (json.JSONDecodeError, OSError):
            break
    distribution = latest.get("distribution", {}) if latest else {}
    coverage = distribution.get("coverage", []) if isinstance(distribution, dict) else []
    return {
        "status": "degraded" if failures >= 3 or latest is None else "ok",
        "latestAcceptedRunId": latest.get("runId") if latest else None,
        "latestGeneratedAt": latest.get("generatedAt") if latest else None,
        "consecutiveFailedJobs": failures,
        "coverage": [{"nominal": item.get("nominal"), "observed": item.get("observed"), "accepted": item.get("accepted")} for item in coverage if isinstance(item, dict)],
        "methods": METHOD_REGISTRY,
        "credentialsConfigured": bool(os.getenv("ECONOMIC_FORECAST_SERVICE_TOKEN")),
    }


def _positive_env(name: str, fallback: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(fallback))))
    except ValueError:
        return fallback


def _sanitize(value: object) -> object:
    if not isinstance(value, str):
        return value
    cleaned = re.sub(r"(?i)(bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+", r"\1=[REDACTED]", value)
    return re.sub(r"[A-Za-z0-9_-]{32,}", "[REDACTED]", cleaned)[:500]
