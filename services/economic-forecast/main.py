"""Authenticated background wrapper around the Phase 2 forecast orchestrator."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from macro_predictor.dashboard.contracts import validate_snapshot
from macro_predictor.dashboard.pipeline import run_pipeline
from operations import (
    health_summary,
    post_dashboard,
    prune_local_artifacts,
    structured_log,
)
from runtime import (
    BoundedJobExecutor,
    bounded_integer,
    load_host_secrets,
    readiness_report,
)

job_executor = BoundedJobExecutor(
    max_workers=bounded_integer("ECONOMIC_FORECAST_MAX_WORKERS", 1, 1, 4),
    max_queued=bounded_integer("ECONOMIC_FORECAST_MAX_QUEUED_JOBS", 2, 0, 20),
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Load mounted secrets and drain accepted work during host shutdown."""
    load_host_secrets()
    snapshot_directory().mkdir(parents=True, exist_ok=True)
    structured_log("info", "service.started", stage="runtime", status="accepting")
    try:
        yield
    finally:
        structured_log("info", "service.stopping", stage="runtime", status="draining")
        await asyncio.to_thread(job_executor.shutdown)
        structured_log("info", "service.stopped", stage="runtime", status="stopped")


app = FastAPI(title="PDE Studio economic-forecast sidecar", version="1.1.0", lifespan=lifespan)


@app.middleware("http")
async def bound_requests(request: Request, call_next):
    """Bound inbound bodies and total API request time before route processing."""
    maximum = bounded_integer("ECONOMIC_FORECAST_MAX_REQUEST_BYTES", 65_536, 1_024, 1_048_576)
    timeout = bounded_integer("ECONOMIC_FORECAST_REQUEST_TIMEOUT_SECONDS", 15, 1, 120)
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > maximum:
                return JSONResponse({"detail": "Request body too large"}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)
    if request.method in {"POST", "PUT", "PATCH"}:
        try:
            body = await asyncio.wait_for(request.body(), timeout=timeout)
        except TimeoutError:
            return JSONResponse({"detail": "Request body timed out"}, status_code=408)
        if len(body) > maximum:
            return JSONResponse({"detail": "Request body too large"}, status_code=413)
    try:
        return await asyncio.wait_for(call_next(request), timeout=timeout)
    except TimeoutError:
        return JSONResponse({"detail": "Request timed out"}, status_code=504)


def authenticate(authorization: str | None = Header(default=None)) -> None:
    """Require the server-to-server bearer token without returning it to callers."""
    expected = os.getenv("ECONOMIC_FORECAST_SERVICE_TOKEN", "")
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not expected or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def snapshot_directory() -> Path:
    """Return the configured durable snapshot directory."""
    return Path(os.getenv("ECONOMIC_FORECAST_SNAPSHOT_DIR", "snapshots")).resolve()


def config_path() -> Path:
    """Return the configured Phase 2 orchestration config path."""
    value = os.getenv("ECONOMIC_FORECAST_CONFIG_PATH", "")
    if not value:
        raise HTTPException(status_code=503, detail="Forecast config is unavailable")
    return Path(value).resolve()


def optional_config_path() -> Path | None:
    value = os.getenv("ECONOMIC_FORECAST_CONFIG_PATH", "")
    return Path(value).resolve() if value else None


@app.get("/health")
def health() -> dict[str, object]:
    """Return a secret-free health response."""
    return health_summary(snapshot_directory())


@app.get("/ready")
def ready() -> JSONResponse:
    """Report dependency readiness using boolean checks and secret-free reason codes."""
    is_ready, payload = readiness_report(
        snapshot_directory(), optional_config_path(), job_executor.accepting
    )
    return JSONResponse(payload, status_code=200 if is_ready else 503)


@app.get("/latest", dependencies=[Depends(authenticate)])
def latest() -> dict[str, object]:
    """Read the latest accepted immutable snapshot without fitting a model."""
    path = snapshot_directory() / "latest.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No accepted forecast snapshot")
    payload = json.loads(path.read_text(encoding="utf-8"))
    try:
        validated = validate_snapshot(payload)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Latest snapshot failed validation") from exc
    if validated["status"] != "accepted":
        raise HTTPException(status_code=500, detail="Latest snapshot is not accepted")
    return validated


@app.post("/refresh", status_code=202, dependencies=[Depends(authenticate)])
def refresh() -> dict[str, str]:
    """Queue a forecast run and immediately return a durable job identifier."""
    job_id = str(uuid.uuid4())
    _write_job(job_id, "queued", "Refresh queued")
    if not job_executor.submit(_run_job, job_id):
        _write_job(job_id, "failed", "Refresh capacity unavailable; retry later")
        raise HTTPException(status_code=429, detail="Refresh capacity unavailable")
    return _job_payload(job_id)


@app.get("/jobs/{job_id}", dependencies=[Depends(authenticate)])
def job(job_id: str) -> dict[str, str]:
    """Return refresh progress without holding the original request open."""
    try:
        uuid.UUID(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid job ID") from exc
    path = _job_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Refresh job not found")
    return _job_payload(job_id)


def _run_job(job_id: str) -> None:
    structured_log(
        "info", "forecast.started", job_id=job_id, stage="orchestration", status="running"
    )
    _write_job(job_id, "running", "Ingestion and walk-forward evaluation running")
    try:
        snapshot = run_pipeline(config_path())
        ingested = post_dashboard({"snapshot": snapshot})
        if snapshot["status"] != "accepted":
            _write_job(job_id, "failed", "Run failed acceptance; latest snapshot preserved")
            structured_log(
                "warning",
                "forecast.rejected",
                job_id=job_id,
                run_id=str(snapshot.get("runId", "")),
                stage="acceptance",
                status="rejected",
            )
            return
        if not ingested:
            _write_job(
                job_id,
                "failed",
                "Accepted locally; dashboard ingestion failed and its latest pointer was preserved",
            )
            structured_log(
                "error",
                "forecast.ingestion_failed",
                job_id=job_id,
                run_id=str(snapshot["runId"]),
                stage="persistence",
                status="failed",
            )
            return
        _write_job(job_id, "succeeded", "Accepted snapshot published", str(snapshot["runId"]))
        structured_log(
            "info",
            "forecast.accepted",
            job_id=job_id,
            run_id=str(snapshot["runId"]),
            stage="persistence",
            status="accepted",
        )
    except Exception as exc:
        _write_job(job_id, "failed", "Refresh failed; latest snapshot preserved")
        post_dashboard(
            {
                "failure": {
                    "stage": "orchestration",
                    "code": "runtime-failure",
                    "message": type(exc).__name__,
                }
            }
        )
        structured_log(
            "error",
            "forecast.failed",
            job_id=job_id,
            stage="orchestration",
            status="failed",
            message=type(exc).__name__,
        )
    finally:
        prune_local_artifacts(snapshot_directory())


def _job_path(job_id: str) -> Path:
    return snapshot_directory() / "jobs" / f"{job_id}.json"


def _write_job(job_id: str, status: str, message: str, run_id: str | None = None) -> None:
    path = _job_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "jobId": job_id,
        "status": status,
        "message": message,
        "updatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    if run_id:
        payload["runId"] = run_id
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    for attempt in range(5):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.01 * (attempt + 1))


def _job_payload(job_id: str) -> dict[str, str]:
    path = _job_path(job_id)
    for attempt in range(5):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (PermissionError, json.JSONDecodeError):
            if attempt == 4:
                raise
            time.sleep(0.01 * (attempt + 1))
    raise RuntimeError("Unreachable job read retry state")
