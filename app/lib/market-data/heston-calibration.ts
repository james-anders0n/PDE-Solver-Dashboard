import { hestonSemiAnalyticPrice } from "../pde-engine/heston.ts";
import { impliedVolatilityFromPrice } from "./black-scholes-snapshot.ts";
import type {
  HestonCalibrationParameters,
  HestonCalibrationResult,
  HestonSnapshotDetails,
  HestonSurfaceInstrument,
  MarketSnapshot,
  MarketVisualSeries,
} from "./types.ts";

export const HESTON_CALIBRATION_BOUNDS: HestonCalibrationResult["bounds"] = {
  v0: [0.0025, 0.36],
  kappa: [0.05, 8],
  theta: [0.0025, 0.36],
  xi: [0.05, 2],
  rho: [-0.95, 0.95],
};

const PARAMETER_KEYS = ["v0", "kappa", "theta", "xi", "rho"] as const;

export class HestonCalibrationCancelledError extends Error {
  constructor() {
    super("Heston calibration cancelled.");
    this.name = "HestonCalibrationCancelledError";
  }
}

const clamp = (value: number, bounds: [number, number]) => Math.min(bounds[1], Math.max(bounds[0], value));

function nearestAtm(items: HestonSurfaceInstrument[]): HestonSurfaceInstrument | null {
  const retained = items.filter((item) => !item.excluded && item.marketImpliedVolatility != null);
  return retained.length ? retained.reduce((best, item) => Math.abs(item.logMoneyness) < Math.abs(best.logMoneyness) ? item : best) : null;
}

function linearSlope(items: HestonSurfaceInstrument[]): number {
  const points = items.filter((item) => !item.excluded && item.marketImpliedVolatility != null);
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, item) => sum + item.logMoneyness, 0) / points.length;
  const meanY = points.reduce((sum, item) => sum + item.marketImpliedVolatility!, 0) / points.length;
  const denominator = points.reduce((sum, item) => sum + (item.logMoneyness - meanX) ** 2, 0);
  return denominator > 0
    ? points.reduce((sum, item) => sum + (item.logMoneyness - meanX) * (item.marketImpliedVolatility! - meanY), 0) / denominator
    : 0;
}

export function deriveHestonSeeds(instruments: HestonSurfaceInstrument[]): {
  parameters: HestonCalibrationParameters;
  rationale: HestonSnapshotDetails["seedRationale"];
} {
  const retained = instruments.filter((item) => !item.excluded && item.marketImpliedVolatility != null);
  if (!retained.length) throw new Error("Heston seeds require retained option instruments.");
  const expirations = [...new Set(retained.map((item) => item.expiration))].sort();
  const shortItems = retained.filter((item) => item.expiration === expirations[0]);
  const longItems = retained.filter((item) => item.expiration === expirations.at(-1));
  const shortAtm = nearestAtm(shortItems)!;
  const longAtm = nearestAtm(longItems)!;
  const v0 = clamp(shortAtm.marketImpliedVolatility! ** 2, HESTON_CALIBRATION_BOUNDS.v0);
  const theta = clamp(longAtm.marketImpliedVolatility! ** 2, HESTON_CALIBRATION_BOUNDS.theta);
  const slope = linearSlope(shortItems);
  const rho = clamp(slope * 3.2, HESTON_CALIBRATION_BOUNDS.rho);
  const ordered = shortItems.filter((item) => item.marketImpliedVolatility != null).sort((a, b) => a.logMoneyness - b.logMoneyness);
  const centre = nearestAtm(ordered)!;
  const left = ordered.filter((item) => item.logMoneyness < centre.logMoneyness).at(-1);
  const right = ordered.find((item) => item.logMoneyness > centre.logMoneyness);
  const curvature = left && right
    ? Math.abs(left.marketImpliedVolatility! - 2 * centre.marketImpliedVolatility! + right.marketImpliedVolatility!)
      / Math.max(1e-4, ((right.logMoneyness - left.logMoneyness) / 2) ** 2)
    : 0.1;
  const xi = clamp(0.18 + 0.45 * Math.sqrt(curvature), HESTON_CALIBRATION_BOUNDS.xi);
  const midExpiration = expirations[Math.floor((expirations.length - 1) / 2)];
  const midAtm = nearestAtm(retained.filter((item) => item.expiration === midExpiration));
  const ratio = midAtm && Math.abs(v0 - theta) > 1e-6
    ? (midAtm.marketImpliedVolatility! ** 2 - theta) / (v0 - theta)
    : Number.NaN;
  const kappa = clamp(Number.isFinite(ratio) && ratio > 0 && ratio < 1
    ? -Math.log(ratio) / Math.max(midAtm!.maturity, 1e-3)
    : 1.5, HESTON_CALIBRATION_BOUNDS.kappa);
  return {
    parameters: { v0, kappa, theta, xi, rho },
    rationale: {
      v0: `Short-expiry forward-ATM variance from ${shortAtm.contractSymbol}.`,
      theta: `Long-expiry forward-ATM variance from ${longAtm.contractSymbol}.`,
      rho: "Short-expiry IV skew mapped to a bounded correlation seed.",
      xi: "Short-expiry smile curvature mapped to a bounded vol-of-variance seed.",
      kappa: "ATM variance term-structure decay mapped to a bounded mean-reversion seed.",
    },
  };
}

export function spreadAwareWeights(
  instruments: HestonSurfaceInstrument[],
  objective: "price" | "iv",
  useOpenInterest: boolean,
): number[] {
  const raw = instruments.map((item) => {
    const spread = objective === "price"
      ? Math.max(item.ask - item.bid, 0.01)
      : Math.max((item.askImpliedVolatility ?? item.marketImpliedVolatility ?? 0)
        - (item.bidImpliedVolatility ?? item.marketImpliedVolatility ?? 0), 0.0025);
    const liquidity = useOpenInterest ? Math.sqrt(Math.max(1, item.openInterest)) : 1;
    return liquidity / (spread * spread);
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  return total > 0 ? raw.map((value) => value / total) : raw.map(() => 1 / Math.max(1, raw.length));
}

interface CalibrationOptions {
  spot: number;
  instruments: HestonSurfaceInstrument[];
  seeds: HestonCalibrationParameters;
  objective: "price" | "iv";
  useOpenInterest: boolean;
  randomSeed: number;
  multiStarts: number;
  maximumEvaluations: number;
  quadratureOrder?: number;
  startedAt?: string;
  completedAt?: string;
  shouldCancel?: () => boolean;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ next >>> 15, next | 1);
    next ^= next + Math.imul(next ^ next >>> 7, next | 61);
    return ((next ^ next >>> 14) >>> 0) / 4_294_967_296;
  };
}

export function calibrateHestonSurface(options: CalibrationOptions): HestonCalibrationResult {
  const retained = options.instruments.filter((item) => !item.excluded && item.marketImpliedVolatility != null);
  if (!retained.length) throw new Error("Heston calibration requires retained instruments with valid implied volatility.");
  if (!Number.isInteger(options.multiStarts) || options.multiStarts < 1) throw new Error("Heston multi-start count must be a positive integer.");
  if (!Number.isInteger(options.maximumEvaluations) || options.maximumEvaluations < options.multiStarts) throw new Error("Heston maximum evaluations must cover every start.");
  const weights = spreadAwareWeights(retained, options.objective, options.useOpenInterest);
  const weightBySymbol = new Map(retained.map((item, index) => [item.contractSymbol, weights[index]]));
  const random = mulberry32(options.randomSeed);
  let evaluations = 0;
  const evaluate = (parameters: HestonCalibrationParameters): number => {
    if (options.shouldCancel?.()) throw new HestonCalibrationCancelledError();
    evaluations += 1;
    let total = 0;
    for (let index = 0; index < retained.length; index += 1) {
      const item = retained[index];
      const modelPrice = hestonSemiAnalyticPrice({
        spot: options.spot, strike: item.strike, maturity: item.maturity, rate: item.rate, dividend: item.dividend,
        ...parameters, side: item.optionType === "call" ? "Call" : "Put",
      }, options.quadratureOrder ?? 24, 100);
      const modelValue = options.objective === "price" ? modelPrice : impliedVolatilityFromPrice({
        price: modelPrice, side: item.optionType, spot: options.spot, strike: item.strike,
        maturity: item.maturity, rate: item.rate, dividend: item.dividend,
      });
      const marketValue = options.objective === "price" ? item.mid : item.marketImpliedVolatility;
      if (modelValue == null || marketValue == null || !Number.isFinite(modelValue)) return Number.POSITIVE_INFINITY;
      total += weights[index] * (modelValue - marketValue) ** 2;
    }
    return total;
  };
  const seed = Object.fromEntries(PARAMETER_KEYS.map((key) => [key, clamp(options.seeds[key], HESTON_CALIBRATION_BOUNDS[key])])) as unknown as HestonCalibrationParameters;
  const starts: HestonCalibrationParameters[] = [seed];
  for (let start = 1; start < options.multiStarts; start += 1) {
    starts.push(Object.fromEntries(PARAMETER_KEYS.map((key) => {
      const [lower, upper] = HESTON_CALIBRATION_BOUNDS[key];
      return [key, clamp(seed[key] + (random() - 0.5) * 0.45 * (upper - lower), [lower, upper])];
    })) as unknown as HestonCalibrationParameters);
  }
  let bestParameters = seed;
  let bestObjective = Number.POSITIVE_INFINITY;
  const allocation = Math.max(1, Math.floor(options.maximumEvaluations / options.multiStarts));
  for (const start of starts) {
    if (evaluations >= options.maximumEvaluations) break;
    let candidate = { ...start };
    let candidateObjective = evaluate(candidate);
    const startLimit = Math.min(options.maximumEvaluations, evaluations + allocation - 1);
    const steps = Object.fromEntries(PARAMETER_KEYS.map((key) => {
      const [lower, upper] = HESTON_CALIBRATION_BOUNDS[key];
      return [key, 0.14 * (upper - lower)];
    })) as Record<keyof HestonCalibrationParameters, number>;
    while (evaluations < startLimit && Math.max(...PARAMETER_KEYS.map((key) => steps[key] / (HESTON_CALIBRATION_BOUNDS[key][1] - HESTON_CALIBRATION_BOUNDS[key][0]))) > 0.0015) {
      let improved = false;
      for (const key of PARAMETER_KEYS) {
        for (const direction of [-1, 1]) {
          if (evaluations >= startLimit) break;
          const trial = { ...candidate, [key]: clamp(candidate[key] + direction * steps[key], HESTON_CALIBRATION_BOUNDS[key]) };
          const value = evaluate(trial);
          if (value + 1e-14 < candidateObjective) {
            candidate = trial;
            candidateObjective = value;
            improved = true;
          }
        }
      }
      if (!improved) PARAMETER_KEYS.forEach((key) => { steps[key] *= 0.5; });
    }
    if (candidateObjective < bestObjective) {
      bestObjective = candidateObjective;
      bestParameters = candidate;
    }
  }
  if (!Number.isFinite(bestObjective)) throw new Error("Heston calibration failed to produce a finite objective.");
  const residuals = retained.map((item) => {
    const modelPrice = hestonSemiAnalyticPrice({
      spot: options.spot, strike: item.strike, maturity: item.maturity, rate: item.rate, dividend: item.dividend,
      ...bestParameters, side: item.optionType === "call" ? "Call" : "Put",
    }, options.quadratureOrder ?? 24, 100);
    const modelValue = options.objective === "price" ? modelPrice : impliedVolatilityFromPrice({
      price: modelPrice, side: item.optionType, spot: options.spot, strike: item.strike,
      maturity: item.maturity, rate: item.rate, dividend: item.dividend,
    }) ?? Number.NaN;
    const marketValue = options.objective === "price" ? item.mid : item.marketImpliedVolatility!;
    return {
      contractSymbol: item.contractSymbol, expiration: item.expiration, logMoneyness: item.logMoneyness,
      marketValue, modelValue, error: marketValue - modelValue,
    };
  });
  const byExpiry = [...new Set(residuals.map((item) => item.expiration))].sort().map((expiration) => {
    const items = residuals.filter((item) => item.expiration === expiration);
    const itemWeights = retained.filter((item) => item.expiration === expiration).map((item) => weightBySymbol.get(item.contractSymbol) ?? 0);
    const weightTotal = itemWeights.reduce((sum, value) => sum + value, 0);
    const weightedRmse = Math.sqrt(items.reduce((sum, item, index) => sum + itemWeights[index] * item.error ** 2, 0) / Math.max(weightTotal, Number.EPSILON));
    return { expiration, instruments: items.length, weightedRmse, maximumError: Math.max(...items.map((item) => Math.abs(item.error))) };
  });
  const weightedRmse = Math.sqrt(bestObjective);
  const convergenceThreshold = options.objective === "iv" ? 0.05 : Math.max(0.05, options.spot * 0.01);
  return {
    parameters: bestParameters, objective: options.objective, objectiveValue: bestObjective,
    weightedRmse, maximumError: Math.max(...residuals.map((item) => Math.abs(item.error))),
    evaluations, converged: Number.isFinite(bestObjective) && weightedRmse <= convergenceThreshold, bounds: HESTON_CALIBRATION_BOUNDS,
    fellerRatio: 2 * bestParameters.kappa * bestParameters.theta / (bestParameters.xi ** 2),
    startedAt: options.startedAt ?? new Date().toISOString(), completedAt: options.completedAt ?? new Date().toISOString(),
    residuals, expirySummaries: byExpiry,
  };
}

export function acceptHestonCalibration(snapshot: MarketSnapshot, result: HestonCalibrationResult): MarketSnapshot {
  if (!snapshot.heston) throw new Error("Only a Heston surface snapshot can accept Heston calibration results.");
  if (!result.converged || !Number.isFinite(result.objectiveValue)) throw new Error("A failed calibration cannot replace the last accepted set.");
  const parameterIds = new Set<keyof HestonCalibrationParameters>(PARAMETER_KEYS);
  const proposals = snapshot.proposals.map((item) => parameterIds.has(item.id as keyof HestonCalibrationParameters)
    ? {
      ...item, proposedValue: result.parameters[item.id as keyof HestonCalibrationParameters].toFixed(8),
      classification: "calibrated" as const, selected: true, applicable: true, warning: undefined,
      calibrationRole: "calibrated" as const, bounds: result.bounds[item.id as keyof HestonCalibrationParameters],
      provenance: {
        ...item.provenance, observationTimestamp: result.completedAt, availableTimestamp: result.completedAt,
        formula: `bounded deterministic multi-start Heston ${result.objective}-error calibration`,
        financialInterpretation: "Q-calibrated Heston surface parameter; calibration does not apply it automatically.",
      },
    }
    : item);
  const residualSeries: MarketVisualSeries[] = result.expirySummaries.map((summary) => ({
    id: `residual-${summary.expiration}`, label: summary.expiration, classification: "calibrated",
    points: result.residuals.filter((item) => item.expiration === summary.expiration)
      .map((item) => ({ x: item.logMoneyness, y: item.error, label: item.contractSymbol })),
  }));
  const fellerMessage = result.fellerRatio >= 1 ? "Satisfied" : "Violated — diagnostic only";
  return {
    ...snapshot, proposals, secondarySeries: residualSeries,
    secondarySummary: `Market-minus-model ${result.objective.toUpperCase()} residuals from the accepted calibration.`,
    diagnostics: [
      { label: "Objective", value: `${result.objective.toUpperCase()} · ${result.objectiveValue.toExponential(4)}` },
      { label: "Weighted RMSE", value: result.weightedRmse.toExponential(4) },
      { label: "Maximum error", value: result.maximumError.toExponential(4) },
      { label: "Evaluations", value: String(result.evaluations) },
      { label: "Calibration", value: result.converged ? "Converged" : "Failed" },
      { label: "Feller ratio", value: `${result.fellerRatio.toFixed(4)} · ${fellerMessage}` },
    ],
    warnings: result.fellerRatio < 1
      ? [...snapshot.warnings.filter((item) => !item.startsWith("Feller")), "Feller condition is violated; this remains a diagnostic and does not reject the calibrated set."]
      : snapshot.warnings.filter((item) => !item.startsWith("Feller")),
    heston: { ...snapshot.heston, calibration: result },
  };
}
