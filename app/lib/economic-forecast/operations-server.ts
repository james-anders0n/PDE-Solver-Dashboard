import { FORECAST_METHOD_REGISTRY, compactRunRecord, immutableArtifactPrefix, sanitizeOperationalText } from "./operations.ts";
import type { EconomicForecastOperationsResponse, EconomicForecastRunRecord } from "./operations.ts";
import type { EconomicForecastSnapshot } from "./types.ts";
import { validateEconomicForecastSnapshot } from "./validate.ts";

type D1Row = Record<string, unknown>;
type ForecastBindings = { DB: D1Database; FORECAST_ARTIFACTS: R2Bucket };

export interface ForecastIngestionPayload {
  snapshot: unknown;
  dedupeKey?: string;
  failure?: { stage?: string; code?: string; message?: string };
  artifacts?: { csv?: string; report?: string; fullDrawsBase64Gzip?: string };
}

export function forecastBindings(): ForecastBindings | null {
  try {
    const bindings = (globalThis as typeof globalThis & { __PDE_RUNTIME_ENV?: Partial<ForecastBindings> }).__PDE_RUNTIME_ENV;
    return bindings.DB && bindings.FORECAST_ARTIFACTS ? bindings as ForecastBindings : null;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (item) => item.toString(16).padStart(2, "0")).join("");
}

function sourceIdentity(raw: unknown, snapshot: EconomicForecastSnapshot): Record<string, unknown> {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const provenance = root.provenance && typeof root.provenance === "object" ? root.provenance as Record<string, unknown> : {};
  return {
    inputSha256: provenance.inputSha256 ?? snapshot.provenance.sourceFiles,
    targetReferenceDate: snapshot.target.referenceDate,
    targetReleaseTimestamp: snapshot.target.releaseTimestamp,
    modelId: snapshot.selectedModelId,
    modelVersion: snapshot.provenance.modelVersion,
    method: snapshot.distribution.method,
    methodVersion: snapshot.distribution.methodVersion,
    seed: snapshot.distribution.seed,
  };
}

function coverageValue(snapshot: EconomicForecastSnapshot, nominal: number, field: "observed" | "averageIntervalWidthPct"): number | null {
  return snapshot.distribution.coverage.find((item) => item.nominal === nominal)?.[field] ?? null;
}

function stateStatement(db: D1Database, key: string, value: string, now: string): D1PreparedStatement {
  return db.prepare("INSERT INTO economic_forecast_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, now);
}

export async function persistForecastRun(payload: ForecastIngestionPayload): Promise<{ runId: string; accepted: boolean; duplicate: boolean }> {
  const bindings = forecastBindings();
  if (!bindings) throw new Error("Forecast persistence bindings are unavailable.");
  const snapshot = validateEconomicForecastSnapshot(payload.snapshot);
  const compact = compactRunRecord(snapshot, payload.failure);
  const rawJson = JSON.stringify(payload.snapshot);
  const contentSha256 = await sha256(rawJson);
  const dedupeKey = payload.dedupeKey?.slice(0, 128) || await sha256(JSON.stringify(sourceIdentity(payload.snapshot, snapshot)));
  const duplicate = await bindings.DB.prepare("SELECT run_id FROM economic_forecast_runs WHERE run_id = ? OR dedupe_key = ? LIMIT 1").bind(snapshot.runId, dedupeKey).first<{ run_id: string }>();
  if (duplicate) return { runId: duplicate.run_id, accepted: compact.accepted, duplicate: true };

  const prefix = immutableArtifactPrefix(snapshot.runId);
  const snapshotKey = `${prefix}/snapshot.json`;
  const csvKey = payload.artifacts?.csv ? `${prefix}/summary.csv` : null;
  const reportKey = payload.artifacts?.report ? `${prefix}/report.md` : null;
  const drawsKey = payload.artifacts?.fullDrawsBase64Gzip ? `${prefix}/draws.csv.gz` : null;
  await bindings.FORECAST_ARTIFACTS.put(snapshotKey, rawJson, { httpMetadata: { contentType: "application/json" }, customMetadata: { runId: snapshot.runId, immutable: "true" } });
  if (csvKey) await bindings.FORECAST_ARTIFACTS.put(csvKey, payload.artifacts!.csv!, { httpMetadata: { contentType: "text/csv" } });
  if (reportKey) await bindings.FORECAST_ARTIFACTS.put(reportKey, payload.artifacts!.report!, { httpMetadata: { contentType: "text/markdown" } });
  if (drawsKey) await bindings.FORECAST_ARTIFACTS.put(drawsKey, Uint8Array.from(atob(payload.artifacts!.fullDrawsBase64Gzip!), (character) => character.charCodeAt(0)), { httpMetadata: { contentType: "application/gzip", contentDisposition: `attachment; filename="${snapshot.runId}-draws.csv.gz"` } });

  const now = new Date().toISOString();
  const insertRun = bindings.DB.prepare(`INSERT INTO economic_forecast_runs (
    run_id, dedupe_key, content_sha256, status, accepted, generated_at, target_reference_date, target_release_timestamp,
    model_id, model_version, distribution_method, distribution_method_version, seed, draw_count, residual_count,
    residual_date_range, p10_pct, p25_pct, p50_pct, p75_pct, p90_pct, mean_pct, standard_deviation_pct,
    coverage_50, coverage_80, coverage_90, interval_width_50_pct, interval_width_80_pct, interval_width_90_pct,
    warnings_json, failure_stage, failure_code, failure_message, snapshot_key, csv_key, report_key, draws_key, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    snapshot.runId, dedupeKey, contentSha256, compact.status, compact.accepted ? 1 : 0, compact.generatedAt,
    compact.targetReferenceDate, compact.targetReleaseTimestamp, compact.modelId, compact.modelVersion,
    compact.distributionMethod, compact.distributionMethodVersion, compact.seed, compact.drawCount, compact.residualCount,
    compact.residualDateRange, snapshot.distribution.p10Pct, snapshot.distribution.p25Pct, snapshot.distribution.p50Pct,
    snapshot.distribution.p75Pct, snapshot.distribution.p90Pct, snapshot.distribution.meanPct, snapshot.distribution.standardDeviationPct,
    coverageValue(snapshot, 0.5, "observed"), coverageValue(snapshot, 0.8, "observed"), coverageValue(snapshot, 0.9, "observed"),
    coverageValue(snapshot, 0.5, "averageIntervalWidthPct"), coverageValue(snapshot, 0.8, "averageIntervalWidthPct"), coverageValue(snapshot, 0.9, "averageIntervalWidthPct"),
    JSON.stringify(compact.warnings), compact.failureStage, compact.failureCode, compact.failureMessage, snapshotKey, csvKey, reportKey, drawsKey, now,
  );
  const eventId = crypto.randomUUID();
  const event = bindings.DB.prepare("INSERT INTO economic_forecast_events (id, run_id, level, event_type, stage, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
    eventId, snapshot.runId, compact.accepted ? "info" : "warning", compact.accepted ? "forecast.accepted" : "forecast.rejected", compact.failureStage ?? "acceptance",
    compact.accepted ? "Accepted snapshot persisted and latest pointer advanced." : sanitizeOperationalText(compact.failureMessage ?? "Run failed acceptance; latest pointer preserved."),
    JSON.stringify({ method: compact.distributionMethod, methodVersion: compact.distributionMethodVersion, seed: compact.seed }), now,
  );
  const previousFailures = Number((await bindings.DB.prepare("SELECT value FROM economic_forecast_state WHERE key = 'consecutive_acceptance_failures'").first<{ value: string }>())?.value ?? "0");
  const statements = [insertRun, event, stateStatement(bindings.DB, "last_attempt_at", now, now)];
  if (compact.accepted) {
    statements.push(stateStatement(bindings.DB, "latest_accepted_run_id", snapshot.runId, now));
    statements.push(stateStatement(bindings.DB, "last_accepted_at", now, now));
    statements.push(stateStatement(bindings.DB, "consecutive_acceptance_failures", "0", now));
  } else {
    statements.push(stateStatement(bindings.DB, "consecutive_acceptance_failures", String(previousFailures + 1), now));
  }
  await bindings.DB.batch(statements);
  await enforceForecastRetention(bindings);
  return { runId: snapshot.runId, accepted: compact.accepted, duplicate: false };
}

export async function readPersistedLatestForecast(): Promise<EconomicForecastSnapshot | null> {
  const bindings = forecastBindings();
  if (!bindings) return null;
  const pointer = await bindings.DB.prepare("SELECT value FROM economic_forecast_state WHERE key = 'latest_accepted_run_id'").first<{ value: string }>();
  if (!pointer?.value) return null;
  const row = await bindings.DB.prepare("SELECT snapshot_key FROM economic_forecast_runs WHERE run_id = ? AND accepted = 1").bind(pointer.value).first<{ snapshot_key: string }>();
  if (!row) return null;
  const object = await bindings.FORECAST_ARTIFACTS.get(row.snapshot_key);
  if (!object) return null;
  const snapshot = validateEconomicForecastSnapshot(await object.json());
  return snapshot.status === "accepted" && snapshot.runId === pointer.value ? snapshot : null;
}

function rowToRun(row: D1Row): EconomicForecastRunRecord {
  return {
    runId: String(row.run_id), status: String(row.status) as EconomicForecastRunRecord["status"], accepted: Boolean(row.accepted),
    generatedAt: String(row.generated_at), targetReferenceDate: String(row.target_reference_date), targetReleaseTimestamp: String(row.target_release_timestamp),
    modelId: String(row.model_id), modelVersion: String(row.model_version), distributionMethod: String(row.distribution_method), distributionMethodVersion: String(row.distribution_method_version),
    seed: Number(row.seed), drawCount: Number(row.draw_count), residualCount: Number(row.residual_count), residualDateRange: String(row.residual_date_range),
    p10Pct: Number(row.p10_pct), p50Pct: Number(row.p50_pct), p90Pct: Number(row.p90_pct), meanPct: Number(row.mean_pct), standardDeviationPct: Number(row.standard_deviation_pct),
    coverage50: row.coverage_50 === null ? null : Number(row.coverage_50), coverage80: row.coverage_80 === null ? null : Number(row.coverage_80), coverage90: row.coverage_90 === null ? null : Number(row.coverage_90),
    warnings: JSON.parse(String(row.warnings_json)) as string[], failureStage: row.failure_stage === null ? null : String(row.failure_stage), failureCode: row.failure_code === null ? null : String(row.failure_code), failureMessage: row.failure_message === null ? null : String(row.failure_message),
    artifacts: { snapshot: true, csv: Boolean(row.csv_key), report: Boolean(row.report_key), fullDraws: Boolean(row.draws_key) },
  };
}

function retentionConfig() {
  const positive = (value: string | undefined, fallback: number) => Math.max(1, Number.parseInt(value ?? "", 10) || fallback);
  return { acceptedDays: positive(process.env.ECONOMIC_FORECAST_ACCEPTED_RETENTION_DAYS, 2555), failedDays: positive(process.env.ECONOMIC_FORECAST_FAILED_RETENTION_DAYS, 180), eventDays: positive(process.env.ECONOMIC_FORECAST_EVENT_RETENTION_DAYS, 90), fullDrawDays: positive(process.env.ECONOMIC_FORECAST_DRAW_RETENTION_DAYS, 90), latestProtected: true as const };
}

export async function readForecastOperations(): Promise<EconomicForecastOperationsResponse> {
  const bindings = forecastBindings();
  const retention = retentionConfig();
  if (!bindings) return { storage: { available: false, d1: "DB unavailable", r2: "FORECAST_ARTIFACTS unavailable" }, health: "initialising", latestAcceptedRunId: null, lastAttemptAt: null, lastAcceptedAt: null, consecutiveAcceptanceFailures: 0, monitors: [{ id: "storage", status: "warning", label: "Persistence bindings", detail: "D1/R2 bindings are not available in this runtime." }], schedule: { mode: "official-release-calendar", nextReleaseTimestamp: null, sourceName: null, sourceUrl: null, message: "No verified official release is loaded." }, retention, runs: [], events: [], methods: FORECAST_METHOD_REGISTRY, warning: "Operational persistence is initialising; the last-known-good bundled snapshot remains available." };
  const [stateResult, runsResult, eventsResult, calendar] = await Promise.all([
    bindings.DB.prepare("SELECT key, value FROM economic_forecast_state").all<D1Row>(),
    bindings.DB.prepare("SELECT * FROM economic_forecast_runs ORDER BY generated_at DESC LIMIT 50").all<D1Row>(),
    bindings.DB.prepare("SELECT id, run_id, level, event_type, stage, message, created_at FROM economic_forecast_events ORDER BY created_at DESC LIMIT 30").all<D1Row>(),
    bindings.DB.prepare("SELECT release_timestamp, source_name, source_url FROM economic_release_calendar WHERE status = 'scheduled' AND release_timestamp >= ? ORDER BY release_timestamp LIMIT 1").bind(new Date().toISOString()).first<D1Row>(),
  ]);
  const state = Object.fromEntries(stateResult.results.map((row) => [String(row.key), String(row.value)]));
  const runs = runsResult.results.map(rowToRun);
  const latest = runs.find((run) => run.runId === state.latest_accepted_run_id) ?? null;
  const failures = Number(state.consecutive_acceptance_failures ?? "0");
  const stale = latest ? Date.parse(latest.targetReleaseTimestamp) <= Date.now() : true;
  const monitors: EconomicForecastOperationsResponse["monitors"] = [
    { id: "freshness", status: !latest ? "warning" : stale ? "critical" : "ok", label: "Forecast freshness", detail: !latest ? "No accepted persisted run yet." : stale ? "The latest accepted target release has passed." : `Current through ${latest.targetReleaseTimestamp}.` },
    { id: "ingestion", status: failures >= 3 ? "critical" : failures > 0 ? "warning" : "ok", label: "Repeated acceptance failures", detail: `${failures} consecutive rejected or failed refresh${failures === 1 ? "" : "es"}.` },
    { id: "calibration", status: latest?.accepted ? "ok" : "warning", label: "Distribution calibration", detail: latest ? `Coverage 50/80/90: ${[latest.coverage50, latest.coverage80, latest.coverage90].map((value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`).join(" · ")}.` : "No persisted calibration summary yet." },
    { id: "storage", status: "ok", label: "Immutable storage", detail: "D1 metadata and R2 run artifacts are available; latest pointer is guarded." },
  ];
  const health = monitors.some((item) => item.status === "critical") ? "degraded" : monitors.some((item) => item.status === "warning") ? "warning" : "healthy";
  return {
    storage: { available: true, d1: "DB", r2: "FORECAST_ARTIFACTS" }, health, latestAcceptedRunId: state.latest_accepted_run_id ?? null, lastAttemptAt: state.last_attempt_at ?? null, lastAcceptedAt: state.last_accepted_at ?? null, consecutiveAcceptanceFailures: failures, monitors,
    schedule: { mode: "official-release-calendar", nextReleaseTimestamp: calendar ? String(calendar.release_timestamp) : null, sourceName: calendar ? String(calendar.source_name) : null, sourceUrl: calendar ? String(calendar.source_url) : null, message: calendar ? "Refresh is release-triggered; page loads never retrain." : "No verified official release is loaded; automatic refresh remains paused." },
    retention, runs, events: eventsResult.results.map((row) => ({ id: String(row.id), runId: row.run_id === null ? null : String(row.run_id), level: String(row.level), eventType: String(row.event_type), stage: String(row.stage), message: String(row.message), createdAt: String(row.created_at) })), methods: FORECAST_METHOD_REGISTRY, warning: null,
  };
}

export async function enforceForecastRetention(bindings = forecastBindings()): Promise<void> {
  if (!bindings) return;
  const config = retentionConfig();
  const now = Date.now();
  const cutoff = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const pointer = await bindings.DB.prepare("SELECT value FROM economic_forecast_state WHERE key = 'latest_accepted_run_id'").first<{ value: string }>();
  const expired = await bindings.DB.prepare("SELECT run_id, snapshot_key, csv_key, report_key, draws_key FROM economic_forecast_runs WHERE run_id != COALESCE(?, '') AND ((accepted = 1 AND created_at < ?) OR (accepted = 0 AND created_at < ?)) LIMIT 100").bind(pointer?.value ?? null, cutoff(config.acceptedDays), cutoff(config.failedDays)).all<D1Row>();
  for (const row of expired.results) {
    const keys = [row.snapshot_key, row.csv_key, row.report_key, row.draws_key].filter(Boolean).map(String);
    if (keys.length) await bindings.FORECAST_ARTIFACTS.delete(keys);
    await bindings.DB.prepare("DELETE FROM economic_forecast_runs WHERE run_id = ? AND run_id != COALESCE(?, '')").bind(String(row.run_id), pointer?.value ?? null).run();
  }
  const expiredDraws = await bindings.DB.prepare("SELECT run_id, draws_key FROM economic_forecast_runs WHERE draws_key IS NOT NULL AND created_at < ? AND run_id != COALESCE(?, '') LIMIT 100").bind(cutoff(config.fullDrawDays), pointer?.value ?? null).all<D1Row>();
  for (const row of expiredDraws.results) {
    await bindings.FORECAST_ARTIFACTS.delete(String(row.draws_key));
    await bindings.DB.prepare("UPDATE economic_forecast_runs SET draws_key = NULL WHERE run_id = ?").bind(String(row.run_id)).run();
  }
  await bindings.DB.prepare("DELETE FROM economic_forecast_events WHERE created_at < ?").bind(cutoff(config.eventDays)).run();
}

export async function recordForecastFailure(event: { runId?: string; stage: string; code: string; message: string }): Promise<void> {
  const bindings = forecastBindings();
  if (!bindings) throw new Error("Forecast persistence bindings are unavailable.");
  const now = new Date().toISOString();
  const previousFailures = Number((await bindings.DB.prepare("SELECT value FROM economic_forecast_state WHERE key = 'consecutive_acceptance_failures'").first<{ value: string }>())?.value ?? "0");
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO economic_forecast_events (id, run_id, level, event_type, stage, message, details_json, created_at) VALUES (?, ?, 'error', 'forecast.failed', ?, ?, ?, ?)").bind(crypto.randomUUID(), event.runId ?? null, sanitizeOperationalText(event.stage), sanitizeOperationalText(event.message), JSON.stringify({ code: sanitizeOperationalText(event.code) }), now),
    stateStatement(bindings.DB, "last_attempt_at", now, now),
    stateStatement(bindings.DB, "consecutive_acceptance_failures", String(previousFailures + 1), now),
  ]);
}

export async function persistOfficialReleaseCalendar(payload: { sourceName: string; sourceUrl: string; sourceRevision: string; fetchedAt: string; releases: Array<{ releaseId: string; seriesId: string; releaseTimestamp: string }> }): Promise<number> {
  const bindings = forecastBindings();
  if (!bindings) throw new Error("Forecast persistence bindings are unavailable.");
  if (!payload.sourceName.toLowerCase().includes("official") || !/^https:\/\//.test(payload.sourceUrl)) throw new Error("Calendar provenance must identify an official HTTPS source.");
  if (!Number.isFinite(Date.parse(payload.fetchedAt))) throw new Error("Calendar fetchedAt is invalid.");
  const now = new Date().toISOString();
  const statements = payload.releases.map((release) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(release.releaseId) || !Number.isFinite(Date.parse(release.releaseTimestamp))) throw new Error("Calendar release is invalid.");
    return bindings.DB.prepare("INSERT INTO economic_release_calendar (release_id, series_id, release_timestamp, source_name, source_url, source_revision, fetched_at, status, triggered_run_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, ?) ON CONFLICT(release_id) DO UPDATE SET series_id = excluded.series_id, release_timestamp = excluded.release_timestamp, source_name = excluded.source_name, source_url = excluded.source_url, source_revision = excluded.source_revision, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at").bind(release.releaseId, release.seriesId, release.releaseTimestamp, payload.sourceName.slice(0, 120), payload.sourceUrl.slice(0, 500), payload.sourceRevision.slice(0, 120), payload.fetchedAt, now);
  });
  if (statements.length) await bindings.DB.batch(statements);
  return statements.length;
}

export async function readForecastArtifact(runId: string, kind: "snapshot" | "csv" | "report" | "draws"): Promise<R2ObjectBody | null> {
  const bindings = forecastBindings();
  if (!bindings) return null;
  immutableArtifactPrefix(runId);
  const column = { snapshot: "snapshot_key", csv: "csv_key", report: "report_key", draws: "draws_key" }[kind];
  const row = await bindings.DB.prepare(`SELECT ${column} AS artifact_key FROM economic_forecast_runs WHERE run_id = ?`).bind(runId).first<{ artifact_key: string | null }>();
  return row?.artifact_key ? bindings.FORECAST_ARTIFACTS.get(row.artifact_key) : null;
}
