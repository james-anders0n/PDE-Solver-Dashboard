import {
  buildEconomicBridge,
  type EconomicBridgeResult,
  type EconomicForecast,
  type EconomicRegime,
} from "../economic-bridge.ts";
import type { ModelKey } from "../pde-spec.ts";
import type { EconomicForecastSnapshot } from "./types.ts";

export const CPI_POLICY_ADAPTER_ID = "cpi-to-policy-rate";
export const CPI_POLICY_ADAPTER_VERSION = "1.0.0";
export const CPI_PDE_MAPPING_ID = "cpi-policy-to-pde";
export const CPI_PDE_MAPPING_VERSION = "1.0.0";

export type CpiScenarioQuantile = "point" | "p10" | "p50" | "p90" | "draw";

export interface CpiScenarioAffectedParameter {
  id: string;
  baseValue: string | number;
  scenarioValue: number;
  measure: "P" | "Q";
  bounds: [number, number];
  clamped: boolean;
  formula: string;
}

export interface CpiScenarioIdentity {
  forecastRunId: string;
  distributionMethod: string;
  distributionMethodVersion: string;
  distributionSeed: number;
  mappingVersion: string;
  scenarioInputs: {
    quantile: CpiScenarioQuantile;
    cpiMomPct: number;
    cpiIntervalPct: [number, number];
    neutralPolicyRate: number;
    annualInflationTarget: number;
    reactionCoefficient: number;
    policyRateForecast: number;
    policyRateInterval: [number, number];
  };
}

export interface CpiPdeScenarioHandoff extends CpiScenarioIdentity {
  id: string;
  model: ModelKey;
  eligible: boolean;
  blockingIssues: string[];
  adapterId: string;
  adapterVersion: string;
  adapterFormula: string;
  uncertaintyTreatment: string;
  policyRateBounds: [number, number];
  rawPolicyRateForecast: number;
  policyRateClamped: boolean;
  sourceTargetDate: string;
  sourceAvailabilityDate: string;
  sourceModelId: string;
  affectedParameters: CpiScenarioAffectedParameter[];
  bridge: EconomicBridgeResult;
}

export interface BuildCpiScenarioOptions {
  snapshot: EconomicForecastSnapshot;
  model: ModelKey;
  calibratedParameters: Record<string, string | number>;
  quantile?: CpiScenarioQuantile;
  cpiOutcomePct?: number;
  neutralPolicyRate?: number;
  annualInflationTarget?: number;
  reactionCoefficient?: number;
  policyRateBounds?: [number, number];
}

const clamp = (value: number, [lower, upper]: [number, number]) => Math.min(upper, Math.max(lower, value));
const isoObservation = (value: string) => value.includes("T") ? value : `${value}T00:00:00Z`;

function quantileValue(snapshot: EconomicForecastSnapshot, quantile: CpiScenarioQuantile, cpiOutcomePct?: number): number {
  if (quantile === "draw") {
    if (!Number.isFinite(cpiOutcomePct)) throw new Error("A finite CPI outcome is required for a sampled draw.");
    return cpiOutcomePct as number;
  }
  if (quantile === "p10") return snapshot.distribution.p10Pct;
  if (quantile === "p50") return snapshot.distribution.p50Pct;
  if (quantile === "p90") return snapshot.distribution.p90Pct;
  const selected = snapshot.models.find((candidate) => candidate.id === snapshot.selectedModelId)
    ?? snapshot.models.find((candidate) => candidate.selected);
  if (!selected) throw new Error("The forecast snapshot has no selected point forecast.");
  return selected.pointForecastPct;
}

function policyRateFromCpi(cpiMomPct: number, neutralPolicyRate: number, annualInflationTarget: number, reactionCoefficient: number): number {
  return neutralPolicyRate + reactionCoefficient * (cpiMomPct / 100 * 12 - annualInflationTarget);
}

export function createCpiPdeScenarioHandoff(options: BuildCpiScenarioOptions): CpiPdeScenarioHandoff {
  const {
    snapshot,
    model,
    calibratedParameters,
    quantile = "p50",
    neutralPolicyRate = 0.03,
    annualInflationTarget = 0.02,
    reactionCoefficient = 0.5,
    policyRateBounds = [-0.05, 0.15],
    cpiOutcomePct,
  } = options;
  const selectedCpiPct = quantileValue(snapshot, quantile, cpiOutcomePct);
  const cpiIntervalPct: [number, number] = [snapshot.distribution.p10Pct, snapshot.distribution.p90Pct];
  const rawPolicyRateForecast = policyRateFromCpi(selectedCpiPct, neutralPolicyRate, annualInflationTarget, reactionCoefficient);
  const policyRateForecast = clamp(rawPolicyRateForecast, policyRateBounds);
  const rawPolicyInterval = cpiIntervalPct.map((value) => policyRateFromCpi(value, neutralPolicyRate, annualInflationTarget, reactionCoefficient)) as [number, number];
  const policyRateInterval: [number, number] = [
    clamp(Math.min(...rawPolicyInterval, policyRateForecast), policyRateBounds),
    clamp(Math.max(...rawPolicyInterval, policyRateForecast), policyRateBounds),
  ];
  const observationTimestamp = isoObservation(snapshot.latestObservation.referenceDate);
  const sourceModelVersion = `${snapshot.provenance.modelVersion} · ${snapshot.distribution.method} ${snapshot.distribution.methodVersion}`;
  const policyForecast: EconomicForecast = {
    id: `policy-rate-${snapshot.runId}-${quantile}`,
    label: `Policy-rate scenario derived from CPI ${quantile.toUpperCase()}`,
    variable: "policy-rate",
    value: policyRateForecast,
    unit: "decimal",
    uncertainty: {
      lower: policyRateInterval[0],
      upper: policyRateInterval[1],
      confidenceLevel: 0.8,
      method: "CPI P10–P90 residual-bootstrap interval passed through the same monotone policy-reaction adapter",
    },
    observationTimestamp,
    availableTimestamp: snapshot.latestObservation.availableTimestamp,
    targetTimestamp: snapshot.target.releaseTimestamp,
    forecastHorizonMonths: snapshot.target.horizonMonths,
    dataVintage: snapshot.generatedAt.slice(0, 10),
    sourceModel: `CPI ${snapshot.selectedModelId} via ${CPI_POLICY_ADAPTER_ID}`,
    sourceModelVersion,
  };
  const regime: EconomicRegime = {
    id: `cpi-policy-${quantile}`,
    label: `CPI ${quantile.toUpperCase()} policy scenario`,
    probability: 1,
    uncertainty: { lower: 1, upper: 1, confidenceLevel: 0.8, method: "User-selected reviewed quantile; not a regime probability estimate" },
    expectedReturnAdjustment: 0,
    volatilityMultiplier: 1,
    rateShift: 0,
    observationTimestamp,
    availableTimestamp: snapshot.latestObservation.availableTimestamp,
    dataVintage: snapshot.generatedAt.slice(0, 10),
    sourceModel: CPI_POLICY_ADAPTER_ID,
    sourceModelVersion: CPI_POLICY_ADAPTER_VERSION,
  };
  const bridge = buildEconomicBridge({
    runAsOfTimestamp: snapshot.generatedAt,
    mappingId: CPI_PDE_MAPPING_ID,
    mappingVersion: CPI_PDE_MAPPING_VERSION,
    forecasts: [policyForecast],
    regimes: [regime],
  }, model, calibratedParameters);
  const scenario = bridge.scenarios[0];
  const affectedParameters = scenario.transformations.flatMap((transformation): CpiScenarioAffectedParameter[] => {
    if (!transformation.targetParameter || transformation.mappedValue === null || !transformation.bounds) return [];
    return [{
      id: transformation.targetParameter,
      baseValue: bridge.calibratedParameters[transformation.targetParameter],
      scenarioValue: transformation.mappedValue,
      measure: transformation.measure,
      bounds: transformation.bounds,
      clamped: transformation.constrained,
      formula: transformation.formula,
    }];
  });
  const blockingIssues = [
    snapshot.status !== "accepted" ? "The source is a cached research fixture, not an accepted snapshot." : null,
    !snapshot.distribution.accepted ? "The forecast distribution has not passed the acceptance contract." : null,
    snapshot.freshness !== "current" ? "The source forecast is stale." : null,
    snapshot.distribution.residualObservationCount < 36 ? "Fewer than 36 eligible walk-forward residuals are available." : null,
    affectedParameters.length === 0 ? `No versioned policy-rate scenario mapping exists for ${model}.` : null,
  ].filter((issue): issue is string => Boolean(issue));
  const mappingVersion = `${CPI_POLICY_ADAPTER_ID}@${CPI_POLICY_ADAPTER_VERSION} → ${bridge.mappingId}@${bridge.mappingVersion}`;
  const scenarioInputs = {
    quantile,
    cpiMomPct: selectedCpiPct,
    cpiIntervalPct,
    neutralPolicyRate,
    annualInflationTarget,
    reactionCoefficient,
    policyRateForecast,
    policyRateInterval,
  };
  return {
    id: `${snapshot.runId}:${model}:${quantile}:${mappingVersion}`,
    model,
    eligible: blockingIssues.length === 0,
    blockingIssues,
    adapterId: CPI_POLICY_ADAPTER_ID,
    adapterVersion: CPI_POLICY_ADAPTER_VERSION,
    adapterFormula: "r_policyᴾ = clamp(r_neutral + β × (12 × CPI_MoM − π*), −5%, 15%)",
    uncertaintyTreatment: "The selected CPI quantile supplies the point scenario. CPI P10 and P90 pass through the same monotone adapter to form the policy-rate interval; no new browser simulation is run.",
    policyRateBounds,
    rawPolicyRateForecast,
    policyRateClamped: rawPolicyRateForecast !== policyRateForecast,
    forecastRunId: snapshot.runId,
    distributionMethod: snapshot.distribution.method,
    distributionMethodVersion: snapshot.distribution.methodVersion,
    distributionSeed: snapshot.distribution.seed,
    mappingVersion,
    scenarioInputs,
    sourceTargetDate: snapshot.target.releaseTimestamp,
    sourceAvailabilityDate: snapshot.latestObservation.availableTimestamp,
    sourceModelId: snapshot.selectedModelId,
    affectedParameters,
    bridge,
  };
}
