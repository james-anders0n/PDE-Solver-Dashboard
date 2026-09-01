CREATE TABLE `economic_forecast_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`level` text NOT NULL,
	`event_type` text NOT NULL,
	`stage` text NOT NULL,
	`message` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `economic_forecast_events_created_at_idx` ON `economic_forecast_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `economic_forecast_events_run_idx` ON `economic_forecast_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `economic_forecast_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`content_sha256` text NOT NULL,
	`status` text NOT NULL,
	`accepted` integer NOT NULL,
	`generated_at` text NOT NULL,
	`target_reference_date` text NOT NULL,
	`target_release_timestamp` text NOT NULL,
	`model_id` text NOT NULL,
	`model_version` text NOT NULL,
	`distribution_method` text NOT NULL,
	`distribution_method_version` text NOT NULL,
	`seed` integer NOT NULL,
	`draw_count` integer NOT NULL,
	`residual_count` integer NOT NULL,
	`residual_date_range` text NOT NULL,
	`p10_pct` real NOT NULL,
	`p25_pct` real NOT NULL,
	`p50_pct` real NOT NULL,
	`p75_pct` real NOT NULL,
	`p90_pct` real NOT NULL,
	`mean_pct` real NOT NULL,
	`standard_deviation_pct` real NOT NULL,
	`coverage_50` real,
	`coverage_80` real,
	`coverage_90` real,
	`interval_width_50_pct` real,
	`interval_width_80_pct` real,
	`interval_width_90_pct` real,
	`warnings_json` text NOT NULL,
	`failure_stage` text,
	`failure_code` text,
	`failure_message` text,
	`snapshot_key` text NOT NULL,
	`csv_key` text,
	`report_key` text,
	`draws_key` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economic_forecast_runs_dedupe_key_unique` ON `economic_forecast_runs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `economic_forecast_runs_generated_at_idx` ON `economic_forecast_runs` (`generated_at`);--> statement-breakpoint
CREATE INDEX `economic_forecast_runs_status_generated_idx` ON `economic_forecast_runs` (`status`,`generated_at`);--> statement-breakpoint
CREATE INDEX `economic_forecast_runs_target_idx` ON `economic_forecast_runs` (`target_reference_date`);--> statement-breakpoint
CREATE TABLE `economic_forecast_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `economic_release_calendar` (
	`release_id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`release_timestamp` text NOT NULL,
	`source_name` text NOT NULL,
	`source_url` text NOT NULL,
	`source_revision` text NOT NULL,
	`fetched_at` text NOT NULL,
	`status` text NOT NULL,
	`triggered_run_id` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `economic_release_calendar_timestamp_idx` ON `economic_release_calendar` (`release_timestamp`);--> statement-breakpoint
CREATE INDEX `economic_release_calendar_status_idx` ON `economic_release_calendar` (`status`,`release_timestamp`);