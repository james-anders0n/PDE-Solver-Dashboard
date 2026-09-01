import type { EconomicForecastSnapshot } from "./types.ts";

export type ForecastRunState = "accepted" | "rejected" | "failed";

export interface EconomicForecastRunRecord {
  runId: string;
  status: ForecastRunState;
  accepted: boolean;
  generatedAt: string;
  targetReferenceDate: string;
  targetReleaseTimestamp: string;
  modelId: string;
  modelVersion: string;
  distributionMethod: string;
  distributionMethodVersion: string;
  seed: number;
  drawCount: number;
  residualCount: number;
  residualDateRange: string;
  p10Pct: number;
  p50Pct: number;
  p90Pct: number;
  meanPct: number;
  standardDeviationPct: number;
  coverage50: number | null;
  coverage80: number | null;
  coverage90: number | null;
  warnings: string[];
  failureStage: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  artifacts: { snapshot: boolean; csv: boolean; report: boolean; fullDraws: boolean };
}

export interface EconomicForecastOperationsResponse {
  storage: { available: boolean; d1: string; r2: string };
  health: "healthy" | "warning" | "degraded" | "initialising";
  latestAcceptedRunId: string | null;
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
  consecutiveAcceptanceFailures: number;
  monitors: Array<{ id: string; status: "ok" | "warning" | "critical"; label: string; detail: string }>;
  schedule: {
    mode: "official-release-calendar";
    nextReleaseTimestamp: string | null;
    sourceName: string | null;
    sourceUrl: string | null;
    message: string;
  };
  retention: { acceptedDays: number; failedDays: number; eventDays: number; fullDrawDays: number; latestProtected: true };
  runs: EconomicForecastRunRecord[];
  events: Array<{ id: string; runId: string | null; level: string; eventType: string; stage: string; message: string; createdAt: string }>;
  methods: Array<{ id: string; version: string; status: "baseline" | "follow-up"; enabled: boolean; comparisonRequired: boolean; description: string }>;
  warning: string | null;
}

export const FORECAST_METHOD_REGISTRY: EconomicForecastOperationsResponse["methods"] = [
  { id: "signed-oos-residual-bootstrap", version: "1.0.0", status: "baseline", enabled: true, comparisonRequired: false, description: "Accepted baseline using genuine expanding-window OOS residuals." },
  { id: "model-mixture", version: "0.1.0", status: "follow-up", enabled: false, comparisonRequired: true, description: "Versioned candidate; compare calibration and baseline skill before activation." },
  { id: "direct-quantile", version: "0.1.0", status: "follow-up", enabled: false, comparisonRequired: true, description: "Versioned candidate for direct conditional quantiles." },
  { id: "conformal", version: "0.1.0", status: "follow-up", enabled: false, comparisonRequired: true, description: "Versioned candidate with point-in-time calibration windows." },
  { id: "bootstrap-refit", version: "0.1.0", status: "follow-up", enabled: false, comparisonRequired: true, description: "Versioned candidate that refits within each bootstrap replicate." },
  { id: "vintage-revision", version: "0.1.0", status: "follow-up", enabled: false, comparisonRequired: true, description: "Versioned candidate modelling data-vintage revision uncertainty." },
];

export function compactRunRecord(snapshot: EconomicForecastSnapshot, failure?: { stage?: string; code?: string; message?: string }): Omit<EconomicForecastRunRecord, "artifacts"> {
  const coverage = (nominal: number) => snapshot.distribution.coverage.find((item) => item.nominal === nominal)?.observed ?? null;
  const accepted = snapshot.status === "accepted" && snapshot.distribution.accepted && snapshot.distribution.coverage.every((item) => item.accepted);
  return {
    runId: snapshot.runId,
    status: accepted ? "accepted" : failure?.code === "runtime-failure" ? "failed" : "rejected",
    accepted,
    generatedAt: snapshot.generatedAt,
    targetReferenceDate: snapshot.target.referenceDate,
    targetReleaseTimestamp: snapshot.target.releaseTimestamp,
    modelId: snapshot.selectedModelId,
    modelVersion: snapshot.provenance.modelVersion,
    distributionMethod: snapshot.distribution.method,
    distributionMethodVersion: snapshot.distribution.methodVersion,
    seed: snapshot.distribution.seed,
    drawCount: snapshot.distribution.drawCount,
    residualCount: snapshot.distribution.residualObservationCount,
    residualDateRange: snapshot.distribution.residualWindowLabel,
    p10Pct: snapshot.distribution.p10Pct,
    p50Pct: snapshot.distribution.p50Pct,
    p90Pct: snapshot.distribution.p90Pct,
    meanPct: snapshot.distribution.meanPct,
    standardDeviationPct: snapshot.distribution.standardDeviationPct,
    coverage50: coverage(0.5),
    coverage80: coverage(0.8),
    coverage90: coverage(0.9),
    warnings: snapshot.distribution.warnings,
    failureStage: failure?.stage ?? null,
    failureCode: failure?.code ?? null,
    failureMessage: failure?.message ? sanitizeOperationalText(failure.message) : null,
  };
}

export function sanitizeOperationalText(value: string): string {
  return value
    .replace(/(bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[REDACTED]")
    .slice(0, 500);
}

export function immutableArtifactPrefix(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(runId)) throw new Error("Invalid immutable forecast run ID.");
  return `economic-forecast/runs/${runId}`;
}
