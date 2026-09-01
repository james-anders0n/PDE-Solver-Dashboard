import type { ModelKey } from "./pde-spec.ts";

export type EconomicVariable = "equity-return" | "realised-volatility" | "policy-rate";
export type RunClassification = "market-calibrated" | "historical" | "macro-conditioned scenario" | "hybrid/regularised calibration";

export interface UncertaintyInterval {
  lower: number;
  upper: number;
  confidenceLevel: number;
  method: string;
}

export interface EconomicForecast {
  id: string;
  label: string;
  variable: EconomicVariable;
  value: number;
  unit: "decimal";
  uncertainty: UncertaintyInterval;
  observationTimestamp: string;
  availableTimestamp: string;
  targetTimestamp: string;
  forecastHorizonMonths: number;
  dataVintage: string;
  sourceModel: string;
  sourceModelVersion: string;
}

export interface EconomicRegime {
  id: string;
  label: string;
  probability: number;
  uncertainty: UncertaintyInterval;
  expectedReturnAdjustment: number;
  volatilityMultiplier: number;
  rateShift: number;
  observationTimestamp: string;
  availableTimestamp: string;
  dataVintage: string;
  sourceModel: string;
  sourceModelVersion: string;
}

export interface EconomicBridgeInput {
  runAsOfTimestamp: string;
  mappingId: string;
  mappingVersion: string;
  forecasts: EconomicForecast[];
  regimes: EconomicRegime[];
}

export interface BridgeTransformation {
  scenarioId: string;
  sourceInputId: string;
  sourceLabel: string;
  sourceValue: number;
  sourceInterval: [number, number];
  confidenceLevel: number;
  targetParameter: string | null;
  targetSet: "scenario" | "excluded";
  formula: string;
  rawMappedValue: number | null;
  mappedValue: number | null;
  mappedInterval: [number, number] | null;
  bounds: [number, number] | null;
  constrained: boolean;
  measure: "P" | "Q";
  financialInterpretation: string;
  observationTimestamp: string;
  availableTimestamp: string;
  targetTimestamp: string;
  forecastHorizonMonths: number;
  dataVintage: string;
  sourceModelVersion: string;
  mappingVersion: string;
}

export interface BridgeScenario {
  id: string;
  label: string;
  probability: number;
  probabilityInterval: [number, number];
  probabilityProvenance: {
    observationTimestamp: string;
    availableTimestamp: string;
    dataVintage: string;
    sourceModelVersion: string;
    method: string;
  };
  classification: RunClassification;
  parameters: Record<string, string | number>;
  transformations: BridgeTransformation[];
}

export interface EconomicBridgeResult {
  runAsOfTimestamp: string;
  mappingId: string;
  mappingVersion: string;
  model: ModelKey;
  calibratedParameters: Record<string, string | number>;
  scenarios: BridgeScenario[];
  audit: {
    inputIds: string[];
    sourceModelVersions: string[];
    dataVintages: string[];
    lookAheadChecked: true;
    probabilitySum: number;
  };
}

export class EconomicBridgeValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Economic bridge input is invalid: ${issues.join(" ")}`);
    this.name = "EconomicBridgeValidationError";
    this.issues = issues;
  }
}

const isoTime = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const clamp = (value: number, bounds: [number, number]) => Math.min(bounds[1], Math.max(bounds[0], value));

const monthsBetween = (from: string, to: string) => {
  const start = new Date(from);
  const end = new Date(to);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
};

export function validateEconomicBridgeInput(input: EconomicBridgeInput): string[] {
  const issues: string[] = [];
  const runAsOf = isoTime(input.runAsOfTimestamp);
  if (!Number.isFinite(runAsOf)) issues.push("runAsOfTimestamp must be a valid ISO timestamp.");
  if (!input.mappingId.trim() || !input.mappingVersion.trim()) issues.push("Mapping id and version are required.");
  if (input.forecasts.length === 0) issues.push("At least one forecast is required.");
  if (input.regimes.length === 0) issues.push("At least one regime probability is required.");

  const ids = [...input.forecasts.map((item) => item.id), ...input.regimes.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) issues.push("Forecast and regime ids must be unique.");

  for (const forecast of input.forecasts) {
    const observation = isoTime(forecast.observationTimestamp);
    const available = isoTime(forecast.availableTimestamp);
    const target = isoTime(forecast.targetTimestamp);
    if (![observation, available, target].every(Number.isFinite)) {
      issues.push(`${forecast.id} has an invalid timestamp.`);
      continue;
    }
    if (observation > available) issues.push(`${forecast.id} was available before it was observed.`);
    if (available > runAsOf) issues.push(`${forecast.id} was not available at the run timestamp (look-ahead leakage).`);
    if (target <= observation) issues.push(`${forecast.id} target must be after its observation.`);
    if (Math.abs(monthsBetween(forecast.observationTimestamp, forecast.targetTimestamp) - forecast.forecastHorizonMonths) > 1) {
      issues.push(`${forecast.id} target timestamp does not match its forecast horizon.`);
    }
    if (!Number.isFinite(forecast.value)) issues.push(`${forecast.id} value must be finite.`);
    if (forecast.uncertainty.lower > forecast.value || forecast.value > forecast.uncertainty.upper) {
      issues.push(`${forecast.id} point forecast must lie inside its uncertainty interval.`);
    }
    if (!(forecast.uncertainty.confidenceLevel > 0 && forecast.uncertainty.confidenceLevel < 1)) {
      issues.push(`${forecast.id} confidence level must lie strictly between zero and one.`);
    }
    if (!forecast.dataVintage.trim() || !forecast.sourceModel.trim() || !forecast.sourceModelVersion.trim()) {
      issues.push(`${forecast.id} requires data-vintage and source-model provenance.`);
    }
  }

  for (const regime of input.regimes) {
    const observation = isoTime(regime.observationTimestamp);
    const available = isoTime(regime.availableTimestamp);
    if (![observation, available].every(Number.isFinite)) {
      issues.push(`${regime.id} has an invalid timestamp.`);
      continue;
    }
    if (observation > available) issues.push(`${regime.id} was available before it was observed.`);
    if (available > runAsOf) issues.push(`${regime.id} was not available at the run timestamp (look-ahead leakage).`);
    if (!(regime.probability >= 0 && regime.probability <= 1)) issues.push(`${regime.id} probability must lie in [0, 1].`);
    if (!(regime.volatilityMultiplier > 0)) issues.push(`${regime.id} volatility multiplier must be positive.`);
    if (regime.uncertainty.lower > regime.probability || regime.probability > regime.uncertainty.upper) {
      issues.push(`${regime.id} probability must lie inside its uncertainty interval.`);
    }
    if (!(regime.uncertainty.confidenceLevel > 0 && regime.uncertainty.confidenceLevel < 1)) {
      issues.push(`${regime.id} confidence level must lie strictly between zero and one.`);
    }
    if (!regime.dataVintage.trim() || !regime.sourceModel.trim() || !regime.sourceModelVersion.trim()) {
      issues.push(`${regime.id} requires data-vintage and source-model provenance.`);
    }
  }

  const probabilitySum = input.regimes.reduce((sum, regime) => sum + regime.probability, 0);
  if (Math.abs(probabilitySum - 1) > 1e-10) issues.push(`Regime probabilities must sum to one; received ${probabilitySum}.`);
  return issues;
}

interface MappingDefinition {
  targetParameter: string | null;
  bounds: [number, number] | null;
  measure: "P" | "Q";
  formula: string;
  interpretation: string;
  map?: (value: number, regime: EconomicRegime) => number;
  mapInterval?: (interval: [number, number], regime: EconomicRegime) => [number, number];
}

function mappingFor(model: ModelKey, variable: EconomicVariable): MappingDefinition {
  if (model === "HJB") {
    if (variable === "equity-return") return {
      targetParameter: "expectedReturn",
      bounds: [-1, 2],
      measure: "P",
      formula: "μscenario = clamp(μforecast + regime return adjustment, −1, 2)",
      interpretation: "Real-world expected risky-asset return used by the Merton allocation objective; never a pricing drift.",
      map: (value, regime) => value + regime.expectedReturnAdjustment,
      mapInterval: ([lower, upper], regime) => [lower + regime.expectedReturnAdjustment, upper + regime.expectedReturnAdjustment],
    };
    if (variable === "realised-volatility") return {
      targetParameter: "volatility",
      bounds: [1e-6, 5],
      measure: "P",
      formula: "σscenario = clamp(σforecast × regime volatility multiplier, 10⁻⁶, 5)",
      interpretation: "P-measure risky-asset volatility used to scale wealth risk in the control problem.",
      map: (value, regime) => value * regime.volatilityMultiplier,
      mapInterval: ([lower, upper], regime) => [lower * regime.volatilityMultiplier, upper * regime.volatilityMultiplier],
    };
    return {
      targetParameter: "rate",
      bounds: [-0.25, 0.5],
      measure: "P",
      formula: "rscenario = clamp(policy-rate forecast + regime rate shift, −0.25, 0.50)",
      interpretation: "Scenario risk-free opportunity rate for the real-world allocation problem, not a replacement market discount curve.",
      map: (value, regime) => value + regime.rateShift,
      mapInterval: ([lower, upper], regime) => [lower + regime.rateShift, upper + regime.rateShift],
    };
  }

  if (variable === "equity-return") return {
    targetParameter: null,
    bounds: null,
    measure: "P",
    formula: "Excluded from Q-measure pricing",
    interpretation: "A forecast equity return cannot replace the risk-neutral drift in an arbitrage-free pricing PDE.",
  };

  if (model === "Black–Scholes" && variable === "realised-volatility") return {
    targetParameter: "volatility",
    bounds: [1e-6, 5],
    measure: "Q",
    formula: "σscenario = clamp(σforecast × regime volatility multiplier, 10⁻⁶, 5)",
    interpretation: "A macro-conditioned volatility scenario only; the base price retains market-implied/calibrated volatility.",
    map: (value, regime) => value * regime.volatilityMultiplier,
    mapInterval: ([lower, upper], regime) => [lower * regime.volatilityMultiplier, upper * regime.volatilityMultiplier],
  };

  if (model === "Heston" && variable === "realised-volatility") return {
    targetParameter: "v0",
    bounds: [1e-8, 4],
    measure: "Q",
    formula: "v₀ scenario prior = clamp((σforecast × regime volatility multiplier)², 10⁻⁸, 4)",
    interpretation: "A prior/scenario for initial variance; it is not labelled implied variance without market calibration.",
    map: (value, regime) => (value * regime.volatilityMultiplier) ** 2,
    mapInterval: ([lower, upper], regime) => [(lower * regime.volatilityMultiplier) ** 2, (upper * regime.volatilityMultiplier) ** 2],
  };

  if (variable === "realised-volatility") return {
    targetParameter: null,
    bounds: null,
    measure: "P",
    formula: "No versioned rate-volatility mapping",
    interpretation: "The equity-volatility forecast has no defensible direct mapping to Gaussian short-rate volatility.",
  };

  if (model === "Vasicek") return {
    targetParameter: "longRunRate",
    bounds: [-0.25, 0.5],
    measure: "Q",
    formula: "bscenario = clamp(policy-rate forecast + regime rate shift, −0.25, 0.50)",
    interpretation: "A long-run-rate scenario or calibration prior; it remains separate from the Q-calibrated base parameter.",
    map: (value, regime) => value + regime.rateShift,
    mapInterval: ([lower, upper], regime) => [lower + regime.rateShift, upper + regime.rateShift],
  };

  if (model === "Hull–White") return {
    targetParameter: "shortRate",
    bounds: [-0.25, 0.5],
    measure: "Q",
    formula: "r₀ scenario overlay = clamp(policy-rate forecast + regime rate shift, −0.25, 0.50)",
    interpretation: "A stress overlay for comparison; it never replaces the observed curve used by the calibrated base price.",
    map: (value, regime) => value + regime.rateShift,
    mapInterval: ([lower, upper], regime) => [lower + regime.rateShift, upper + regime.rateShift],
  };

  return {
    targetParameter: "rate",
    bounds: [-0.25, 0.5],
    measure: "Q",
    formula: "rscenario = clamp(policy-rate forecast + regime rate shift, −0.25, 0.50)",
    interpretation: "A macro-conditioned discount-rate scenario; the market-calibrated base rate remains unchanged.",
    map: (value, regime) => value + regime.rateShift,
    mapInterval: ([lower, upper], regime) => [lower + regime.rateShift, upper + regime.rateShift],
  };
}

function transformForecast(
  input: EconomicBridgeInput,
  model: ModelKey,
  forecast: EconomicForecast,
  regime: EconomicRegime,
): BridgeTransformation {
  const definition = mappingFor(model, forecast.variable);
  const rawMappedValue = definition.map?.(forecast.value, regime) ?? null;
  const rawInterval = definition.mapInterval?.([forecast.uncertainty.lower, forecast.uncertainty.upper], regime) ?? null;
  const mappedValue = rawMappedValue === null || definition.bounds === null ? null : clamp(rawMappedValue, definition.bounds);
  const mappedInterval = rawInterval === null || definition.bounds === null
    ? null
    : [clamp(Math.min(...rawInterval), definition.bounds), clamp(Math.max(...rawInterval), definition.bounds)] as [number, number];
  return {
    scenarioId: regime.id,
    sourceInputId: forecast.id,
    sourceLabel: forecast.label,
    sourceValue: forecast.value,
    sourceInterval: [forecast.uncertainty.lower, forecast.uncertainty.upper],
    confidenceLevel: forecast.uncertainty.confidenceLevel,
    targetParameter: definition.targetParameter,
    targetSet: definition.targetParameter ? "scenario" : "excluded",
    formula: definition.formula,
    rawMappedValue,
    mappedValue,
    mappedInterval,
    bounds: definition.bounds,
    constrained: rawMappedValue !== null && mappedValue !== rawMappedValue,
    measure: definition.measure,
    financialInterpretation: definition.interpretation,
    observationTimestamp: forecast.observationTimestamp,
    availableTimestamp: forecast.availableTimestamp,
    targetTimestamp: forecast.targetTimestamp,
    forecastHorizonMonths: forecast.forecastHorizonMonths,
    dataVintage: forecast.dataVintage,
    sourceModelVersion: `${forecast.sourceModel} ${forecast.sourceModelVersion}`,
    mappingVersion: `${input.mappingId} ${input.mappingVersion}`,
  };
}

export function buildEconomicBridge(
  input: EconomicBridgeInput,
  model: ModelKey,
  calibratedParameters: Record<string, string | number>,
): EconomicBridgeResult {
  const issues = validateEconomicBridgeInput(input);
  if (issues.length > 0) throw new EconomicBridgeValidationError(issues);

  const scenarios = input.regimes.map((regime): BridgeScenario => {
    const transformations = input.forecasts.map((forecast) => transformForecast(input, model, forecast, regime));
    const scenarioParameters = { ...calibratedParameters };
    for (const transformation of transformations) {
      if (transformation.targetParameter && transformation.mappedValue !== null) {
        scenarioParameters[transformation.targetParameter] = transformation.mappedValue;
      }
    }
    return {
      id: regime.id,
      label: regime.label,
      probability: regime.probability,
      probabilityInterval: [regime.uncertainty.lower, regime.uncertainty.upper],
      probabilityProvenance: {
        observationTimestamp: regime.observationTimestamp,
        availableTimestamp: regime.availableTimestamp,
        dataVintage: regime.dataVintage,
        sourceModelVersion: `${regime.sourceModel} ${regime.sourceModelVersion}`,
        method: regime.uncertainty.method,
      },
      classification: "macro-conditioned scenario",
      parameters: scenarioParameters,
      transformations,
    };
  });

  return {
    runAsOfTimestamp: input.runAsOfTimestamp,
    mappingId: input.mappingId,
    mappingVersion: input.mappingVersion,
    model,
    calibratedParameters: { ...calibratedParameters },
    scenarios,
    audit: {
      inputIds: input.forecasts.map((forecast) => forecast.id),
      sourceModelVersions: [...new Set([...input.forecasts, ...input.regimes].map((item) => `${item.sourceModel} ${item.sourceModelVersion}`))],
      dataVintages: [...new Set([...input.forecasts, ...input.regimes].map((item) => item.dataVintage))],
      lookAheadChecked: true,
      probabilitySum: input.regimes.reduce((sum, regime) => sum + regime.probability, 0),
    },
  };
}

export const DEFAULT_ECONOMIC_BRIDGE_INPUT: EconomicBridgeInput = {
  runAsOfTimestamp: "2026-08-20T00:00:00Z",
  mappingId: "macro-to-pde",
  mappingVersion: "1.0.0",
  forecasts: [
    {
      id: "equity-return-12m",
      label: "12-month equity return",
      variable: "equity-return",
      value: 0.08,
      unit: "decimal",
      uncertainty: { lower: 0.04, upper: 0.12, confidenceLevel: 0.8, method: "ensemble quantiles" },
      observationTimestamp: "2026-07-31T00:00:00Z",
      availableTimestamp: "2026-08-05T00:00:00Z",
      targetTimestamp: "2027-07-31T00:00:00Z",
      forecastHorizonMonths: 12,
      dataVintage: "2026-08-05",
      sourceModel: "Macro Ensemble",
      sourceModelVersion: "3.2.0",
    },
    {
      id: "equity-volatility-12m",
      label: "12-month realised volatility",
      variable: "realised-volatility",
      value: 0.2,
      unit: "decimal",
      uncertainty: { lower: 0.16, upper: 0.28, confidenceLevel: 0.8, method: "ensemble quantiles" },
      observationTimestamp: "2026-07-31T00:00:00Z",
      availableTimestamp: "2026-08-05T00:00:00Z",
      targetTimestamp: "2027-07-31T00:00:00Z",
      forecastHorizonMonths: 12,
      dataVintage: "2026-08-05",
      sourceModel: "Macro Ensemble",
      sourceModelVersion: "3.2.0",
    },
    {
      id: "policy-rate-12m",
      label: "12-month policy rate",
      variable: "policy-rate",
      value: 0.035,
      unit: "decimal",
      uncertainty: { lower: 0.025, upper: 0.05, confidenceLevel: 0.8, method: "ensemble quantiles" },
      observationTimestamp: "2026-07-31T00:00:00Z",
      availableTimestamp: "2026-08-05T00:00:00Z",
      targetTimestamp: "2027-07-31T00:00:00Z",
      forecastHorizonMonths: 12,
      dataVintage: "2026-08-05",
      sourceModel: "Macro Ensemble",
      sourceModelVersion: "3.2.0",
    },
  ],
  regimes: [
    {
      id: "baseline",
      label: "Baseline",
      probability: 0.55,
      uncertainty: { lower: 0.45, upper: 0.65, confidenceLevel: 0.8, method: "calibrated classifier interval" },
      expectedReturnAdjustment: 0,
      volatilityMultiplier: 1,
      rateShift: 0,
      observationTimestamp: "2026-07-31T00:00:00Z",
      availableTimestamp: "2026-08-05T00:00:00Z",
      dataVintage: "2026-08-05",
      sourceModel: "Regime Classifier",
      sourceModelVersion: "2.4.1",
    },
    {
      id: "expansion",
      label: "Expansion",
      probability: 0.25,
      uncertainty: { lower: 0.17, upper: 0.33, confidenceLevel: 0.8, method: "calibrated classifier interval" },
      expectedReturnAdjustment: 0.025,
      volatilityMultiplier: 0.85,
      rateShift: -0.005,
      observationTimestamp: "2026-07-31T00:00:00Z",
      availableTimestamp: "2026-08-05T00:00:00Z",
      dataVintage: "2026-08-05",
      sourceModel: "Regime Classifier",
      sourceModelVersion: "2.4.1",
    },
    {
      id: "stress",
      label: "Stress",
      probability: 0.2,
      uncertainty: { lower: 0.12, upper: 0.3, confidenceLevel: 0.8, method: "calibrated classifier interval" },
      expectedReturnAdjustment: -0.08,
      volatilityMultiplier: 1.45,
      rateShift: 0.02,
      observationTimestamp: "2026-07-31T00:00:00Z",
      availableTimestamp: "2026-08-05T00:00:00Z",
      dataVintage: "2026-08-05",
      sourceModel: "Regime Classifier",
      sourceModelVersion: "2.4.1",
    },
  ],
};
