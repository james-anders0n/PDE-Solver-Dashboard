import {
  CPI_PDE_MAPPING_VERSION,
  CPI_POLICY_ADAPTER_VERSION,
  createCpiPdeScenarioHandoff,
} from "./economic-forecast/cpi-scenario.ts";
import type { EconomicForecastSnapshot } from "./economic-forecast/types.ts";
import {
  solveBlackScholesProduct,
  solveHestonEuropean,
  solveMertonHjb,
  solveShortRateProduct,
} from "./pde-engine/index.ts";
import type { SolverJob } from "./solver-jobs.ts";

export const PARAMETER_UNCERTAINTY_METHOD = "cpi-parameter-uncertainty-propagation";
export const PARAMETER_UNCERTAINTY_VERSION = "1.0.0";
export const PARAMETER_UNCERTAINTY_MIN_BUDGET = 32;
export const PARAMETER_UNCERTAINTY_MAX_BUDGET = 256;

export interface ParameterUncertaintyConfig {
  sampleBudget: number;
  seed: number;
  outputHistogramBins: number;
}

export interface ParameterUncertaintyConvergenceGate {
  accepted: boolean;
  source: "current deterministic PDE result";
  pointwiseError: number;
  maxNormError: number;
  domainExpansionDelta: number;
  observedOrder: number | null;
}

export interface ParameterUncertaintyRequest {
  snapshot: EconomicForecastSnapshot;
  baseJob: SolverJob;
  config: ParameterUncertaintyConfig;
  convergenceGate: ParameterUncertaintyConvergenceGate;
}

export interface ParameterUncertaintyTrace {
  traceId: string;
  sampleIndex: number;
  sourceHistogramBin: number;
  sourceRank: number;
  cpiOutcomePct: number;
  policyRateScenario: number;
  targetParameter: string;
  baseParameterValue: number;
  mappedParameterValue: number;
  mappingClamped: boolean;
  mappingVersion: string;
  deterministicOutput: number;
}

export interface ParameterUncertaintySummary {
  minimum: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  maximum: number;
  mean: number;
  standardDeviation: number;
}

export interface ParameterUncertaintyHistogramBin {
  lower: number;
  upper: number;
  count: number;
}

export interface ParameterUncertaintyResult {
  method: string;
  methodVersion: string;
  classification: "parameter-uncertainty propagation";
  disclaimer: string;
  outputLabel: "PDE price" | "HJB value";
  model: SolverJob["model"];
  forecastRunId: string;
  sourceDistributionMethod: string;
  sourceDistributionVersion: string;
  sourceDistributionSeed: number;
  propagationSeed: number;
  mappingVersion: string;
  sampleBudget: number;
  dependenceMethod: "single CPI variable; no independence assumption";
  convergenceGate: ParameterUncertaintyConvergenceGate;
  stability: {
    smallerBudget: number;
    largerBudget: number;
    meanAbsoluteChange: number;
    medianAbsoluteChange: number;
    tolerance: number;
    stable: boolean;
  };
  summary: ParameterUncertaintySummary;
  histogram: ParameterUncertaintyHistogramBin[];
  traces: ParameterUncertaintyTrace[];
}

const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
};

const linearQuantile = (sorted: readonly number[], probability: number) => {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.min(lower + 1, sorted.length - 1)] * weight;
};

function summarize(values: readonly number[]): ParameterUncertaintySummary {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    minimum: sorted[0],
    p10: linearQuantile(sorted, 0.1),
    p25: linearQuantile(sorted, 0.25),
    p50: linearQuantile(sorted, 0.5),
    p75: linearQuantile(sorted, 0.75),
    p90: linearQuantile(sorted, 0.9),
    maximum: sorted.at(-1) as number,
    mean,
    standardDeviation: Math.sqrt(variance),
  };
}

function outputHistogram(values: readonly number[], binCount: number): ParameterUncertaintyHistogramBin[] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const width = Math.max((maximum - minimum) / binCount, Math.max(Math.abs(minimum), 1) * 1e-12);
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: minimum + index * width,
    upper: index === binCount - 1 ? Math.max(maximum, minimum + (index + 1) * width) : minimum + (index + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - minimum) / width)));
    bins[index].count += 1;
  }
  return bins;
}

function solveMappedJob(job: SolverJob, targetParameter: string, mappedValue: number): number {
  const request = { ...job.request, [targetParameter]: mappedValue };
  if (job.model === "Black–Scholes") return solveBlackScholesProduct(request as typeof job.request).price;
  if (job.model === "Heston") return solveHestonEuropean(request as typeof job.request).price;
  if (job.model === "HJB") return solveMertonHjb(request as typeof job.request).price;
  return solveShortRateProduct(request as typeof job.request).price;
}

function sampledCpiOutcomes(snapshot: EconomicForecastSnapshot, budget: number, seed: number) {
  const histogram = snapshot.distribution.histogram;
  const total = histogram.reduce((sum, bin) => sum + bin.count, 0);
  const random = mulberry32((seed ^ snapshot.distribution.seed) >>> 0);
  return Array.from({ length: budget }, (_, sampleIndex) => {
    const sourceRank = (sampleIndex + random()) / budget * total;
    let cumulative = 0;
    let sourceHistogramBin = histogram.length - 1;
    for (let index = 0; index < histogram.length; index += 1) {
      cumulative += histogram[index].count;
      if (sourceRank < cumulative) {
        sourceHistogramBin = index;
        break;
      }
    }
    const bin = histogram[sourceHistogramBin];
    return {
      sampleIndex,
      sourceRank,
      sourceHistogramBin,
      cpiOutcomePct: bin.lowerPct + random() * (bin.upperPct - bin.lowerPct),
    };
  });
}

function validateRequest(request: ParameterUncertaintyRequest): void {
  const { snapshot, config, convergenceGate } = request;
  if (snapshot.status !== "accepted" || snapshot.freshness !== "current" || !snapshot.distribution.accepted) {
    throw new Error("Parameter-uncertainty propagation requires a current accepted forecast distribution.");
  }
  if (snapshot.distribution.residualObservationCount < 36) throw new Error("At least 36 eligible OOS residuals are required.");
  if (!convergenceGate.accepted) throw new Error("The current deterministic PDE convergence gate must pass before propagation.");
  if (!Number.isInteger(config.sampleBudget) || config.sampleBudget < PARAMETER_UNCERTAINTY_MIN_BUDGET || config.sampleBudget > PARAMETER_UNCERTAINTY_MAX_BUDGET) {
    throw new Error(`Sample budget must be an integer between ${PARAMETER_UNCERTAINTY_MIN_BUDGET} and ${PARAMETER_UNCERTAINTY_MAX_BUDGET}.`);
  }
  if (!Number.isInteger(config.seed) || config.seed < 0) throw new Error("Propagation seed must be a non-negative integer.");
  if (!Number.isInteger(config.outputHistogramBins) || config.outputHistogramBins < 12 || config.outputHistogramBins > 40) {
    throw new Error("Output histogram must contain 12 to 40 bins.");
  }
  if (request.baseJob.monteCarlo?.enabled) throw new Error("Path Monte Carlo must be disabled for parameter-uncertainty propagation.");
}

export function runParameterUncertaintyPropagation(
  request: ParameterUncertaintyRequest,
  reportProgress: (progress: number, stage: string) => void = () => {},
  isCancelled: () => boolean = () => false,
): ParameterUncertaintyResult {
  validateRequest(request);
  const { snapshot, baseJob, config } = request;
  const outcomes = sampledCpiOutcomes(snapshot, config.sampleBudget, config.seed);
  const traces: ParameterUncertaintyTrace[] = [];
  reportProgress(4, `Sampling ${config.sampleBudget} CPI outcomes from compact accepted histogram bins`);
  for (const outcome of outcomes) {
    if (isCancelled()) throw new Error("Parameter-uncertainty propagation cancelled.");
    const handoff = createCpiPdeScenarioHandoff({
      snapshot,
      model: baseJob.model,
      calibratedParameters: baseJob.request as unknown as Record<string, string | number>,
      quantile: "draw",
      cpiOutcomePct: outcome.cpiOutcomePct,
    });
    if (!handoff.eligible || handoff.affectedParameters.length !== 1) {
      throw new Error(handoff.blockingIssues.join(" ") || "The sampled CPI outcome did not produce one auditable PDE parameter mapping.");
    }
    const affected = handoff.affectedParameters[0];
    traces.push({
      traceId: `${snapshot.runId}:${PARAMETER_UNCERTAINTY_VERSION}:${config.seed}:${outcome.sampleIndex}`,
      ...outcome,
      policyRateScenario: handoff.scenarioInputs.policyRateForecast,
      targetParameter: affected.id,
      baseParameterValue: Number(affected.baseValue),
      mappedParameterValue: affected.scenarioValue,
      mappingClamped: affected.clamped || handoff.policyRateClamped,
      mappingVersion: handoff.mappingVersion,
      deterministicOutput: solveMappedJob(baseJob, affected.id, affected.scenarioValue),
    });
    if ((outcome.sampleIndex + 1) % Math.max(1, Math.floor(config.sampleBudget / 20)) === 0) {
      reportProgress(8 + Math.round((outcome.sampleIndex + 1) / config.sampleBudget * 84), `Solved ${outcome.sampleIndex + 1} of ${config.sampleBudget} deterministic parameter sets`);
    }
  }
  const values = traces.map((trace) => trace.deterministicOutput);
  const summary = summarize(values);
  const smallerBudget = Math.floor(config.sampleBudget / 2);
  // Stratified draws are ordered by distribution rank, so an interleaved subset
  // preserves the full support while representing the documented half budget.
  const smallerSummary = summarize(values.filter((_, index) => index % 2 === 0).slice(0, smallerBudget));
  const tolerance = Math.max(1e-6, summary.standardDeviation * 0.15, Math.abs(summary.mean) * 2e-4);
  const meanAbsoluteChange = Math.abs(summary.mean - smallerSummary.mean);
  const medianAbsoluteChange = Math.abs(summary.p50 - smallerSummary.p50);
  reportProgress(96, "Summarising output distribution and half-versus-full budget stability");
  return {
    method: PARAMETER_UNCERTAINTY_METHOD,
    methodVersion: PARAMETER_UNCERTAINTY_VERSION,
    adapterVersion: CPI_POLICY_ADAPTER_VERSION,
    bridgeMappingVersion: CPI_PDE_MAPPING_VERSION,
    classification: "parameter-uncertainty propagation",
    disclaimer: "Neither a risk-neutral price-path simulation nor a market-calibrated price distribution.",
    outputLabel: baseJob.model === "HJB" ? "HJB value" : "PDE price",
    model: baseJob.model,
    forecastRunId: snapshot.runId,
    sourceDistributionMethod: snapshot.distribution.method,
    sourceDistributionVersion: snapshot.distribution.methodVersion,
    sourceDistributionSeed: snapshot.distribution.seed,
    propagationSeed: config.seed,
    mappingVersion: traces[0].mappingVersion,
    sampleBudget: config.sampleBudget,
    dependenceMethod: "single CPI variable; no independence assumption",
    convergenceGate: request.convergenceGate,
    stability: {
      smallerBudget,
      largerBudget: config.sampleBudget,
      meanAbsoluteChange,
      medianAbsoluteChange,
      tolerance,
      stable: meanAbsoluteChange <= tolerance && medianAbsoluteChange <= tolerance,
    },
    summary,
    histogram: outputHistogram(values, config.outputHistogramBins),
    traces,
  };
}

function sortForKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForKey);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortForKey(entry)]));
  return value;
}

export function createParameterUncertaintyKey(request: ParameterUncertaintyRequest): string {
  return JSON.stringify(sortForKey({
    methodVersion: PARAMETER_UNCERTAINTY_VERSION,
    forecastRunId: request.snapshot.runId,
    sourceDistributionMethod: request.snapshot.distribution.method,
    sourceDistributionVersion: request.snapshot.distribution.methodVersion,
    sourceDistributionSeed: request.snapshot.distribution.seed,
    histogram: request.snapshot.distribution.histogram,
    baseJob: request.baseJob,
    config: request.config,
    convergenceGate: request.convergenceGate,
  }));
}
