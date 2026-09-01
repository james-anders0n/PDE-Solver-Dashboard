import type {
  EconomicForecastCoverage,
  EconomicForecastFold,
  EconomicForecastHistoryPoint,
  EconomicForecastSnapshot,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
};
const number = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
};

export function validateEconomicForecastSnapshot(value: unknown): EconomicForecastSnapshot {
  const candidate = isDashboardSnapshot(value) ? value as EconomicForecastSnapshot : adaptPhaseTwoSnapshot(value);
  const histogram = candidate.distribution.histogram;
  if (histogram.length < 30 || histogram.length > 50) throw new Error("Forecast histogram must contain 30–50 compact bins.");
  const histogramTotal = histogram.reduce((sum, bin) => sum + number(bin.count, "histogram count"), 0);
  if (histogramTotal !== candidate.distribution.drawCount) throw new Error("Forecast histogram counts must equal drawCount.");
  const quantiles = [candidate.distribution.p10Pct, candidate.distribution.p25Pct, candidate.distribution.p50Pct, candidate.distribution.p75Pct, candidate.distribution.p90Pct];
  if (quantiles.some((item) => !Number.isFinite(item)) || quantiles.some((item, index) => index > 0 && item < quantiles[index - 1])) {
    throw new Error("Forecast quantiles must be finite and ordered.");
  }
  if (candidate.distribution.drawCount !== 10_000) throw new Error("Browser snapshot must summarize exactly 10,000 server-generated draws.");
  if (candidate.distribution.coverage.map((item) => item.nominal).join(",") !== "0.5,0.8,0.9") {
    throw new Error("Forecast snapshot must include 50%, 80%, and 90% coverage.");
  }
  if (candidate.status === "accepted" && (!candidate.distribution.accepted || candidate.distribution.coverage.some((item) => !item.accepted))) {
    throw new Error("An accepted forecast must pass its distribution and coverage gates.");
  }
  return candidate;
}

const isDashboardSnapshot = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const distribution = (value as JsonObject).distribution;
  return Boolean(distribution && typeof distribution === "object" && "p10Pct" in distribution);
};

function adaptPhaseTwoSnapshot(value: unknown): EconomicForecastSnapshot {
  const root = object(value, "snapshot");
  const target = object(root.target, "target");
  const point = object(root.pointForecast, "pointForecast");
  const distribution = object(root.distribution, "distribution");
  const quantiles = object(distribution.quantiles, "distribution.quantiles");
  const model = object(root.model, "model");
  const metrics = object(root.metrics, "metrics");
  const provenance = object(root.provenance, "provenance");
  const backtest = object(root.backtest, "backtest");
  const history = array(backtest.history, "backtest.history").slice(-120).map((item): EconomicForecastHistoryPoint => {
    const row = object(item, "history row");
    return {
      date: string(row.targetDate, "history targetDate"),
      availabilityDate: string(row.availabilityDate, "history availabilityDate"),
      foldId: number(row.foldId, "history foldId"),
      actualPct: number(row.actual, "history actual") * 100,
      predictionPct: number(row.prediction, "history prediction") * 100,
      naivePct: number(row.naivePrediction, "history naivePrediction") * 100,
    };
  });
  const folds = array(backtest.folds, "backtest.folds").map((item): EconomicForecastFold => {
    const row = object(item, "fold row");
    return {
      foldId: number(row.foldId, "foldId"),
      trainStart: string(row.trainStart, "trainStart"),
      trainEnd: string(row.trainEnd, "trainEnd"),
      testStart: string(row.testStart, "testStart"),
      testEnd: string(row.testEnd, "testEnd"),
      observations: number(row.observations, "observations"),
      rmsePct: number(row.rmse, "rmse") * 100,
      maePct: number(row.mae, "mae") * 100,
      directionalAccuracy: number(row.directionalAccuracy, "directionalAccuracy"),
      hitRateVsNaive: number(row.hitRateVsNaive, "hitRateVsNaive"),
      beatsNaiveRmse: Boolean(row.modelBeatsNaiveRmse),
    };
  });
  const coverage = array(distribution.coverage, "distribution.coverage").map((item): EconomicForecastCoverage => {
    const row = object(item, "coverage row");
    return {
      nominal: number(row.nominal, "coverage nominal"),
      observed: row.observed === null ? null : number(row.observed, "coverage observed"),
      averageIntervalWidthPct: row.averageIntervalWidth === null ? null : number(row.averageIntervalWidth, "coverage width") * 100,
      sampleSize: number(row.sampleSize, "coverage sampleSize"),
      acceptanceTolerance: row.acceptanceTolerance === null ? null : number(row.acceptanceTolerance, "coverage tolerance"),
      accepted: Boolean(row.accepted),
    };
  });
  const histogram = array(distribution.histogram, "distribution.histogram").map((item) => {
    const row = object(item, "histogram row");
    return { lowerPct: number(row.lower, "histogram lower") * 100, upperPct: number(row.upper, "histogram upper") * 100, count: number(row.count, "histogram count") };
  });
  const thresholds = array(distribution.thresholdProbabilities, "threshold probabilities").map((item) => {
    const row = object(item, "threshold probability");
    return { thresholdPct: number(row.threshold, "threshold") * 100, probabilityAbove: number(row.probabilityAbove, "probabilityAbove"), probabilityBelow: number(row.probabilityBelow, "probabilityBelow") };
  });
  const selectedModel = string(model.name, "model.name") as "ridge" | "lightgbm";
  const latest = history.at(-1);
  return {
    schemaVersion: string(root.schemaVersion, "schemaVersion"),
    runId: string(root.runId, "runId"),
    status: root.status === "accepted" ? "accepted" : "failed",
    freshness: root.status === "accepted" ? "current" : "failed",
    generatedAt: string(root.generatedAt, "generatedAt"),
    freshnessMessage: root.status === "accepted" ? "Latest accepted point-in-time forecast snapshot." : "Latest run failed acceptance checks; last accepted snapshot retained.",
    target: { seriesId: string(target.seriesId, "target.seriesId"), label: string(target.label, "target.label"), unit: "percent", referenceDate: string(target.targetDate, "target.targetDate"), releaseTimestamp: string(target.availabilityDate, "target.availabilityDate"), horizonMonths: number(target.horizonMonths, "target.horizonMonths") },
    latestObservation: { referenceDate: latest?.date ?? string(model.trainedThroughObservationDate, "trainedThroughObservationDate"), availableTimestamp: latest?.availabilityDate ?? string(model.trainedThroughObservationDate, "trainedThroughObservationDate"), indexValue: null, momPct: latest?.actualPct ?? null },
    selectedModelId: selectedModel,
    models: [{ id: selectedModel, label: selectedModel === "lightgbm" ? "LightGBM" : "Ridge", selected: true, pointForecastPct: number(point.value, "pointForecast.value") * 100, impliedIndex: null, metrics: { rmsePct: number(metrics.rmse, "metrics.rmse") * 100, maePct: number(metrics.mae, "metrics.mae") * 100, directionalAccuracy: number(metrics.directional_accuracy, "directionalAccuracy"), hitRateVsNaive: number(metrics.hit_rate_vs_naive, "hitRateVsNaive"), naiveRmsePct: number(metrics.naive_rmse, "naiveRmse") * 100, beatsNaiveRmse: Boolean(metrics.beats_naive_rmse) } }],
    distribution: { status: distribution.accepted ? "accepted" : "sample-not-validated", accepted: Boolean(distribution.accepted), method: string(distribution.method, "distribution.method"), methodVersion: string(distribution.methodVersion, "distribution.methodVersion"), drawCount: number(distribution.drawCount, "drawCount"), seed: number(distribution.seed, "seed"), residualObservationCount: number(distribution.residualSampleSize, "residualSampleSize"), residualWindowLabel: `${object(distribution.residualDateRange, "residualDateRange").start} to ${object(distribution.residualDateRange, "residualDateRange").end}`, drawDigestSha256: string(distribution.drawDigestSha256, "drawDigestSha256"), densityEligible: number(distribution.residualSampleSize, "residualSampleSize") >= 36, p10Pct: number(quantiles.p10, "p10") * 100, p25Pct: number(quantiles.p25, "p25") * 100, p50Pct: number(quantiles.p50, "p50") * 100, p75Pct: number(quantiles.p75, "p75") * 100, p90Pct: number(quantiles.p90, "p90") * 100, meanPct: number(distribution.mean, "mean") * 100, standardDeviationPct: number(distribution.standardDeviation, "standardDeviation") * 100, thresholdProbabilities: thresholds, histogram, coverage, warnings: array(distribution.warnings, "warnings").map((item) => String(item)) },
    history,
    folds,
    naiveComparison: string(backtest.naiveComparison, "naiveComparison"),
    drivers: [],
    provenance: { sourceFiles: [string(provenance.inputFile, "inputFile")], sourceSeries: array(provenance.sourceSeries, "sourceSeries").map(String), dataSource: "Point-in-time orchestration snapshot", modelVersion: `${root.pipelineVersion ?? "pipeline"} · ${model.featureSetVersion ?? "feature-set"}`, modelSeed: number(distribution.seed, "seed"), validation: "Walk-forward OOS residuals, deterministic bootstrap, schema and calibration gates passed.", limitation: "Scenario application remains disabled until Phase 4 mapping review." },
  };
}
