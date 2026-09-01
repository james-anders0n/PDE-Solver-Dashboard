import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const economicForecastRuns = sqliteTable("economic_forecast_runs", {
  runId: text("run_id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull(),
  contentSha256: text("content_sha256").notNull(),
  status: text("status", { enum: ["accepted", "rejected", "failed"] }).notNull(),
  accepted: integer("accepted", { mode: "boolean" }).notNull(),
  generatedAt: text("generated_at").notNull(),
  targetReferenceDate: text("target_reference_date").notNull(),
  targetReleaseTimestamp: text("target_release_timestamp").notNull(),
  modelId: text("model_id").notNull(),
  modelVersion: text("model_version").notNull(),
  distributionMethod: text("distribution_method").notNull(),
  distributionMethodVersion: text("distribution_method_version").notNull(),
  seed: integer("seed").notNull(),
  drawCount: integer("draw_count").notNull(),
  residualCount: integer("residual_count").notNull(),
  residualDateRange: text("residual_date_range").notNull(),
  p10Pct: real("p10_pct").notNull(),
  p25Pct: real("p25_pct").notNull(),
  p50Pct: real("p50_pct").notNull(),
  p75Pct: real("p75_pct").notNull(),
  p90Pct: real("p90_pct").notNull(),
  meanPct: real("mean_pct").notNull(),
  standardDeviationPct: real("standard_deviation_pct").notNull(),
  coverage50: real("coverage_50"),
  coverage80: real("coverage_80"),
  coverage90: real("coverage_90"),
  intervalWidth50Pct: real("interval_width_50_pct"),
  intervalWidth80Pct: real("interval_width_80_pct"),
  intervalWidth90Pct: real("interval_width_90_pct"),
  warningsJson: text("warnings_json").notNull(),
  failureStage: text("failure_stage"),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  snapshotKey: text("snapshot_key").notNull(),
  csvKey: text("csv_key"),
  reportKey: text("report_key"),
  drawsKey: text("draws_key"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("economic_forecast_runs_dedupe_key_unique").on(table.dedupeKey),
  index("economic_forecast_runs_generated_at_idx").on(table.generatedAt),
  index("economic_forecast_runs_status_generated_idx").on(table.status, table.generatedAt),
  index("economic_forecast_runs_target_idx").on(table.targetReferenceDate),
]);

export const economicForecastState = sqliteTable("economic_forecast_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const economicForecastEvents = sqliteTable("economic_forecast_events", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  level: text("level", { enum: ["info", "warning", "error"] }).notNull(),
  eventType: text("event_type").notNull(),
  stage: text("stage").notNull(),
  message: text("message").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("economic_forecast_events_created_at_idx").on(table.createdAt),
  index("economic_forecast_events_run_idx").on(table.runId, table.createdAt),
]);

export const economicReleaseCalendar = sqliteTable("economic_release_calendar", {
  releaseId: text("release_id").primaryKey(),
  seriesId: text("series_id").notNull(),
  releaseTimestamp: text("release_timestamp").notNull(),
  sourceName: text("source_name").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceRevision: text("source_revision").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  status: text("status", { enum: ["scheduled", "triggered", "completed", "missed"] }).notNull(),
  triggeredRunId: text("triggered_run_id"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("economic_release_calendar_timestamp_idx").on(table.releaseTimestamp),
  index("economic_release_calendar_status_idx").on(table.status, table.releaseTimestamp),
]);
