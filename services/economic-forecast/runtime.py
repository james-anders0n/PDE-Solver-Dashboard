"""Production runtime controls for the economic-forecast sidecar."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

SECRET_FILES = {
    "FRED_API_KEY": "fred_api_key",
    "ECONOMIC_FORECAST_SERVICE_TOKEN": "service_token",
    "ECONOMIC_FORECAST_INGEST_TOKEN": "dashboard_ingest_token",
}


def load_host_secrets(secret_root: Path | None = None) -> None:
    """Load secrets from host-mounted files without logging values or paths."""
    root = secret_root or Path(os.getenv("ECONOMIC_FORECAST_SECRET_ROOT", "/run/secrets"))
    for environment_name, default_name in SECRET_FILES.items():
        explicit = os.getenv(f"{environment_name}_FILE", "")
        path = Path(explicit) if explicit else root / default_name
        if environment_name not in os.environ and path.is_file():
            value = path.read_text(encoding="utf-8").strip()
            if value:
                os.environ[environment_name] = value


def readiness_report(
    snapshot_directory: Path, config_path: Path | None, accepting_jobs: bool
) -> tuple[bool, dict[str, object]]:
    """Validate production dependencies while returning only boolean state and reason codes."""
    checks: dict[str, dict[str, object]] = {}

    def check(name: str, passed: bool, reason: str) -> None:
        checks[name] = {"ok": passed, "reason": "ok" if passed else reason}

    check(
        "serviceAuthentication",
        len(os.getenv("ECONOMIC_FORECAST_SERVICE_TOKEN", "")) >= 32,
        "service-secret-unavailable",
    )
    check(
        "dashboardAuthentication",
        len(os.getenv("ECONOMIC_FORECAST_INGEST_TOKEN", "")) >= 32,
        "ingest-secret-unavailable",
    )
    check("fredCredential", bool(os.getenv("FRED_API_KEY", "")), "fred-secret-unavailable")
    dashboard_url = os.getenv("ECONOMIC_FORECAST_DASHBOARD_URL", "")
    secure_dashboard = dashboard_url.startswith("https://") or (
        os.getenv("ECONOMIC_FORECAST_ALLOW_INSECURE_DASHBOARD_URL", "").lower() == "true"
        and dashboard_url.startswith("http://")
    )
    check("dashboardEndpoint", secure_dashboard, "dashboard-url-invalid")
    config_valid = False
    input_valid = False
    output_valid = False
    if config_path and config_path.is_file():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config_valid = isinstance(config, dict)
            if config_valid:
                input_path = Path(str(config.get("inputCsv", "")))
                output_path = Path(str(config.get("outputDirectory", "")))
                input_valid = input_path.is_absolute() and input_path.is_file()
                output_valid = (
                    output_path.is_absolute() and output_path.resolve() == snapshot_directory
                )
        except (json.JSONDecodeError, OSError):
            config_valid = False
    check("orchestrationConfig", config_valid, "config-secret-invalid")
    check("pointInTimeInput", input_valid, "input-data-unavailable")
    check("configuredOutput", output_valid, "output-path-mismatch")
    storage_valid = False
    try:
        snapshot_directory.mkdir(parents=True, exist_ok=True)
        probe = snapshot_directory / ".readiness-probe"
        probe.write_text("ready", encoding="utf-8")
        probe.unlink()
        storage_valid = True
    except OSError:
        storage_valid = False
    check("durableStorage", storage_valid, "snapshot-storage-unwritable")
    check("jobExecutor", accepting_jobs, "executor-shutting-down")
    ready = all(bool(item["ok"]) for item in checks.values())
    return ready, {"status": "ready" if ready else "not-ready", "checks": checks}


class BoundedJobExecutor:
    """Bound in-process work until Improvement 3 introduces a durable queue."""

    def __init__(self, max_workers: int = 1, max_queued: int = 2) -> None:
        self.max_workers = max(1, max_workers)
        self.max_queued = max(0, max_queued)
        self._executor = ThreadPoolExecutor(
            max_workers=self.max_workers, thread_name_prefix="forecast-job"
        )
        self._lock = threading.Lock()
        self._in_flight = 0
        self._accepting = True
        self._futures: set[Future[None]] = set()

    @property
    def accepting(self) -> bool:
        with self._lock:
            return self._accepting

    @property
    def in_flight(self) -> int:
        with self._lock:
            return self._in_flight

    def submit(self, function: Callable[..., None], *args: object) -> bool:
        with self._lock:
            if not self._accepting or self._in_flight >= self.max_workers + self.max_queued:
                return False
            self._in_flight += 1
        try:
            future = self._executor.submit(self._run, function, args)
        except RuntimeError:
            with self._lock:
                self._in_flight -= 1
            return False
        with self._lock:
            self._futures.add(future)
        future.add_done_callback(self._discard)
        return True

    def shutdown(self) -> None:
        """Stop new submissions and let every already-accepted job finish cleanly."""
        with self._lock:
            self._accepting = False
        self._executor.shutdown(wait=True, cancel_futures=False)

    def _run(self, function: Callable[..., None], args: tuple[object, ...]) -> None:
        try:
            function(*args)
        finally:
            with self._lock:
                self._in_flight -= 1

    def _discard(self, future: Future[None]) -> None:
        with self._lock:
            self._futures.discard(future)


def bounded_integer(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(os.getenv(name, str(fallback)))))
    except ValueError:
        return fallback
