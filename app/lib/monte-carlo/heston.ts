import type { HestonParameters } from "../pde-engine/heston.ts";
import { throwIfCancelled, type ComputationControl } from "../computation-control.ts";
import { Mulberry32, NormalSampler } from "./random.ts";
import { RunningStatistics } from "./statistics.ts";
import type {
  EstimateSummary,
  HestonMonteCarloConfig,
  HestonMonteCarloResult,
  SampleSummary,
} from "./types.ts";

const CONFIDENCE_95_Z = 1.959963984540054;

export interface HestonMonteCarloRequest extends HestonParameters {
  config: HestonMonteCarloConfig;
}

export interface CirMoments {
  mean: number;
  variance: number;
}

export type AndersenQeRegime = "quadratic" | "exponential";

export interface AndersenQeVarianceStep {
  nextVariance: number;
  conditionalMean: number;
  conditionalVariance: number;
  psi: number;
  regime: AndersenQeRegime;
  quadraticA?: number;
  quadraticB2?: number;
  atomProbability?: number;
  exponentialRate?: number;
}

export const ANDERSEN_QE_PSI_CUTOFF = 1.5;

// Abramowitz-Stegun 7.1.26. The error is below 7.5e-8 and the symmetry is
// enforced explicitly so antithetic z/-z maps to u/(1-u).
export function standardNormalCdf(value: number): number {
  if (!Number.isFinite(value)) return value < 0 ? 0 : 1;
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = Math.exp(-0.5 * absolute * absolute) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const positive = 1 - tail;
  return value >= 0 ? positive : 1 - positive;
}

/** Exact first two moments of the CIR variance process. */
export function cirMoments(
  parameters: Pick<HestonParameters, "v0" | "kappa" | "theta" | "xi">,
  time: number,
): CirMoments {
  if (!Number.isFinite(time) || time < 0) throw new RangeError("CIR moment time must be finite and non-negative");
  if (![parameters.v0, parameters.kappa, parameters.theta, parameters.xi].every(Number.isFinite)) {
    throw new RangeError("CIR moment parameters must be finite");
  }
  if (parameters.v0 < 0 || parameters.kappa <= 0 || parameters.theta <= 0 || parameters.xi <= 0) {
    throw new RangeError("CIR moments require v0 >= 0 and positive kappa, theta and xi");
  }
  const decay = Math.exp(-parameters.kappa * time);
  const oneMinusDecay = 1 - decay;
  return {
    mean: parameters.theta + (parameters.v0 - parameters.theta) * decay,
    variance: parameters.v0 * parameters.xi ** 2 * decay * oneMinusDecay / parameters.kappa
      + parameters.theta * parameters.xi ** 2 * oneMinusDecay ** 2 / (2 * parameters.kappa),
  };
}

/**
 * One Andersen quadratic-exponential variance transition.
 *
 * The transition matches the exact CIR conditional mean and variance. For
 * psi <= 1.5 it uses a transformed squared normal; above the cutoff it uses
 * an exponential distribution with the correct atom at zero.
 */
export function andersenQeVarianceStep(
  parameters: Pick<HestonParameters, "kappa" | "theta" | "xi">,
  currentVariance: number,
  timeStep: number,
  varianceNormal: number,
  psiCutoff = ANDERSEN_QE_PSI_CUTOFF,
): AndersenQeVarianceStep {
  if (![parameters.kappa, parameters.theta, parameters.xi, currentVariance, timeStep, varianceNormal, psiCutoff].every(Number.isFinite)) {
    throw new RangeError("Andersen QE inputs must be finite.");
  }
  if (parameters.kappa <= 0 || parameters.theta <= 0 || parameters.xi <= 0 || currentVariance < 0 || timeStep <= 0) {
    throw new RangeError("Andersen QE requires positive kappa, theta, xi and time step, with non-negative variance.");
  }
  if (psiCutoff < 1 || psiCutoff > 2) throw new RangeError("Andersen QE psi cutoff must be between 1 and 2.");

  const decay = Math.exp(-parameters.kappa * timeStep);
  const oneMinusDecay = 1 - decay;
  const conditionalMean = parameters.theta + (currentVariance - parameters.theta) * decay;
  const conditionalVariance = currentVariance * parameters.xi ** 2 * decay * oneMinusDecay / parameters.kappa
    + parameters.theta * parameters.xi ** 2 * oneMinusDecay ** 2 / (2 * parameters.kappa);
  const psi = conditionalVariance / (conditionalMean * conditionalMean);

  if (psi <= psiCutoff) {
    const inversePsi = 2 / Math.max(psi, Number.EPSILON);
    const quadraticB2 = inversePsi - 1 + Math.sqrt(Math.max(0, inversePsi * (inversePsi - 1)));
    const quadraticA = conditionalMean / (1 + quadraticB2);
    return {
      nextVariance: quadraticA * (Math.sqrt(quadraticB2) + varianceNormal) ** 2,
      conditionalMean,
      conditionalVariance,
      psi,
      regime: "quadratic",
      quadraticA,
      quadraticB2,
    };
  }

  const atomProbability = (psi - 1) / (psi + 1);
  const exponentialRate = (1 - atomProbability) / conditionalMean;
  const uniform = Math.min(1 - Number.EPSILON, Math.max(0, standardNormalCdf(varianceNormal)));
  return {
    nextVariance: uniform <= atomProbability
      ? 0
      : Math.log((1 - atomProbability) / (1 - uniform)) / exponentialRate,
    conditionalMean,
    conditionalVariance,
    psi,
    regime: "exponential",
    atomProbability,
    exponentialRate,
  };
}

class RunningCorrelation {
  private sampleCount = 0;
  private meanFirst = 0;
  private meanSecond = 0;
  private firstSquaredDeviation = 0;
  private secondSquaredDeviation = 0;
  private coDeviation = 0;

  add(first: number, second: number): void {
    this.sampleCount += 1;
    const firstDelta = first - this.meanFirst;
    const secondDelta = second - this.meanSecond;
    this.meanFirst += firstDelta / this.sampleCount;
    this.meanSecond += secondDelta / this.sampleCount;
    this.firstSquaredDeviation += firstDelta * (first - this.meanFirst);
    this.secondSquaredDeviation += secondDelta * (second - this.meanSecond);
    this.coDeviation += firstDelta * (second - this.meanSecond);
  }

  get correlation(): number {
    if (this.sampleCount < 2) return Number.NaN;
    return this.coDeviation / Math.sqrt(this.firstSquaredDeviation * this.secondSquaredDeviation);
  }
}

function validateRequest(request: HestonMonteCarloRequest): void {
  const parameters = [
    request.spot,
    request.strike,
    request.maturity,
    request.rate,
    request.dividend,
    request.v0,
    request.kappa,
    request.theta,
    request.xi,
    request.rho,
  ];
  if (!parameters.every(Number.isFinite)) throw new Error("Heston Monte Carlo parameters must be finite.");
  if (request.spot <= 0 || request.strike <= 0 || request.maturity <= 0) {
    throw new Error("Spot, strike and maturity must be positive.");
  }
  if (request.v0 < 0 || request.kappa <= 0 || request.theta <= 0 || request.xi <= 0) {
    throw new Error("Heston requires v0 >= 0 and positive kappa, theta and xi.");
  }
  if (request.rho < -1 || request.rho > 1) throw new Error("Heston correlation rho must be between -1 and 1.");
  if (request.side !== "Call" && request.side !== "Put") throw new Error("Side must be Call or Put.");

  const { config } = request;
  if (config.model !== "Heston" || (config.scheme !== "full-truncation-euler" && config.scheme !== "andersen-qe")) {
    throw new Error("Heston Monte Carlo requires full-truncation-euler or andersen-qe.");
  }
  if (!config.enabled) throw new Error("Monte Carlo must be enabled before running the simulator.");
  if (!Number.isInteger(config.paths) || config.paths < 2) {
    throw new Error("Monte Carlo paths must be an integer of at least 2.");
  }
  if (!Number.isInteger(config.timeSteps) || config.timeSteps < 1) {
    throw new Error("Monte Carlo time steps must be a positive integer.");
  }
  if (!Number.isInteger(config.displayPathLimit) || config.displayPathLimit < 1) {
    throw new Error("Display path limit must be a positive integer.");
  }
  if (config.quantileLevels.length === 0) throw new Error("At least one quantile level is required.");
  if (config.quantileLevels.some((level) => !Number.isFinite(level) || level < 0 || level > 1)) {
    throw new Error("Quantile levels must be finite and between 0 and 1.");
  }
  if (new Set(config.quantileLevels.map(String)).size !== config.quantileLevels.length) {
    throw new Error("Quantile levels must be unique.");
  }
  const varianceReduction = config.varianceReduction ?? "none";
  if (varianceReduction !== "none" && varianceReduction !== "antithetic") {
    throw new Error("Heston variance reduction must be none or antithetic.");
  }
  if (varianceReduction === "antithetic" && config.paths % 2 !== 0) {
    throw new Error("Antithetic Heston simulation requires an even path count.");
  }
}

function displayIndices(pathCount: number, requestedLimit: number): number[] {
  const count = Math.min(pathCount, requestedLimit);
  if (count === 1) return [0];
  return Array.from(
    { length: count },
    (_, index) => Math.round(index * (pathCount - 1) / (count - 1)),
  );
}

function selectKth(values: number[], target: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = values[Math.floor((left + right) / 2)];
    let lower = left;
    let upper = right;
    while (lower <= upper) {
      while (values[lower] < pivot) lower += 1;
      while (values[upper] > pivot) upper -= 1;
      if (lower <= upper) {
        [values[lower], values[upper]] = [values[upper], values[lower]];
        lower += 1;
        upper -= 1;
      }
    }
    if (target <= upper) right = upper;
    else if (target >= lower) left = lower;
    else return values[target];
  }
  return values[target];
}

/** R-7/NumPy-linear quantiles using selection rather than a full sort. */
function selectedQuantiles(values: ArrayLike<number>, levels: readonly number[]): number[] {
  const working = Array.from(values);
  return levels.map((level) => {
    const position = (working.length - 1) * level;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const weight = position - lowerIndex;
    const lower = selectKth(working, lowerIndex);
    const upper = lowerIndex === upperIndex ? lower : selectKth(working, upperIndex);
    return lower * (1 - weight) + upper * weight;
  });
}

function quantileRecord(
  values: ArrayLike<number>,
  levels: readonly number[],
): Record<string, number> {
  const calculated = selectedQuantiles(values, levels);
  return Object.fromEntries(levels.map((level, index) => [String(level), calculated[index]]));
}

function terminalQuantileRecord(
  pathQuantiles: Record<string, number[]>,
  levels: readonly number[],
): Record<string, number> {
  return Object.fromEntries(levels.map((level) => {
    const values = pathQuantiles[String(level)];
    return [String(level), values[values.length - 1]];
  }));
}

function sampleSummary(
  statistics: RunningStatistics,
  quantileValues: Record<string, number>,
): SampleSummary {
  const variance = statistics.sampleVariance;
  return {
    count: statistics.count,
    mean: statistics.mean,
    variance,
    standardDeviation: Math.sqrt(variance),
    minimum: statistics.minimum,
    maximum: statistics.maximum,
    quantiles: quantileValues,
  };
}

function discountedEstimate(
  payoffStatistics: RunningStatistics,
  discountFactor: number,
  estimatorStatistics = payoffStatistics,
): EstimateSummary {
  const mean = discountFactor * payoffStatistics.mean;
  const standardError = discountFactor
    * Math.sqrt(estimatorStatistics.sampleVariance / estimatorStatistics.count);
  const margin = CONFIDENCE_95_Z * standardError;
  return { mean, standardError, confidence95: [mean - margin, mean + margin] };
}

function payoff(request: HestonMonteCarloRequest, terminalStock: number): number {
  return request.side === "Call"
    ? Math.max(terminalStock - request.strike, 0)
    : Math.max(request.strike - terminalStock, 0);
}

/**
 * Risk-neutral Heston Monte Carlo with either projected full-truncation Euler
 * or Andersen's QE-M scheme. QE uses psi_c=1.5, central gamma weights and the
 * conditional martingale correction. Optional antithetic variates pair z and
 * -z and calculate standard error from independent pair-average observations;
 * the estimator remains the arithmetic average of every path payoff.
 */
export function simulateHestonMonteCarlo(
  request: HestonMonteCarloRequest,
  control?: ComputationControl,
): HestonMonteCarloResult {
  validateRequest(request);
  throwIfCancelled(control);
  const startedAt = performance.now();
  const { config } = request;
  const scheme = config.scheme;
  const varianceReduction = config.varianceReduction ?? "none";
  const antithetic = varianceReduction === "antithetic";
  const timeStep = request.maturity / config.timeSteps;
  const rootTimeStep = Math.sqrt(timeStep);
  const normal = new NormalSampler(new Mulberry32(config.seed));
  const shockCorrelation = new RunningCorrelation();
  const orthogonalCorrelation = new RunningCorrelation();
  const spots = new Float64Array(config.paths);
  const variances = new Float64Array(config.paths);
  spots.fill(request.spot);
  variances.fill(request.v0);

  const rootOneMinusRhoSquared = Math.sqrt(Math.max(0, 1 - request.rho ** 2));
  const gamma1 = 0.5;
  const gamma2 = 0.5;
  const qeK1 = gamma1 * timeStep * (request.kappa * request.rho / request.xi - 0.5) - request.rho / request.xi;
  const qeK2 = gamma2 * timeStep * (request.kappa * request.rho / request.xi - 0.5) + request.rho / request.xi;
  const qeK3 = gamma1 * timeStep * (1 - request.rho ** 2);
  const qeK4 = gamma2 * timeStep * (1 - request.rho ** 2);
  const qeA = qeK2 + 0.5 * qeK4;

  const retainedIndices = displayIndices(config.paths, config.displayPathLimit);
  const retainedSlots = new Int32Array(config.paths);
  retainedSlots.fill(-1);
  retainedIndices.forEach((pathIndex, slot) => {
    retainedSlots[pathIndex] = slot;
  });
  const displayedStockPaths = retainedIndices.map(() => [request.spot]);
  const displayedVariancePaths = retainedIndices.map(() => [request.v0]);
  const time = Array.from(
    { length: config.timeSteps + 1 },
    (_, index) => index * timeStep,
  );
  const stockMeanPath = [request.spot];
  const varianceMeanPath = [request.v0];
  const stockQuantiles = Object.fromEntries(
    config.quantileLevels.map((level) => [String(level), [request.spot]]),
  ) as Record<string, number[]>;
  const varianceQuantiles = Object.fromEntries(
    config.quantileLevels.map((level) => [String(level), [request.v0]]),
  ) as Record<string, number[]>;

  const correctedPaths = new Uint8Array(config.paths);
  let rawNegativeVarianceSteps = 0;
  let zeroVarianceSteps = 0;
  let minimumRawVariance = request.v0;
  let minimumReturnedVariance = request.v0;
  let maximumReturnedVariance = request.v0;
  let qeQuadraticRegimeSteps = 0;
  let qeExponentialRegimeSteps = 0;
  let terminalStockStatistics = new RunningStatistics();
  let terminalVarianceStatistics = new RunningStatistics();

  for (let timeIndex = 1; timeIndex <= config.timeSteps; timeIndex += 1) {
    throwIfCancelled(control);
    const stockSliceStatistics = new RunningStatistics();
    const varianceSliceStatistics = new RunningStatistics();
    const pathStride = antithetic ? 2 : 1;
    for (let pathIndex = 0; pathIndex < config.paths; pathIndex += pathStride) {
      if ((pathIndex & 0x3fff) === 0) throwIfCancelled(control);
      const firstNormal = normal.next();
      const secondNormal = normal.next();
      for (let leg = 0; leg < pathStride; leg += 1) {
        const currentPathIndex = pathIndex + leg;
        const sign = leg === 0 ? 1 : -1;
        const firstDriver = sign * firstNormal;
        const secondDriver = sign * secondNormal;
        const variance = Math.max(variances[currentPathIndex], 0);
        let nextSpot: number;
        let nextVariance: number;
        let rawVariance: number;

        if (scheme === "full-truncation-euler") {
          const stockShock = firstDriver;
          const varianceShock = request.rho * firstDriver + rootOneMinusRhoSquared * secondDriver;
          shockCorrelation.add(stockShock, varianceShock);
          orthogonalCorrelation.add(firstDriver, secondDriver);
          const rootVarianceTime = Math.sqrt(variance) * rootTimeStep;
          nextSpot = spots[currentPathIndex] * Math.exp(
            (request.rate - request.dividend - 0.5 * variance) * timeStep
              + rootVarianceTime * stockShock,
          );
          rawVariance = variance
            + request.kappa * (request.theta - variance) * timeStep
            + request.xi * rootVarianceTime * varianceShock;
          nextVariance = Math.max(rawVariance, 0);
          if (rawVariance < 0) {
            rawNegativeVarianceSteps += 1;
            correctedPaths[currentPathIndex] = 1;
          }
        } else {
          const stockOrthogonalNormal = firstDriver;
          const varianceNormal = secondDriver;
          const impliedStockBrownian = request.rho * varianceNormal + rootOneMinusRhoSquared * stockOrthogonalNormal;
          shockCorrelation.add(impliedStockBrownian, varianceNormal);
          orthogonalCorrelation.add(stockOrthogonalNormal, varianceNormal);
          const transition = andersenQeVarianceStep(request, variance, timeStep, varianceNormal);
          nextVariance = transition.nextVariance;
          rawVariance = nextVariance;
          if (transition.regime === "quadratic") qeQuadraticRegimeSteps += 1;
          else qeExponentialRegimeSteps += 1;

          let martingaleCorrection: number;
          if (transition.regime === "quadratic") {
            const quadraticA = transition.quadraticA!;
            const quadraticB2 = transition.quadraticB2!;
            const denominator = 1 - 2 * qeA * quadraticA;
            if (!(denominator > 0)) throw new Error("Andersen QE martingale correction is not finite; refine the simulation time grid.");
            martingaleCorrection = -qeA * quadraticB2 * quadraticA / denominator
              + 0.5 * Math.log(denominator)
              - (qeK1 + 0.5 * qeK3) * variance;
          } else {
            const atomProbability = transition.atomProbability!;
            const exponentialRate = transition.exponentialRate!;
            if (!(qeA < exponentialRate)) throw new Error("Andersen QE exponential-regime martingale correction is not finite; refine the simulation time grid.");
            martingaleCorrection = -Math.log(
              atomProbability + exponentialRate * (1 - atomProbability) / (exponentialRate - qeA),
            ) - (qeK1 + 0.5 * qeK3) * variance;
          }
          nextSpot = spots[currentPathIndex] * Math.exp(
            (request.rate - request.dividend) * timeStep
              + martingaleCorrection
              + qeK1 * variance
              + qeK2 * nextVariance
              + Math.sqrt(Math.max(0, qeK3 * variance + qeK4 * nextVariance)) * stockOrthogonalNormal,
          );
        }

        if (!Number.isFinite(nextSpot) || !Number.isFinite(nextVariance)) {
          throw new Error("Heston Monte Carlo produced a non-finite state; reduce parameters or refine the time grid.");
        }
        if (nextVariance === 0) zeroVarianceSteps += 1;
        minimumRawVariance = Math.min(minimumRawVariance, rawVariance);
        minimumReturnedVariance = Math.min(minimumReturnedVariance, nextVariance);
        maximumReturnedVariance = Math.max(maximumReturnedVariance, nextVariance);
        spots[currentPathIndex] = nextSpot;
        variances[currentPathIndex] = nextVariance;
        stockSliceStatistics.add(nextSpot);
        varianceSliceStatistics.add(nextVariance);

        const retainedSlot = retainedSlots[currentPathIndex];
        if (retainedSlot >= 0) {
          displayedStockPaths[retainedSlot].push(nextSpot);
          displayedVariancePaths[retainedSlot].push(nextVariance);
        }
      }
    }

    stockMeanPath.push(stockSliceStatistics.mean);
    varianceMeanPath.push(varianceSliceStatistics.mean);
    const stockSliceQuantiles = selectedQuantiles(spots, config.quantileLevels);
    const varianceSliceQuantiles = selectedQuantiles(variances, config.quantileLevels);
    config.quantileLevels.forEach((level, index) => {
      stockQuantiles[String(level)].push(stockSliceQuantiles[index]);
      varianceQuantiles[String(level)].push(varianceSliceQuantiles[index]);
    });
    if (timeIndex === config.timeSteps) {
      terminalStockStatistics = stockSliceStatistics;
      terminalVarianceStatistics = varianceSliceStatistics;
    }
  }

  const payoffValues = new Float64Array(config.paths);
  const payoffStatistics = new RunningStatistics();
  for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
    if ((pathIndex & 0x3fff) === 0) throwIfCancelled(control);
    const value = payoff(request, spots[pathIndex]);
    payoffValues[pathIndex] = value;
    payoffStatistics.add(value);
  }
  const estimatorStatistics = new RunningStatistics();
  if (antithetic) {
    for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 2) {
      estimatorStatistics.add(0.5 * (payoffValues[pathIndex] + payoffValues[pathIndex + 1]));
    }
  } else {
    for (const value of payoffValues) estimatorStatistics.add(value);
  }

  const discountFactor = Math.exp(-request.rate * request.maturity);
  const theoreticalStockMean = request.spot * Math.exp((request.rate - request.dividend) * request.maturity);
  const theoreticalVariance = cirMoments(request, request.maturity);
  const totalVarianceSteps = config.paths * config.timeSteps;
  const correctedPathCount = correctedPaths.reduce((total, corrected) => total + corrected, 0);
  const sampledShockCorrelation = shockCorrelation.correlation;

  return {
    model: "Heston",
    measure: "Q",
    stateKind: "stock-and-variance",
    config: { ...config, quantileLevels: [...config.quantileLevels] },
    simulatedPaths: config.paths,
    runtimeMs: performance.now() - startedAt,
    diagnostics: {
      scheme,
      varianceReduction,
      antitheticPairCount: antithetic ? config.paths / 2 : 0,
      estimatorObservationCount: estimatorStatistics.count,
      standardErrorMethod: antithetic ? "independent antithetic pair averages" : "independent path payoffs",
      nonNegativeVarianceTreatment: scheme === "andersen-qe"
        ? "Andersen QE non-negative conditional distribution with an atom at zero in the exponential regime"
        : "project raw Euler variance to max(raw, 0)",
      displayedPathCount: displayedStockPaths.length,
      discountFactor,
      requestedShockCorrelation: request.rho,
      sampledShockCorrelation,
      sampledOrthogonalNormalCorrelation: orthogonalCorrelation.correlation,
      correlationHandling: scheme === "andersen-qe"
        ? "rho/xi log-stock coupling plus an independent orthogonal stock normal"
        : "correlated stock and variance Brownian shocks",
      qePsiCutoff: ANDERSEN_QE_PSI_CUTOFF,
      qeMartingaleCorrection: scheme === "andersen-qe",
      theoreticalTerminalStockMean: theoreticalStockMean,
      terminalStockMeanBias: terminalStockStatistics.mean - theoreticalStockMean,
      terminalStockMeanRelativeBias: terminalStockStatistics.mean / theoreticalStockMean - 1,
    },
    stock: {
      time,
      displayedPathIndices: retainedIndices,
      displayedPaths: displayedStockPaths,
      meanPath: stockMeanPath,
      quantiles: stockQuantiles,
    },
    variance: {
      time: [...time],
      displayedPathIndices: [...retainedIndices],
      displayedPaths: displayedVariancePaths,
      meanPath: varianceMeanPath,
      quantiles: varianceQuantiles,
    },
    terminalVariance: sampleSummary(
      terminalVarianceStatistics,
      terminalQuantileRecord(varianceQuantiles, config.quantileLevels),
    ),
    varianceDiagnostics: {
      treatment: scheme === "andersen-qe" ? "Andersen QE conditional moment matching" : "projected full-truncation Euler",
      rawNegativeVarianceSteps,
      correctionFraction: rawNegativeVarianceSteps / totalVarianceSteps,
      correctedPaths: correctedPathCount,
      correctedPathFraction: correctedPathCount / config.paths,
      zeroVarianceSteps,
      zeroVarianceStepFraction: zeroVarianceSteps / totalVarianceSteps,
      minimumRawVariance,
      minimumReturnedVariance,
      maximumReturnedVariance,
      fellerRatio: 2 * request.kappa * request.theta / request.xi ** 2,
      fellerSatisfied: 2 * request.kappa * request.theta >= request.xi ** 2,
      theoreticalTerminalMean: theoreticalVariance.mean,
      theoreticalTerminalVariance: theoreticalVariance.variance,
      terminalMeanBias: terminalVarianceStatistics.mean - theoreticalVariance.mean,
      qePsiCutoff: ANDERSEN_QE_PSI_CUTOFF,
      qeQuadraticRegimeSteps,
      qeQuadraticRegimeFraction: qeQuadraticRegimeSteps / totalVarianceSteps,
      qeExponentialRegimeSteps,
      qeExponentialRegimeFraction: qeExponentialRegimeSteps / totalVarianceSteps,
      martingaleCorrection: scheme === "andersen-qe",
    },
    payoff: {
      terminalStock: sampleSummary(
        terminalStockStatistics,
        terminalQuantileRecord(stockQuantiles, config.quantileLevels),
      ),
      undiscountedPayoff: sampleSummary(
        payoffStatistics,
        quantileRecord(payoffValues, config.quantileLevels),
      ),
      discountedValue: discountedEstimate(payoffStatistics, discountFactor, estimatorStatistics),
    },
  };
}
