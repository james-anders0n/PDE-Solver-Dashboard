import type { BarrierDirection, BlackScholesParameters } from "../pde-engine/black-scholes.ts";
import { throwIfCancelled, type ComputationControl } from "../computation-control.ts";
import { Mulberry32, NormalSampler } from "./random.ts";
import { quantileRecord, quantiles, RunningStatistics } from "./statistics.ts";
import type {
  BlackScholesMonteCarloConfig,
  BlackScholesMonteCarloResult,
  EstimateSummary,
  SampleSummary,
} from "./types.ts";

const CONFIDENCE_95_Z = 1.959963984540054;

export type BlackScholesMonteCarloContract = "european" | "digital" | "barrier";

export interface BlackScholesMonteCarloRequest extends BlackScholesParameters {
  contract: BlackScholesMonteCarloContract;
  barrier?: number;
  barrierDirection?: BarrierDirection;
  config: BlackScholesMonteCarloConfig;
}

export interface GbmMoments {
  mean: number;
  variance: number;
}

/** Exact risk-neutral first two moments of geometric Brownian motion. */
export function gbmMoments(
  parameters: Pick<BlackScholesParameters, "spot" | "rate" | "dividend" | "volatility">,
  time: number,
): GbmMoments {
  if (!Number.isFinite(time) || time < 0) throw new RangeError("GBM moment time must be finite and non-negative");
  const growth = Math.exp((parameters.rate - parameters.dividend) * time);
  const mean = parameters.spot * growth;
  return {
    mean,
    variance: mean * mean * Math.expm1(parameters.volatility * parameters.volatility * time),
  };
}

function validateRequest(request: BlackScholesMonteCarloRequest): void {
  const parameters = [
    request.spot,
    request.strike,
    request.maturity,
    request.rate,
    request.dividend,
    request.volatility,
  ];
  if (!parameters.every(Number.isFinite)) throw new Error("Black–Scholes Monte Carlo parameters must be finite.");
  if (request.spot <= 0 || request.strike <= 0 || request.maturity <= 0 || request.volatility <= 0) {
    throw new Error("Spot, strike, maturity and volatility must be positive.");
  }
  if (request.side !== "Call" && request.side !== "Put") throw new Error("Side must be Call or Put.");
  if (request.contract !== "european" && request.contract !== "digital" && request.contract !== "barrier") {
    throw new Error("GBM Monte Carlo supports European vanilla, digital, and continuous knock-out barrier contracts.");
  }
  if (request.contract === "barrier") {
    if (!Number.isFinite(request.barrier) || (request.barrier ?? 0) <= 0) {
      throw new Error("Barrier Monte Carlo requires a finite positive barrier.");
    }
    if (request.barrierDirection !== "up-and-out" && request.barrierDirection !== "down-and-out") {
      throw new Error("Barrier Monte Carlo requires an up-and-out or down-and-out direction.");
    }
    if (request.barrierDirection === "up-and-out" && request.barrier! <= request.spot) {
      throw new Error("A live up-and-out barrier must be above the initial spot.");
    }
    if (request.barrierDirection === "down-and-out" && request.barrier! >= request.spot) {
      throw new Error("A live down-and-out barrier must be below the initial spot.");
    }
  }

  const { config } = request;
  if (config.model !== "Black–Scholes" || config.scheme !== "exact-gbm") {
    throw new Error("Black–Scholes Monte Carlo requires the exact-gbm configuration.");
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
}

function displayIndices(pathCount: number, requestedLimit: number): number[] {
  const count = Math.min(pathCount, requestedLimit);
  if (count === 1) return [0];
  return Array.from(
    { length: count },
    (_, index) => Math.round(index * (pathCount - 1) / (count - 1)),
  );
}

function payoff(request: BlackScholesMonteCarloRequest, terminalStock: number): number {
  if (request.contract === "digital") {
    return request.side === "Call"
      ? Number(terminalStock > request.strike)
      : Number(terminalStock < request.strike);
  }
  return request.side === "Call"
    ? Math.max(terminalStock - request.strike, 0)
    : Math.max(request.strike - terminalStock, 0);
}

/**
 * Conditional crossing probability for a continuously monitored log-GBM
 * Brownian bridge. Conditional on two exact log-price endpoints the drift
 * cancels, leaving bridge variance `sigma^2 * dt` and crossing probability
 * `exp(-2ab / (sigma^2 * dt))` for positive log-distances a and b.
 */
export function brownianBridgeBarrierCrossingProbability(
  startSpot: number,
  endSpot: number,
  barrier: number,
  direction: BarrierDirection,
  volatility: number,
  timeStep: number,
): number {
  if (direction !== "up-and-out" && direction !== "down-and-out") {
    throw new RangeError("Brownian-bridge barrier direction must be up-and-out or down-and-out.");
  }
  if (![startSpot, endSpot, barrier, volatility, timeStep].every(Number.isFinite)
    || startSpot <= 0 || endSpot <= 0 || barrier <= 0 || volatility <= 0 || timeStep <= 0) {
    throw new RangeError("Brownian-bridge barrier inputs must be finite and positive.");
  }
  const startDistance = direction === "up-and-out"
    ? Math.log(barrier / startSpot)
    : Math.log(startSpot / barrier);
  const endDistance = direction === "up-and-out"
    ? Math.log(barrier / endSpot)
    : Math.log(endSpot / barrier);
  if (startDistance <= 0 || endDistance <= 0) return 1;
  return Math.min(1, Math.max(0, Math.exp(
    -2 * startDistance * endDistance / (volatility * volatility * timeStep),
  )));
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
): EstimateSummary {
  const mean = discountFactor * payoffStatistics.mean;
  const standardError = discountFactor
    * Math.sqrt(payoffStatistics.sampleVariance / payoffStatistics.count);
  const margin = CONFIDENCE_95_Z * standardError;
  return { mean, standardError, confidence95: [mean - margin, mean + margin] };
}

/**
 * Simulate Black–Scholes paths with the exact GBM transition under Q.
 *
 * Paths are advanced time-slice by time-slice. This retains one value per
 * simulated path for quantiles, plus only the deterministic display subset,
 * instead of retaining the full path matrix.
 */
export function simulateBlackScholesMonteCarlo(
  request: BlackScholesMonteCarloRequest,
  control?: ComputationControl,
): BlackScholesMonteCarloResult {
  validateRequest(request);
  throwIfCancelled(control);
  const startedAt = performance.now();
  const { config } = request;
  const timeStep = request.maturity / config.timeSteps;
  const driftStep = (request.rate - request.dividend - 0.5 * request.volatility ** 2) * timeStep;
  const diffusionStep = request.volatility * Math.sqrt(timeStep);
  const random = new NormalSampler(new Mulberry32(config.seed));
  const spots = new Float64Array(config.paths);
  spots.fill(request.spot);
  const barrierSurvivalWeights = request.contract === "barrier"
    ? new Float64Array(config.paths).fill(1)
    : undefined;
  const discreteBarrierAlive = request.contract === "barrier"
    ? new Uint8Array(config.paths).fill(1)
    : undefined;
  const bridgeCrossingStatistics = new RunningStatistics();
  let bridgeIntervalCount = 0;

  const retainedIndices = displayIndices(config.paths, config.displayPathLimit);
  const retainedSlots = new Int32Array(config.paths);
  retainedSlots.fill(-1);
  retainedIndices.forEach((pathIndex, slot) => {
    retainedSlots[pathIndex] = slot;
  });
  const displayedPaths = retainedIndices.map(() => [request.spot]);
  const time = Array.from(
    { length: config.timeSteps + 1 },
    (_, index) => index * timeStep,
  );
  const meanPath = [request.spot];
  const pathQuantiles = Object.fromEntries(
    config.quantileLevels.map((level) => [String(level), [request.spot]]),
  ) as Record<string, number[]>;

  let terminalStatistics = new RunningStatistics();
  for (let timeIndex = 1; timeIndex <= config.timeSteps; timeIndex += 1) {
    throwIfCancelled(control);
    const sliceStatistics = new RunningStatistics();
    for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
      if ((pathIndex & 0x3fff) === 0) throwIfCancelled(control);
      const previousSpot = spots[pathIndex];
      const nextSpot = previousSpot * Math.exp(driftStep + diffusionStep * random.next());
      if (barrierSurvivalWeights && discreteBarrierAlive) {
        const endpointBreach = request.barrierDirection === "up-and-out"
          ? nextSpot >= request.barrier!
          : nextSpot <= request.barrier!;
        if (endpointBreach) {
          barrierSurvivalWeights[pathIndex] = 0;
          discreteBarrierAlive[pathIndex] = 0;
        } else if (barrierSurvivalWeights[pathIndex] > 0) {
          const crossingProbability = brownianBridgeBarrierCrossingProbability(
            previousSpot,
            nextSpot,
            request.barrier!,
            request.barrierDirection!,
            request.volatility,
            timeStep,
          );
          barrierSurvivalWeights[pathIndex] *= 1 - crossingProbability;
          bridgeCrossingStatistics.add(crossingProbability);
          bridgeIntervalCount += 1;
        }
      }
      spots[pathIndex] = nextSpot;
      sliceStatistics.add(nextSpot);
      const retainedSlot = retainedSlots[pathIndex];
      if (retainedSlot >= 0) displayedPaths[retainedSlot].push(nextSpot);
    }
    meanPath.push(sliceStatistics.mean);
    const sliceQuantiles = quantiles(spots, config.quantileLevels);
    config.quantileLevels.forEach((level, index) => {
      pathQuantiles[String(level)].push(sliceQuantiles[index]);
    });
    if (timeIndex === config.timeSteps) terminalStatistics = sliceStatistics;
  }

  const terminalQuantiles = Object.fromEntries(
    config.quantileLevels.map((level) => {
      const values = pathQuantiles[String(level)];
      return [String(level), values[values.length - 1]];
    }),
  );
  const payoffValues = new Float64Array(config.paths);
  const payoffStatistics = new RunningStatistics();
  const discreteMonitoringPayoffStatistics = new RunningStatistics();
  const survivalStatistics = new RunningStatistics();
  for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
    if ((pathIndex & 0x3fff) === 0) throwIfCancelled(control);
    const terminalPayoff = payoff(request, spots[pathIndex]);
    const survivalWeight = barrierSurvivalWeights?.[pathIndex] ?? 1;
    const value = terminalPayoff * survivalWeight;
    payoffValues[pathIndex] = value;
    payoffStatistics.add(value);
    survivalStatistics.add(survivalWeight);
    discreteMonitoringPayoffStatistics.add(terminalPayoff * (discreteBarrierAlive?.[pathIndex] ?? 1));
  }
  const discountFactor = Math.exp(-request.rate * request.maturity);
  const theoreticalTerminal = gbmMoments(request, request.maturity);
  const continuousBarrierValue = discountFactor * payoffStatistics.mean;
  const discreteMonitoringValue = discountFactor * discreteMonitoringPayoffStatistics.mean;
  const endpointBreachCount = discreteBarrierAlive
    ? discreteBarrierAlive.reduce((count, alive) => count + Number(alive === 0), 0)
    : 0;

  return {
    model: "Black–Scholes",
    measure: "Q",
    stateKind: "stock",
    config: { ...config, quantileLevels: [...config.quantileLevels] },
    simulatedPaths: config.paths,
    runtimeMs: performance.now() - startedAt,
    diagnostics: {
      exactTransition: true,
      contract: request.contract,
      payoffMethod: request.contract === "barrier"
        ? "terminal intrinsic payoff times Brownian-bridge conditional survival weight"
        : request.contract === "digital" ? "strict terminal cash indicator" : "terminal vanilla intrinsic payoff",
      monitoring: request.contract === "barrier" ? "continuous" : "terminal-only",
      ...(request.contract === "barrier" ? {
        brownianBridgeCorrection: true,
        barrier: request.barrier!,
        barrierDirection: request.barrierDirection!,
        bridgeIntervalCount,
        meanConditionalCrossingProbability: bridgeCrossingStatistics.count > 0 ? bridgeCrossingStatistics.mean : 0,
        meanSurvivalWeight: survivalStatistics.mean,
        effectiveContinuousKnockoutProbability: 1 - survivalStatistics.mean,
        endpointBreachCount,
        endpointBreachFraction: endpointBreachCount / config.paths,
        discreteMonitoringValue,
        continuousMonitoringValue: continuousBarrierValue,
        monitoringBiasEstimate: discreteMonitoringValue - continuousBarrierValue,
      } : {}),
      displayedPathCount: displayedPaths.length,
      theoreticalTerminalMean: theoreticalTerminal.mean,
      theoreticalTerminalVariance: theoreticalTerminal.variance,
      discountFactor,
    },
    stock: {
      time,
      displayedPathIndices: retainedIndices,
      displayedPaths,
      meanPath,
      quantiles: pathQuantiles,
    },
    payoff: {
      terminalStock: sampleSummary(terminalStatistics, terminalQuantiles),
      undiscountedPayoff: sampleSummary(
        payoffStatistics,
        quantileRecord(payoffValues, config.quantileLevels),
      ),
      discountedValue: discountedEstimate(payoffStatistics, discountFactor),
    },
  };
}
