from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import main
from fastapi.testclient import TestClient


class DashboardState:
    latest_run_id: str | None = None
    received: list[dict[str, Any]] = []


class DashboardHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length))
        DashboardState.received.append(payload)
        snapshot = payload.get("snapshot")
        if (
            isinstance(snapshot, dict)
            and snapshot.get("status") == "accepted"
            and snapshot.get("acceptance", {}).get("accepted") is True
        ):
            DashboardState.latest_run_id = str(snapshot["runId"])
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"stored":true}')

    def log_message(self, _format: str, *args: object) -> None:
        return


def _wait_for_job(client: TestClient, token: str, job_id: str) -> dict[str, str]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f"/jobs/{job_id}", headers={"Authorization": f"Bearer {token}"})
        payload = response.json()
        if payload["status"] not in {"queued", "running"}:
            return payload
        time.sleep(0.02)
    raise AssertionError("Forecast job did not finish during smoke test")


def test_accepted_handoff_and_forced_failure_preserve_dashboard_latest(
    tmp_path: Path, monkeypatch
) -> None:
    DashboardState.latest_run_id = None
    DashboardState.received = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), DashboardHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    token = "service-" + "s" * 40
    ingest_token = "ingest-" + "i" * 40
    snapshots = tmp_path / "snapshots"
    input_csv = tmp_path / "input.csv"
    input_csv.write_text("series_id,observation_date,value\n", encoding="utf-8")
    config = tmp_path / "forecast-config.json"
    config.write_text(
        json.dumps(
            {
                "inputCsv": str(input_csv.resolve()),
                "outputDirectory": str(snapshots.resolve()),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ECONOMIC_FORECAST_SERVICE_TOKEN", token)
    monkeypatch.setenv("ECONOMIC_FORECAST_INGEST_TOKEN", ingest_token)
    monkeypatch.setenv("FRED_API_KEY", "test-fred-key")
    monkeypatch.setenv("ECONOMIC_FORECAST_DASHBOARD_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("ECONOMIC_FORECAST_ALLOW_INSECURE_DASHBOARD_URL", "true")
    monkeypatch.setenv("ECONOMIC_FORECAST_CONFIG_PATH", str(config))
    monkeypatch.setenv("ECONOMIC_FORECAST_SNAPSHOT_DIR", str(snapshots))
    calls = 0

    def pipeline(_config: Path) -> dict[str, object]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return {
                "runId": "smoke-accepted-run",
                "status": "accepted",
                "acceptance": {"accepted": True},
            }
        raise RuntimeError("forced smoke failure")

    monkeypatch.setattr(main, "run_pipeline", pipeline)
    try:
        with TestClient(main.app) as client:
            ready = client.get("/ready")
            assert ready.status_code == 200
            assert token not in ready.text and ingest_token not in ready.text
            oversized = client.post(
                "/refresh", content=b"x" * 70_000, headers={"Authorization": f"Bearer {token}"}
            )
            assert oversized.status_code == 413

            accepted_response = client.post(
                "/refresh", json={}, headers={"Authorization": f"Bearer {token}"}
            )
            assert accepted_response.status_code == 202
            accepted_job = _wait_for_job(client, token, accepted_response.json()["jobId"])
            assert accepted_job["status"] == "succeeded"
            assert DashboardState.latest_run_id == "smoke-accepted-run"

            latest_path = tmp_path / "snapshots" / "latest.json"
            latest_path.write_text(
                json.dumps(
                    {
                        "runId": "smoke-accepted-run",
                        "status": "accepted",
                        "acceptance": {"accepted": True},
                    }
                ),
                encoding="utf-8",
            )
            monkeypatch.setattr(main, "validate_snapshot", lambda payload: payload)
            latest_response = client.get("/latest", headers={"Authorization": f"Bearer {token}"})
            assert latest_response.status_code == 200
            assert latest_response.json()["runId"] == "smoke-accepted-run"
            assert calls == 1

            failed_response = client.post(
                "/refresh", json={}, headers={"Authorization": f"Bearer {token}"}
            )
            assert failed_response.status_code == 202
            failed_job = _wait_for_job(client, token, failed_response.json()["jobId"])
            assert failed_job["status"] == "failed"
            assert DashboardState.latest_run_id == "smoke-accepted-run"
            assert "failure" in DashboardState.received[-1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
