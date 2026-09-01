import { vasicekBondPrice } from "../pde-engine/short-rate.ts";
import type {
  VasicekHistoricalEstimate,
  VasicekPreparedPoint,
  VasicekQCalibrationResult,
} from "./types.ts";

export interface VasicekRateObservation {
  date: string;
  value: number;
}

export interface VasicekPreparationOptions {
  windowStart: string;
  windowEnd: string;
  sampling: "daily" | "weekly";
  missingPolicy: "previous-valid" | "drop-gaps";
  outlierPolicy: "none" | "remove-3sigma" | "winsorize-3sigma";
}

export interface VasicekCurveInstrument {
  id: string;
  maturity: number;
  price: number;
}

const DAY_MS = 86_400_000;
const normal95 = 1.959963984540054;
const dateAtUtc = (value: string) => new Date(`${value}T00:00:00Z`);
const dateString = (value: Date) => value.toISOString().slice(0, 10);

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: number[], centre = mean(values)): number {
  return values.reduce((sum, value) => sum + (value - centre) ** 2, 0) / Math.max(1, values.length - 1);
}

function businessDates(start: string, end: string): string[] {
  const result: string[] = [];
  for (let date = dateAtUtc(start); date <= dateAtUtc(end); date = new Date(date.getTime() + DAY_MS)) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) result.push(dateString(date));
  }
  return result;
}

function weekKey(date: string): string {
  const value = dateAtUtc(date);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return dateString(value);
}

function gridObservations(observations: VasicekRateObservation[], options: VasicekPreparationOptions): VasicekPreparedPoint[] {
  const sorted = [...observations]
    .filter((item) => item.date >= options.windowStart && item.date <= options.windowEnd && Number.isFinite(item.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (options.sampling === "weekly") {
    const lastByWeek = new Map<string, VasicekRateObservation>();
    sorted.forEach((item) => lastByWeek.set(weekKey(item.date), item));
    if (options.missingPolicy === "drop-gaps") return [...lastByWeek.values()].map((item) => ({ ...item, source: "observed", excluded: false }));
    const result: VasicekPreparedPoint[] = [];
    let previous: number | undefined;
    for (let monday = dateAtUtc(weekKey(options.windowStart)); monday <= dateAtUtc(options.windowEnd); monday = new Date(monday.getTime() + 7 * DAY_MS)) {
      const key = dateString(monday);
      const observed = lastByWeek.get(key);
      if (observed) {
        previous = observed.value;
        result.push({ ...observed, source: "observed", excluded: false });
      } else if (previous != null) {
        const friday = new Date(monday.getTime() + 4 * DAY_MS);
        result.push({ date: dateString(friday), value: previous, source: "carried", excluded: false });
      }
    }
    return result;
  }
  const byDate = new Map(sorted.map((item) => [item.date, item.value]));
  let previous: number | undefined;
  const result: VasicekPreparedPoint[] = [];
  businessDates(options.windowStart, options.windowEnd).forEach((date) => {
    const observed = byDate.get(date);
    if (observed != null) {
      previous = observed;
      result.push({ date, value: observed, source: "observed", excluded: false });
      return;
    }
    if (options.missingPolicy === "previous-valid" && previous != null) {
      result.push({ date, value: previous, source: "carried", excluded: false });
    }
  });
  return result;
}

export function prepareVasicekHistory(observations: VasicekRateObservation[], options: VasicekPreparationOptions): VasicekPreparedPoint[] {
  if (options.windowStart > options.windowEnd) throw new Error("Vasicek history window start must not follow its end.");
  const points = gridObservations(observations, options);
  if (points.length < 3 || options.outlierPolicy === "none") return points;
  const differences = points.slice(1).map((point, index) => point.value - points[index].value);
  const centre = mean(differences);
  const deviation = Math.sqrt(sampleVariance(differences, centre));
  if (!(deviation > 0)) return points;
  const threshold = 3 * deviation;
  return points.map((point, index) => {
    if (index === 0) return point;
    const difference = point.value - points[index - 1].value;
    if (Math.abs(difference - centre) <= threshold) return point;
    if (options.outlierPolicy === "remove-3sigma") {
      return { ...point, excluded: true, exclusionReason: `Rate change exceeds 3σ (${difference.toFixed(6)})` };
    }
    const clipped = centre + Math.sign(difference - centre) * threshold;
    return {
      ...point,
      value: points[index - 1].value + clipped,
      source: "winsorized",
      exclusionReason: `Rate change winsorized at 3σ (raw ${difference.toFixed(6)})`,
    };
  });
}

function includedTransitions(points: VasicekPreparedPoint[], sampling: "daily" | "weekly", missingPolicy: "previous-valid" | "drop-gaps") {
  const included = points.filter((point) => !point.excluded);
  const maximumGapDays = sampling === "weekly" ? 11 : 4;
  return included.slice(1).flatMap((point, index) => {
    const previous = included[index];
    const gapDays = (dateAtUtc(point.date).getTime() - dateAtUtc(previous.date).getTime()) / DAY_MS;
    if (missingPolicy === "drop-gaps" && gapDays > maximumGapDays) return [];
    return [{ previous: previous.value, next: point.value }];
  });
}

function residualDiagnostics(residuals: number[]) {
  const residualMean = mean(residuals);
  const variance = sampleVariance(residuals, residualMean);
  const standardDeviation = Math.sqrt(variance);
  const standardized = residuals.map((value) => (value - residualMean) / Math.max(standardDeviation, 1e-15));
  const skewness = mean(standardized.map((value) => value ** 3));
  const excessKurtosis = mean(standardized.map((value) => value ** 4)) - 3;
  const lagPairs = standardized.slice(1).map((value, index) => ({ previous: standardized[index], next: value }));
  const lag1Autocorrelation = lagPairs.length
    ? lagPairs.reduce((sum, item) => sum + item.previous * item.next, 0) / Math.max(1e-15, lagPairs.reduce((sum, item) => sum + item.previous ** 2, 0))
    : 0;
  return {
    mean: residualMean,
    standardDeviation,
    skewness,
    excessKurtosis,
    lag1Autocorrelation,
    jarqueBera: residuals.length / 6 * (skewness ** 2 + excessKurtosis ** 2 / 4),
  };
}

export function estimateVasicekHistorical(
  points: VasicekPreparedPoint[],
  options: VasicekPreparationOptions & { minimumObservations: number },
): VasicekHistoricalEstimate {
  const transitions = includedTransitions(points, options.sampling, options.missingPolicy);
  if (transitions.length < Math.max(3, options.minimumObservations - 1)) {
    throw new Error(`Vasicek history has ${transitions.length + 1} usable observations; at least ${options.minimumObservations} are required.`);
  }
  const x = transitions.map((item) => item.previous);
  const y = transitions.map((item) => item.next);
  const xMean = mean(x);
  const yMean = mean(y);
  const sxx = x.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  if (!(sxx > 1e-18)) throw new Error("Vasicek history has insufficient rate variation for an OU fit.");
  const phi = transitions.reduce((sum, item) => sum + (item.previous - xMean) * (item.next - yMean), 0) / sxx;
  if (!(phi > 0 && phi < 1) || !Number.isFinite(phi)) throw new Error("The exact OU fit requires a finite autoregressive coefficient strictly between zero and one.");
  const intercept = yMean - phi * xMean;
  const sampleIntervalYears = options.sampling === "weekly" ? 7 / 365 : 1 / 252;
  const meanReversion = -Math.log(phi) / sampleIntervalYears;
  const longRunRate = intercept / (1 - phi);
  const residuals = transitions.map((item) => item.next - intercept - phi * item.previous);
  const innovationVariance = residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, residuals.length - 2);
  const rateVolatility = Math.sqrt(innovationVariance * 2 * meanReversion / Math.max(1e-15, 1 - phi ** 2));
  if (!(meanReversion > 0) || !(rateVolatility > 0) || ![meanReversion, longRunRate, rateVolatility].every(Number.isFinite)) {
    throw new Error("The Vasicek estimator produced invalid parameters; positive a and σᵣ and finite values are required.");
  }

  const phiSe = Math.sqrt(innovationVariance / sxx);
  const meanReversionSe = phiSe / (sampleIntervalYears * phi);
  const interceptSe = Math.sqrt(innovationVariance * (1 / x.length + xMean ** 2 / sxx));
  const longRunRateSe = Math.sqrt((interceptSe / (1 - phi)) ** 2 + (intercept * phiSe / (1 - phi) ** 2) ** 2);
  const volatilitySe = rateVolatility / Math.sqrt(2 * residuals.length);
  const interval = (estimate: number, standardError: number, positive: boolean) => ({
    estimate,
    standardError,
    lower: positive ? Math.max(Number.EPSILON, estimate - normal95 * standardError) : estimate - normal95 * standardError,
    upper: estimate + normal95 * standardError,
  });
  return {
    measure: "P",
    estimatorVersion: "exact-ou-ar1-1.0.0",
    window: [options.windowStart, options.windowEnd],
    sampling: options.sampling,
    missingPolicy: options.missingPolicy,
    outlierPolicy: options.outlierPolicy,
    sampleIntervalYears,
    observations: points.filter((item) => !item.excluded).length,
    transitions: transitions.length,
    parameters: { meanReversion, longRunRate, rateVolatility },
    intervals: {
      meanReversion: interval(meanReversion, meanReversionSe, true),
      longRunRate: interval(longRunRate, longRunRateSe, false),
      rateVolatility: interval(rateVolatility, volatilitySe, true),
    },
    residuals,
    residualDiagnostics: residualDiagnostics(residuals),
  };
}

const Q_BOUNDS: VasicekQCalibrationResult["bounds"] = {
  meanReversion: [0.01, 3],
  longRunRate: [-0.02, 0.15],
  rateVolatility: [0.0001, 0.08],
};

export function calibrateVasicekQCurve(options: {
  shortRate: number;
  instruments: VasicekCurveInstrument[];
  seed: { meanReversion: number; longRunRate: number; rateVolatility: number };
  completedAt: string;
}): VasicekQCalibrationResult {
  const instruments = [...options.instruments].filter((item) => item.maturity > 0 && item.price > 0 && item.price <= 1 && Number.isFinite(item.price));
  if (new Set(instruments.map((item) => item.maturity)).size < 4) throw new Error("Q-curve calibration requires at least four distinct zero-coupon maturities.");
  type Key = keyof typeof Q_BOUNDS;
  const keys: Key[] = ["meanReversion", "longRunRate", "rateVolatility"];
  const clamp = (value: number, [lower, upper]: [number, number]) => Math.max(lower, Math.min(upper, value));
  let evaluations = 0;
  const evaluate = (candidate: typeof parameters) => {
    evaluations += 1;
    return mean(instruments.map((item) => {
      const modelPrice = vasicekBondPrice({ shortRate: options.shortRate, ...candidate }, item.maturity);
      return (modelPrice - item.price) ** 2;
    }));
  };
  const optimize = (start: typeof options.seed) => {
    let candidateParameters = Object.fromEntries(keys.map((key) => [key, clamp(start[key], Q_BOUNDS[key])])) as unknown as typeof options.seed;
    let candidateObjective = evaluate(candidateParameters);
    let steps: Record<Key, number> = { meanReversion: 0.45, longRunRate: 0.02, rateVolatility: 0.012 };
    for (let iteration = 0; iteration < 110; iteration += 1) {
      let improved = false;
      for (const key of keys) {
        for (const direction of [-1, 1]) {
          const trial = { ...candidateParameters, [key]: clamp(candidateParameters[key] + direction * steps[key], Q_BOUNDS[key]) };
          const trialObjective = evaluate(trial);
          if (trialObjective + 1e-18 < candidateObjective) {
            candidateParameters = trial;
            candidateObjective = trialObjective;
            improved = true;
          }
        }
      }
      if (!improved) {
        steps = Object.fromEntries(keys.map((key) => [key, steps[key] * 0.55])) as Record<Key, number>;
        if (Math.max(...Object.values(steps)) < 1e-8) break;
      }
    }
    return { parameters: candidateParameters, objective: candidateObjective };
  };
  const starts = [
    options.seed,
    { meanReversion: 0.2, longRunRate: 0.04, rateVolatility: 0.006 },
    { meanReversion: 0.5, longRunRate: 0.04, rateVolatility: 0.012 },
    { meanReversion: 1, longRunRate: 0.045, rateVolatility: 0.02 },
  ];
  const solutions = starts.map(optimize).sort((left, right) => left.objective - right.objective);
  const { parameters, objective } = solutions[0];
  const fitted = instruments.map((item) => {
    const modelPrice = vasicekBondPrice({ shortRate: options.shortRate, ...parameters }, item.maturity);
    return { id: item.id, maturity: item.maturity, marketPrice: item.price, modelPrice, error: item.price - modelPrice };
  });
  return {
    measure: "Q",
    method: "cross-sectional-zero-coupon-calibration",
    parameters,
    bounds: Q_BOUNDS,
    objective,
    maximumError: Math.max(...fitted.map((item) => Math.abs(item.error))),
    evaluations,
    instruments: fitted,
    completedAt: options.completedAt,
  };
}
