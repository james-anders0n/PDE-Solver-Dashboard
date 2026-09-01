# Economic Forecast Sidecar — Production Deployment and Recovery Runbook

## Scope and architecture

This runbook deploys the FastAPI sidecar as one non-root OCI container on a durable Docker host.
The host must provide:

- an HTTPS reverse proxy or managed HTTPS ingress;
- a persistent volume mounted at `/var/lib/economic-forecast`;
- a host secret store exposed as read-only files under `/run/secrets`;
- a container registry that supports immutable image digests; and
- backups for the persistent volume.

Use exactly one sidecar replica until the durable queue in Improvement 3 exists. The application
already bounds accepted work inside that replica, but its in-process executor is not a distributed
lock. Page requests never run the pipeline: `GET /latest` reads only `latest.json`, and
`POST /refresh` queues bounded background work and returns a job ID.

The dashboard remains the authoritative cross-service latest pointer. The Python pipeline maintains
its own atomic local `latest.json`; the dashboard advances its D1 pointer only after accepted
snapshot validation and R2 artifact persistence. A rejected run, runtime exception or failed
dashboard callback cannot advance the dashboard pointer.

## Required host secrets

Create four secret files through the host's secret manager. Do not commit, print or place their
values in the Compose environment section.

| Secret file | Consumer | Requirement |
| --- | --- | --- |
| `fred_api_key` | Sidecar/model ingestion | FRED provider credential |
| `service_token` | Sidecar and dashboard server | Random value of at least 32 characters |
| `dashboard_ingest_token` | Sidecar and dashboard ingestion API | Separate random value of at least 32 characters |
| `forecast_config.json` | Sidecar orchestrator | Complete point-in-time pipeline configuration |

Configure the dashboard host with these server-only values:

- `ECONOMIC_FORECAST_SERVICE_URL`: public HTTPS sidecar origin;
- `ECONOMIC_FORECAST_SERVICE_TOKEN`: the value in `service_token`; and
- `ECONOMIC_FORECAST_INGEST_TOKEN`: the value in `dashboard_ingest_token`.

Never use a `NEXT_PUBLIC_*` name. The sidecar receives the two tokens and FRED key from mounted
files. `ECONOMIC_FORECAST_DASHBOARD_URL` is a non-secret host setting and must be the dashboard's
HTTPS origin.

The orchestration config should use absolute container paths. Store changing input data on the
persistent volume, for example:

```json
{
  "inputCsv": "/var/lib/economic-forecast/input/point_in_time_observations.csv",
  "outputDirectory": "/var/lib/economic-forecast/snapshots"
}
```

Retain all existing point-in-time fields, acceptance gates, model settings and distribution seed in
the real config. Manage the input CSV through the authenticated ingestion workflow or a separately
audited host job; do not bake provider data or credentials into the image.

## Build and publish the image

Run from the dashboard repository root:

```powershell
docker build --file services/economic-forecast/Dockerfile --tag <registry>/pde-economic-forecast:<release> .
docker push <registry>/pde-economic-forecast:<release>
docker inspect --format='{{index .RepoDigests 0}}' <registry>/pde-economic-forecast:<release>
```

Record the resulting digest in the deployment change. Production should use the digest, not a
mutable `latest` tag. The container runs as UID/GID `10001`, has no Linux capabilities, uses a
read-only root filesystem and writes only to the persistent volume and bounded `/tmp` tmpfs.

## Prepare the host

1. Install Docker Engine and Compose v2 on a patched Linux host.
2. Provision DNS and HTTPS ingress for the sidecar. Forward only to `127.0.0.1:8020`.
3. Create the four secret files with owner-read-only permissions through the host secret manager.
4. Copy `deploy/host-settings.example` to a host-owned environment file outside the repository.
5. Set the immutable image digest, dashboard URL and the four host secret-file paths.
6. Ensure the persistent volume is included in host backups.
7. Place the point-in-time input data in the volume path referenced by the secret config.

The checked-in Compose definition does not expose the service publicly. The reverse proxy is the
only public entry and must enforce TLS. If the proxy is not local, set
`ECONOMIC_FORECAST_FORWARDED_ALLOW_IPS` to its exact trusted address; never use `*` casually.

## Deploy

From the repository root on the host:

```powershell
docker compose --env-file <host-settings-file> --file services/economic-forecast/deploy/compose.production.yml config
docker compose --env-file <host-settings-file> --file services/economic-forecast/deploy/compose.production.yml up --detach
docker compose --env-file <host-settings-file> --file services/economic-forecast/deploy/compose.production.yml ps
```

The `config` command must succeed without rendering any secret values. The container remains
unready until all secret files, the configuration, the HTTPS dashboard endpoint and writable durable
storage pass their checks.

## Release verification

1. Request `GET /health`; confirm the process is live and the response contains no credentials.
2. Request `GET /ready`; require HTTP 200 and every named check to report `ok: true`.
3. Call authenticated `GET /latest`. HTTP 404 is acceptable before the first accepted run; it must
   not start training.
4. Queue one authenticated `POST /refresh` and retain the returned job ID.
5. Poll authenticated `GET /jobs/{jobId}` without holding the original request open.
6. Confirm an accepted job appears in the dashboard Operations run history and advances the pointer.
7. Run the forced-failure smoke test in a non-production test environment; confirm the dashboard
   pointer remains on the accepted run.
8. Confirm no API key, token, configuration body or provider response appears in logs.

Local verification command:

```powershell
python -m pytest services/economic-forecast/test_runtime.py services/economic-forecast/test_handoff_smoke.py -q
```

## Runtime limits

Defaults are intentionally conservative:

- one active forecast worker and two queued jobs;
- 32 concurrent HTTP requests;
- 64 KiB maximum inbound request body;
- 15-second API request timeout;
- 20-second dashboard callback timeout; and
- five-minute graceful shutdown/drain window.

Increase forecast workers only after measuring CPU and memory use. A rejected submission returns
HTTP 429 with a retryable generic message. Do not horizontally scale before Improvement 3 adds a
durable distributed queue and lease.

## Normal shutdown and upgrade

1. Stop schedule triggers before maintenance.
2. Deploy the new immutable image digest with Compose.
3. The old process stops accepting jobs and drains every job it already accepted.
4. Require the replacement container to pass `/ready` before re-enabling schedule triggers.
5. Keep the previous image digest available for rollback.

Rollback changes only the image digest. Keep the persistent volume and secret versions intact unless
the incident specifically involves corrupted state or compromised credentials.

## Failure recovery

### Upstream or model failure

- Leave the container running for health/status inspection.
- Confirm the job is `failed` and the dashboard still serves its previous accepted run.
- Correct the upstream/configuration issue and queue a new run; never edit an immutable run artifact.

### Dashboard callback failure

- The sidecar marks the job failed even when its local pipeline produced an accepted snapshot.
- The dashboard pointer remains unchanged.
- Restore dashboard availability, then rerun with the identical input identity. Dashboard
  deduplication safely returns an existing stored run if the original callback actually succeeded.

### Host restart

- Compose restarts the container automatically.
- The persistent snapshot and job files remain on the named volume.
- In-process queued work cannot survive an abrupt host loss; reconcile any `queued` or `running` job
  as failed and rerun it. Improvement 3 replaces this limitation with durable queue recovery.

### Volume loss or corruption

- Stop schedule triggers and the container.
- Restore the latest verified volume backup to a new volume.
- Start the container and require `/ready` to pass.
- Validate local `latest.json` through authenticated `GET /latest`.
- The dashboard's D1/R2 last-known-good remains available during sidecar recovery.

### Credential compromise

1. Stop refresh scheduling.
2. Rotate the affected host secret.
3. For shared service or ingestion credentials, update both the sidecar and dashboard server in one
   change window.
4. Restart the sidecar, redeploy dashboard environment settings if changed, and require readiness.
5. Review structured rejection/audit events without copying credentials into incident notes.

## Backup and retention

Back up the persistent volume after every accepted release run and retain copies according to the
documented accepted/rejected policy. Test restoration periodically on a separate host. D1/R2 remain
the dashboard's immutable operational history; the local volume is the sidecar's recovery copy, not
a replacement for dashboard persistence.
