export type EconomicForecastFreshness = "current" | "stale" | "failed" | "sample";
export type EconomicForecastStatus = "accepted" | "experimental" | "sample" | "failed";
export type EconomicForecastSource = "live" | "last-known-good" | "bundled-fallback";

export interface EconomicForecastModelMetrics {
  rmsePct: number;
  maePct: number;
  directionalAccuracy: number;
  hitRateVsNaive: number;
  naiveRmsePct: number;
  beatsNaiveRmse: boolean;
}

export interface EconomicForecastModel {
  id: "ridge" | "lightgbm";
  label: string;
  selected: boolean;
  pointForecastPct: number;
  impliedIndex: number | null;
  metrics: EconomicForecastModelMetrics;
}

export interface EconomicForecastHistoryPoint {
  date: string;
  availabilityDate?: string;
  foldId?: number;
  actualPct: number;
  predictionPct: number;
  naivePct: number;
}

export interface EconomicForecastHistogramBin {
  lowerPct: number;
  upperPct: number;
  count: number;
  density?: number;
}

export interface EconomicForecastCoverage {
  nominal: number;
  observed: number | null;
  averageIntervalWidthPct: number | null;
  sampleSize: number;
  acceptanceTolerance: number | null;
  accepted: boolean;
}

export interface EconomicForecastFold {
  foldId: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  observations: number;
  rmsePct: number;
  maePct: number;
  directionalAccuracy: number;
  hitRateVsNaive: number;
  beatsNaiveRmse: boolean;
}

export interface EconomicForecastSnapshot {
  schemaVersion: string;
  runId: string;
  status: EconomicForecastStatus;
  freshness: EconomicForecastFreshness;
  generatedAt: string;
  freshnessMessage: string;
  target: {
    seriesId: string;
    label: string;
    unit: "percent";
    referenceDate: string;
    releaseTimestamp: string;
    horizonMonths: number;
  };
  latestObservation: {
    referenceDate: string;
    availableTimestamp: string;
    indexValue: number | null;
    momPct: number | null;
  };
  selectedModelId: EconomicForecastModel["id"];
  models: EconomicForecastModel[];
  distribution: {
    status: "accepted" | "sample-not-validated";
    accepted: boolean;
    method: string;
    methodVersion: string;
    drawCount: number;
    seed: number;
    residualObservationCount: number;
    residualWindowLabel: string;
    drawDigestSha256?: string;
    densityEligible: boolean;
    p10Pct: number;
    p25Pct: number;
    p50Pct: number;
    p75Pct: number;
    p90Pct: number;
    meanPct: number;
    standardDeviationPct: number;
    thresholdProbabilities: Array<{
      thresholdPct: number;
      probabilityAbove: number;
      probabilityBelow: number;
    }>;
    histogram: EconomicForecastHistogramBin[];
    coverage: EconomicForecastCoverage[];
    warnings: string[];
  };
  history: EconomicForecastHistoryPoint[];
  folds: EconomicForecastFold[];
  naiveComparison: string;
  drivers: Array<{
    label: string;
    detail: string;
    classification: "observed" | "lagged" | "derived";
  }>;
  provenance: {
    sourceFiles: string[];
    sourceSeries: string[];
    dataSource: string;
    modelVersion: string;
    modelSeed: number;
    validation: string;
    limitation: string;
  };
}

export interface EconomicForecastApiResponse {
  snapshot: EconomicForecastSnapshot;
  source: EconomicForecastSource;
  servedAt: string;
  stale: boolean;
  warning: string | null;
  refresh: {
    enabled: boolean;
    reason: string | null;
  };
}

export interface EconomicForecastRefreshJob {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  message: string;
  runId?: string;
  updatedAt: string;
}
