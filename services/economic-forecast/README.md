# PDE Studio economic-forecast sidecar

This separately deployed FastAPI service wraps the Phase 2 Python orchestrator. The dashboard
never imports Python, trains a model, or receives provider credentials. `GET /latest` only reads
the last accepted immutable snapshot. `POST /refresh` queues the configured run and returns a job
ID; `GET /jobs/{jobId}` reports progress.

## Local setup

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -e "../../Economic Data Prediction Model"
.venv\Scripts\uvicorn main:app --host 127.0.0.1 --port 8020
```

For local development only, configure values in the process environment. Never commit them:

```text
ECONOMIC_FORECAST_SERVICE_TOKEN=<long random server-to-server token>
ECONOMIC_FORECAST_CONFIG_PATH=<absolute path to the Phase 2 JSON config>
ECONOMIC_FORECAST_SNAPSHOT_DIR=<durable directory containing runs/ and latest.json>
FRED_API_KEY=<provider key used by the ingestion job, when required>
ECONOMIC_FORECAST_DASHBOARD_URL=<dashboard origin, no trailing slash>
ECONOMIC_FORECAST_INGEST_TOKEN=<separate server-to-server persistence token>
ECONOMIC_FORECAST_OFFICIAL_CALENDAR=<path to a provenance-stamped calendar JSON>
```

Configure the dashboard server with `ECONOMIC_FORECAST_SERVICE_URL` and the same
`ECONOMIC_FORECAST_SERVICE_TOKEN`, plus the same `ECONOMIC_FORECAST_INGEST_TOKEN` used by the
sidecar callback. Never use `NEXT_PUBLIC_*` for any of these values.

Production does not inject secret values through the Compose environment. It mounts
`fred_api_key`, `service_token`, `dashboard_ingest_token` and `forecast_config` from the host secret
store; the application loads only the first three into its private process environment. See the
runbook for the exact server-side mapping.

Production should use a durable mounted/object-backed snapshot directory, one job worker per
configuration, HTTPS, bounded concurrency, and a scheduler that calls the authenticated refresh
endpoint around official releases. Failed and rejected jobs never replace `latest.json`.

## Production container

Improvement 1 is packaged as a non-root OCI container with a persistent volume, host-file secrets,
bounded work and HTTP concurrency, body/time limits, graceful job draining, and a secret-free
`GET /ready` probe. Build from the repository root with
`services/economic-forecast/Dockerfile`; deploy using
`services/economic-forecast/deploy/compose.production.yml` and an immutable image digest.

Follow [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) for secret mapping, dashboard server settings,
release verification, rollback, backup and failure recovery. Use one replica until Improvement 3
adds a durable distributed queue.

## Scheduled operation

Run `python scheduler.py --calendar <verified-calendar.json>` from cron or a scheduled worker every
15 minutes. It only queues a refresh 15 minutes after a not-yet-triggered release in the signed-off
official calendar, uploads the calendar provenance to the dashboard, and records a durable release
ID so retries cannot duplicate a run. Page loads never invoke this command.

The dashboard stores compact run metadata, acceptance state and its latest pointer in D1. Immutable
snapshot, CSV, report and optional compressed full-draw artifacts live under run-scoped R2 keys.
Default retention is 7 years for accepted metadata/artifacts, 180 days for rejected/failed runs,
90 days for events and optional draws; the latest accepted run is always protected. Override these
with the corresponding `ECONOMIC_FORECAST_*_RETENTION_DAYS` host variables.

`signed-oos-residual-bootstrap@1.0.0` remains the baseline. Model-mixture, direct-quantile,
conformal, bootstrap-refit and vintage-revision methods are registered as disabled, versioned
follow-ups and must be compared against that baseline before activation.
