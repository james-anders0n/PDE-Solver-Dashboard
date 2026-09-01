import { throwIfCancelled, type ComputationControl } from "../computation-control.ts";
import {
  hullWhiteBondPrice,
  resolveHullWhiteCurve,
  vasicekBondPrice,
  type DiscountCurve,
  type ShortRateSolveRequest,
} from "../pde-engine/short-rate.ts";
import { Mulberry32, NormalSampler } from "./random.ts";
import { quantileRecord, quantiles, RunningStatistics } from "./statistics.ts";
import type {
  EstimateSummary,
  SampleSummary,
  ShortRateCurveReproductionPoint,
  ShortRateMonteCarloConfig,
  ShortRateMonteCarloResult,
  StatePathSummary,
} from "./types.ts";

const CONFIDENCE_95_Z = 1.959963984540054;

export interface ShortRateMonteCarloRequest
  extends Pick<ShortRateSolveRequest,
    | "model"
    | "contract"
    | "shortRate"
    | "meanReversion"
    | "longRunRate"
    | "rateVolatility"
    | "maturity"
    | "bondMaturity"
    | "strike"
    | "curveId"
    | "discountCurve"
  > {
  config: ShortRateMonteCarloConfig;
}

export interface GaussianRateIntegralMoments {
  rateVariance: number;
  integralVariance: number;
  covariance: number;
  correlation: number;
}

/** Exact covariance moments of an OU rate shock and its time integral. */
export function gaussianRateIntegralMoments(
  meanReversion: number,
  rateVolatility: number,
  timeStep: number,
): GaussianRateIntegralMoments {
  if (![meanReversion, rateVolatility, timeStep].every(Number.isFinite)
    || meanReversion <= 0 || rateVolatility <= 0 || timeStep <= 0) {
    throw new RangeError("Gaussian short-rate step inputs must be finite and positive.");
  }
  const a = meanReversion;
  const b = -Math.expm1(-a * timeStep) / a;
  const rateKernelVariance = -Math.expm1(-2 * a * timeStep) / (2 * a);
  const integralKernelVariance = Math.max(0, (
    timeStep - 2 * b + rateKernelVariance
  ) / (a * a));
  const kernelCovariance = (b - rateKernelVariance) / a;
  const sigmaSquared = rateVolatility * rateVolatility;
  const rateVariance = sigmaSquared * rateKernelVariance;
  const integralVariance = sigmaSquared * integralKernelVariance;
  const covariance = sigmaSquared * kernelCovariance;
  return {
    rateVariance,
    integralVariance,
    covariance,
    correlation: covariance / Math.sqrt(rateVariance * integralVariance),
  };
}

/** Deterministic Hull–White shift for dr=[theta(t)-a r]dt+sigma dW under Q. */
export function hullWhiteRateShift(
  curve: DiscountCurve,
  meanReversion: number,
  rateVolatility: number,
  time: number,
): number {
  const exponential = Math.exp(-meanReversion * time);
  return curve.instantaneousForward(time)
    + rateVolatility ** 2 * (1 - exponential) ** 2 / (2 * meanReversion ** 2);
}

/** Exact integral of the deterministic Hull–White shift over [start, end]. */
export function hullWhiteRateShiftIntegral(
  curve: DiscountCurve,
  meanReversion: number,
  rateVolatility: number,
  start: number,
  end: number,
): number {
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start) {
    throw new RangeError("Hull–White shift integral requires 0 <= start < end.");
  }
  const a = meanReversion;
  const deterministicForwardIntegral = Math.log(curve.discount(start) / curve.discount(end));
  const volatilityIntegral = rateVolatility ** 2 / (2 * a ** 2) * (
    end - start
    - 2 * (Math.exp(-a * start) - Math.exp(-a * end)) / a
    + (Math.exp(-2 * a * start) - Math.exp(-2 * a * end)) / (2 * a)
  );
  return deterministicForwardIntegral + volatilityIntegral;
}

function validateRequest(request: ShortRateMonteCarloRequest): void {
  const values = [
    request.shortRate,
    request.meanReversion,
    request.rateVolatility,
    request.maturity,
  ];
  if (!values.every(Number.isFinite)) throw new Error("Short-rate Monte Carlo parameters must be finite.");
  if (request.meanReversion <= 0 || request.rateVolatility <= 0 || request.maturity <= 0) {
    throw new Error("Mean reversion, rate volatility, and maturity must be positive.");
  }
  if (request.model !== "Vasicek" && request.model !== "Hull–White") throw new Error("Unknown short-rate model.");
  if (request.contract !== "zero-coupon-bond" && request.contract !== "bond-option") throw new Error("Unknown short-rate contract.");
  if (request.model === "Vasicek" && !Number.isFinite(request.longRunRate)) {
    throw new Error("Vasicek Monte Carlo requires a finite long-run rate.");
  }
  if (request.contract === "bond-option") {
    if (!Number.isFinite(request.bondMaturity) || request.bondMaturity! <= request.maturity) {
      throw new Error("The underlying bond maturity must be after option expiry.");
    }
    if (!Number.isFinite(request.strike) || request.strike! <= 0) {
      throw new Error("A bond option requires a finite positive strike.");
    }
  }
  const { config } = request;
  if (config.model !== request.model || config.scheme !== "exact-gaussian") {
    throw new Error("Short-rate Monte Carlo requires a model-matched exact-gaussian configuration.");
  }
  if (!config.enabled) throw new Error("Monte Carlo must be enabled before running the simulator.");
  if (!Number.isInteger(config.paths) || config.paths < 2) throw new Error("Monte Carlo paths must be an integer of at least 2.");
  if (!Number.isInteger(config.timeSteps) || config.timeSteps < 1) throw new Error("Monte Carlo time steps must be a positive integer.");
  if (!Number.isInteger(config.displayPathLimit) || config.displayPathLimit < 1) throw new Error("Display path limit must be a positive integer.");
  if (config.quantileLevels.length === 0 || config.quantileLevels.some((level) => !Number.isFinite(level) || level < 0 || level > 1)) {
    throw new Error("Quantile levels must be finite and between zero and one.");
  }
  if (new Set(config.quantileLevels.map(String)).size !== config.quantileLevels.length) {
    throw new Error("Quantile levels must be unique.");
  }
}

function displayIndices(pathCount: number, requestedLimit: number): number[] {
  const count = Math.min(pathCount, requestedLimit);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => Math.round(index * (pathCount - 1) / (count - 1)));
}

function sampleSummary(statistics: RunningStatistics, values: ArrayLike<number>, levels: readonly number[]): SampleSummary {
  const variance = statistics.sampleVariance;
  return {
    count: statistics.count,
    mean: statistics.mean,
    variance,
    standardDeviation: Math.sqrt(variance),
    minimum: statistics.minimum,
    maximum: statistics.maximum,
    quantiles: quantileRecord(values, levels),
  };
}

function estimateSummary(statistics: RunningStatistics): EstimateSummary {
  const standardError = Math.sqrt(statistics.sampleVariance / statistics.count);
  const margin = CONFIDENCE_95_Z * standardError;
  return {
    mean: statistics.mean,
    standardError,
    confidence95: [statistics.mean - margin, statistics.mean + margin],
  };
}

function emptyPathSummary(initial: number, retainedIndices: number[], levels: readonly number[]) {
  return {
    displayedPaths: retainedIndices.map(() => [initial]),
    meanPath: [initial],
    quantiles: Object.fromEntries(levels.map((level) => [String(level), [initial]])) as Record<string, number[]>,
  };
}

function terminalQuantileValues(summary: StatePathSummary, levels: readonly number[]): Record<string, number> {
  return Object.fromEntries(levels.map((level) => {
    const path = summary.quantiles[String(level)];
    return [String(level), path[path.length - 1]];
  }));
}

function summaryFromTerminalPath(statistics: RunningStatistics, summary: StatePathSummary, levels: readonly number[]): SampleSummary {
  const variance = statistics.sampleVariance;
  return {
    count: statistics.count,
    mean: statistics.mean,
    variance,
    standardDeviation: Math.sqrt(variance),
    minimum: statistics.minimum,
    maximum: statistics.maximum,
    quantiles: terminalQuantileValues(summary, levels),
  };
}

export function shortRateTheoreticalMoments(
  request: Pick<ShortRateMonteCarloRequest,
    "model" | "shortRate" | "meanReversion" | "longRunRate" | "rateVolatility" | "curveId" | "discountCurve"
  >,
  time: number,
): { rateMean: number; rateVariance: number; integratedRateMean: number; integratedRateVariance: number; discountFactorMean: number } {
  if (!Number.isFinite(time) || time < 0) throw new RangeError("Short-rate moment time must be finite and non-negative.");
  if (time === 0) return { rateMean: request.shortRate, rateVariance: 0, integratedRateMean: 0, integratedRateVariance: 0, discountFactorMean: 1 };
  const a = request.meanReversion;
  const b = -Math.expm1(-a * time) / a;
  const shockMoments = gaussianRateIntegralMoments(a, request.rateVolatility, time);
  let rateMean: number;
  let integratedRateMean: number;
  if (request.model === "Vasicek") {
    rateMean = request.longRunRate! + (request.shortRate - request.longRunRate!) * Math.exp(-a * time);
    integratedRateMean = request.longRunRate! * time + (request.shortRate - request.longRunRate!) * b;
  } else {
    const curve = resolveHullWhiteCurve({
      ...request,
      model: "Hull–White",
      contract: "zero-coupon-bond",
      maturity: Math.max(time, 1e-12),
      spaceSteps: 10,
      timeSteps: 1,
    });
    const initialFactor = request.shortRate - hullWhiteRateShift(curve, a, request.rateVolatility, 0);
    rateMean = initialFactor * Math.exp(-a * time) + hullWhiteRateShift(curve, a, request.rateVolatility, time);
    integratedRateMean = initialFactor * b + hullWhiteRateShiftIntegral(curve, a, request.rateVolatility, 0, time);
  }
  return {
    rateMean,
    rateVariance: shockMoments.rateVariance,
    integratedRateMean,
    integratedRateVariance: shockMoments.integralVariance,
    discountFactorMean: Math.exp(-integratedRateMean + 0.5 * shockMoments.integralVariance),
  };
}

/**
 * Simulate Vasicek or one-factor Hull–White under Q. The OU rate innovation
 * and its interval integral are drawn from their exact joint Gaussian law, so
 * both state transitions and pathwise discount factors are free of Euler bias.
 */
export function simulateShortRateMonteCarlo(
  request: ShortRateMonteCarloRequest,
  control?: ComputationControl,
): ShortRateMonteCarloResult {
  validateRequest(request);
  throwIfCancelled(control);
  const startedAt = performance.now();
  const { config } = request;
  const timeStep = request.maturity / config.timeSteps;
  const transition = gaussianRateIntegralMoments(request.meanReversion, request.rateVolatility, timeStep);
  const rateShockScale = Math.sqrt(transition.rateVariance);
  const integralLoading = transition.covariance / rateShockScale;
  const orthogonalIntegralScale = Math.sqrt(Math.max(0, transition.integralVariance - integralLoading ** 2));
  const exponential = Math.exp(-request.meanReversion * timeStep);
  const b = -Math.expm1(-request.meanReversion * timeStep) / request.meanReversion;
  const curve = request.model === "Hull–White" ? resolveHullWhiteCurve({
    ...request,
    model: "Hull–White",
    spaceSteps: 10,
    timeSteps: 1,
  }) : undefined;
  const rates = new Float64Array(config.paths).fill(request.shortRate);
  const integratedRates = new Float64Array(config.paths);
  const discountFactors = new Float64Array(config.paths).fill(1);
  const random = new NormalSampler(new Mulberry32(config.seed));
  const retainedIndices = displayIndices(config.paths, config.displayPathLimit);
  const retainedSlots = new Int32Array(config.paths).fill(-1);
  retainedIndices.forEach((pathIndex, slot) => { retainedSlots[pathIndex] = slot; });
  const shortRatePath = emptyPathSummary(request.shortRate, retainedIndices, config.quantileLevels);
  const discountPath = emptyPathSummary(1, retainedIndices, config.quantileLevels);
  const time = Array.from({ length: config.timeSteps + 1 }, (_, index) => index * timeStep);
  const theoreticalShortRateMeanPath = [request.shortRate];
  const theoreticalDiscountFactorMeanPath = [1];
  const discountFactorStandardErrorPath = [0];
  let terminalRateStatistics = new RunningStatistics();

  for (let timeIndex = 1; timeIndex <= config.timeSteps; timeIndex += 1) {
    throwIfCancelled(control);
    const start = time[timeIndex - 1];
    const end = time[timeIndex];
    const rateStatistics = new RunningStatistics();
    const discountStatistics = new RunningStatistics();
    for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
      if ((pathIndex & 0x3fff) === 0) throwIfCancelled(control);
      const previousRate = rates[pathIndex];
      const firstNormal = random.next();
      const secondNormal = random.next();
      let nextRateMean: number;
      let intervalIntegralMean: number;
      if (request.model === "Vasicek") {
        nextRateMean = request.longRunRate! + (previousRate - request.longRunRate!) * exponential;
        intervalIntegralMean = request.longRunRate! * timeStep + (previousRate - request.longRunRate!) * b;
      } else {
        const previousFactor = previousRate - hullWhiteRateShift(curve!, request.meanReversion, request.rateVolatility, start);
        nextRateMean = previousFactor * exponential
          + hullWhiteRateShift(curve!, request.meanReversion, request.rateVolatility, end);
        intervalIntegralMean = previousFactor * b
          + hullWhiteRateShiftIntegral(curve!, request.meanReversion, request.rateVolatility, start, end);
      }
      const nextRate = nextRateMean + rateShockScale * firstNormal;
      const intervalIntegral = intervalIntegralMean
        + integralLoading * firstNormal
        + orthogonalIntegralScale * secondNormal;
      rates[pathIndex] = nextRate;
      integratedRates[pathIndex] += intervalIntegral;
      const discountFactor = Math.exp(-integratedRates[pathIndex]);
      discountFactors[pathIndex] = discountFactor;
      rateStatistics.add(nextRate);
      discountStatistics.add(discountFactor);
      const retainedSlot = retainedSlots[pathIndex];
      if (retainedSlot >= 0) {
        shortRatePath.displayedPaths[retainedSlot].push(nextRate);
        discountPath.displayedPaths[retainedSlot].push(discountFactor);
      }
    }
    shortRatePath.meanPath.push(rateStatistics.mean);
    discountPath.meanPath.push(discountStatistics.mean);
    const rateQuantiles = quantiles(rates, config.quantileLevels);
    const discountQuantiles = quantiles(discountFactors, config.quantileLevels);
    config.quantileLevels.forEach((level, index) => {
      shortRatePath.quantiles[String(level)].push(rateQuantiles[index]);
      discountPath.quantiles[String(level)].push(discountQuantiles[index]);
    });
    const theoretical = shortRateTheoreticalMoments(request, end);
    theoreticalShortRateMeanPath.push(theoretical.rateMean);
    theoreticalDiscountFactorMeanPath.push(theoretical.discountFactorMean);
    discountFactorStandardErrorPath.push(Math.sqrt(discountStatistics.sampleVariance / config.paths));
    if (timeIndex === config.timeSteps) terminalRateStatistics = rateStatistics;
  }

  const terminalPayoffs = new Float64Array(config.paths);
  const discountedValues = new Float64Array(config.paths);
  const underlyingBondValues = request.contract === "bond-option" ? new Float64Array(config.paths) : undefined;
  const terminalPayoffStatistics = new RunningStatistics();
  const discountedValueStatistics = new RunningStatistics();
  const underlyingBondStatistics = new RunningStatistics();
  for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
    if ((pathIndex & 0x3fff) === 0) throwIfCancelled(control);
    let terminalPayoff = 1;
    if (request.contract === "bond-option") {
      const underlyingBond = request.model === "Vasicek"
        ? vasicekBondPrice({
            shortRate: request.shortRate,
            meanReversion: request.meanReversion,
            longRunRate: request.longRunRate!,
            rateVolatility: request.rateVolatility,
          }, request.bondMaturity!, request.maturity, rates[pathIndex])
        : hullWhiteBondPrice({
            shortRate: request.shortRate,
            meanReversion: request.meanReversion,
            rateVolatility: request.rateVolatility,
            curve: curve!,
          }, request.bondMaturity!, request.maturity, rates[pathIndex]);
      underlyingBondValues![pathIndex] = underlyingBond;
      underlyingBondStatistics.add(underlyingBond);
      terminalPayoff = Math.max(underlyingBond - request.strike!, 0);
    }
    const discountedValue = discountFactors[pathIndex] * terminalPayoff;
    terminalPayoffs[pathIndex] = terminalPayoff;
    discountedValues[pathIndex] = discountedValue;
    terminalPayoffStatistics.add(terminalPayoff);
    discountedValueStatistics.add(discountedValue);
  }

  const integratedRateStatistics = new RunningStatistics();
  const discountFactorStatistics = new RunningStatistics();
  for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
    integratedRateStatistics.add(integratedRates[pathIndex]);
    discountFactorStatistics.add(discountFactors[pathIndex]);
  }
  const shortRateSummary: StatePathSummary = {
    time: [...time],
    displayedPathIndices: retainedIndices,
    ...shortRatePath,
  };
  const discountFactorSummary: StatePathSummary = {
    time: [...time],
    displayedPathIndices: [...retainedIndices],
    ...discountPath,
  };
  const curveReproduction: ShortRateCurveReproductionPoint[] | undefined = curve
    ? curve.pillars.flatMap((pillar) => {
        const index = time.findIndex((entry) => Math.abs(entry - pillar.time) <= 1e-10);
        if (index < 0) return [];
        const standardError = discountFactorStandardErrorPath[index];
        const difference = discountPath.meanPath[index] - pillar.discount;
        return [{
          time: pillar.time,
          inputDiscount: pillar.discount,
          simulatedDiscountMean: discountPath.meanPath[index],
          standardError,
          standardizedError: standardError > 0 ? difference / standardError : 0,
        }];
      })
    : undefined;
  const terminalTheory = shortRateTheoreticalMoments(request, request.maturity);

  return {
    model: request.model,
    measure: "Q",
    stateKind: "short-rate-and-discount-factor",
    config: { ...config, quantileLevels: [...config.quantileLevels] },
    simulatedPaths: config.paths,
    runtimeMs: performance.now() - startedAt,
    diagnostics: {
      scheme: "exact-gaussian",
      exactConditionalRateTransition: true,
      exactJointDiscountIntegral: true,
      rateIntegralShockCorrelation: transition.correlation,
      driftConvention: request.model === "Hull–White"
        ? "dr=[theta(t)-a r]dt+sigma dW^Q; r=x+phi from the supplied log-discount curve"
        : "dr=a(b-r)dt+sigma dW^Q",
      curveId: curve?.id ?? false,
      contract: request.contract,
      payoffMethod: request.contract === "zero-coupon-bond"
        ? "pathwise exp(-integral r dt)"
        : "pathwise exp(-integral r dt) times max(P(T,S)-K,0)",
      theoreticalTerminalRateMean: terminalTheory.rateMean,
      theoreticalTerminalRateVariance: terminalTheory.rateVariance,
      theoreticalIntegratedRateMean: terminalTheory.integratedRateMean,
      theoreticalIntegratedRateVariance: terminalTheory.integratedRateVariance,
      theoreticalDiscountFactorMean: terminalTheory.discountFactorMean,
      discountFactorMeanBias: discountFactorStatistics.mean - terminalTheory.discountFactorMean,
      displayedPathCount: retainedIndices.length,
      curveReproductionPointCount: curveReproduction?.length ?? 0,
    },
    shortRate: shortRateSummary,
    discountFactorPath: discountFactorSummary,
    theoreticalShortRateMeanPath,
    theoreticalDiscountFactorMeanPath,
    discountFactorStandardErrorPath,
    terminalShortRate: summaryFromTerminalPath(terminalRateStatistics, shortRateSummary, config.quantileLevels),
    integratedShortRate: sampleSummary(integratedRateStatistics, integratedRates, config.quantileLevels),
    discountFactor: sampleSummary(discountFactorStatistics, discountFactors, config.quantileLevels),
    terminalPayoff: sampleSummary(terminalPayoffStatistics, terminalPayoffs, config.quantileLevels),
    discountedPathValue: sampleSummary(discountedValueStatistics, discountedValues, config.quantileLevels),
    ...(underlyingBondValues ? {
      terminalUnderlyingBond: sampleSummary(underlyingBondStatistics, underlyingBondValues, config.quantileLevels),
    } : {}),
    discountedValue: estimateSummary(discountedValueStatistics),
    ...(curveReproduction ? { curveReproduction } : {}),
  };
}
