from __future__ import annotations

import json
import threading
from pathlib import Path

from runtime import BoundedJobExecutor, load_host_secrets, readiness_report


def test_host_secret_files_and_readiness_never_return_values(tmp_path: Path, monkeypatch) -> None:
    secrets = tmp_path / "secrets"
    snapshots = tmp_path / "snapshots"
    secrets.mkdir()
    values = {
        "fred_api_key": "fred-value-that-must-not-appear",
        "service_token": "s" * 40,
        "dashboard_ingest_token": "i" * 40,
    }
    for name, value in values.items():
        (secrets / name).write_text(value, encoding="utf-8")
    input_csv = tmp_path / "input.csv"
    input_csv.write_text("series_id,observation_date,value\n", encoding="utf-8")
    config = secrets / "forecast_config"
    config.write_text(
        json.dumps(
            {
                "inputCsv": str(input_csv.resolve()),
                "outputDirectory": str(snapshots.resolve()),
            }
        ),
        encoding="utf-8",
    )
    for name in (
        "FRED_API_KEY",
        "ECONOMIC_FORECAST_SERVICE_TOKEN",
        "ECONOMIC_FORECAST_INGEST_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ECONOMIC_FORECAST_DASHBOARD_URL", "https://dashboard.example")
    load_host_secrets(secrets)
    ready, report = readiness_report(snapshots, config, True)
    encoded = json.dumps(report)
    assert ready is True
    assert report["status"] == "ready"
    assert all(value not in encoded for value in values.values())


def test_readiness_fails_closed_with_reason_codes(tmp_path: Path, monkeypatch) -> None:
    for name in (
        "FRED_API_KEY",
        "ECONOMIC_FORECAST_SERVICE_TOKEN",
        "ECONOMIC_FORECAST_INGEST_TOKEN",
        "ECONOMIC_FORECAST_DASHBOARD_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    ready, report = readiness_report(tmp_path / "snapshots", None, False)
    assert ready is False
    assert report["checks"]["serviceAuthentication"]["reason"] == "service-secret-unavailable"
    assert report["checks"]["orchestrationConfig"]["reason"] == "config-secret-invalid"
    assert report["checks"]["jobExecutor"]["reason"] == "executor-shutting-down"


def test_bounded_executor_rejects_excess_and_drains_active_work() -> None:
    executor = BoundedJobExecutor(max_workers=1, max_queued=1)
    started = threading.Event()
    release = threading.Event()
    completed: list[str] = []

    def work(identifier: str) -> None:
        started.set()
        release.wait(timeout=2)
        completed.append(identifier)

    assert executor.submit(work, "first") is True
    assert started.wait(timeout=1)
    assert executor.submit(work, "second") is True
    assert executor.submit(work, "third") is False
    release.set()
    executor.shutdown()
    assert completed == ["first", "second"]
    assert executor.accepting is False
    assert executor.submit(work, "after-shutdown") is False


def test_production_container_is_non_root_persistent_and_file_secret_only() -> None:
    service_directory = Path(__file__).parent
    dockerfile = (service_directory / "Dockerfile").read_text(encoding="utf-8")
    compose = (service_directory / "deploy" / "compose.production.yml").read_text(encoding="utf-8")
    assert "USER 10001:10001" in dockerfile
    assert 'VOLUME ["/var/lib/economic-forecast"]' in dockerfile
    assert "http://127.0.0.1:8020/ready" in dockerfile
    assert "read_only: true" in compose
    assert "no-new-privileges:true" in compose
    assert "forecast_state:/var/lib/economic-forecast" in compose
    assert "FRED_API_KEY_FILE: /run/secrets/fred_api_key" in compose
    assert "ECONOMIC_FORECAST_SERVICE_TOKEN_FILE: /run/secrets/service_token" in compose
    assert "ECONOMIC_FORECAST_INGEST_TOKEN_FILE: /run/secrets/dashboard_ingest_token" in compose
    assert "NEXT_PUBLIC_" not in dockerfile + compose
