import { throwIfCancelled, type ComputationControl } from "../computation-control.ts";
import {
  mertonUtility,
  type MertonResult,
  type MertonTimeLayer,
} from "../pde-engine/merton-hjb.ts";
import { Mulberry32, NormalSampler } from "./random.ts";
import { quantileRecord, quantiles, RunningStatistics } from "./statistics.ts";
import type {
  EstimateSummary,
  MertonMonteCarloConfig,
  MertonMonteCarloResult,
  SampleSummary,
} from "./types.ts";

const CONFIDENCE_95_Z = 1.959963984540054;

export interface MertonPolicyMonteCarloRequest {
  solved: MertonResult;
  config: MertonMonteCarloConfig;
}

export interface InterpolatedMertonPolicy {
  policy: number;
  belowDomain: boolean;
  aboveDomain: boolean;
  lowerTimeLayerTau: number;
  upperTimeLayerTau: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function interpolateLayerPolicy(
  nodes: readonly number[],
  layer: MertonTimeLayer,
  wealth: number,
): { policy: number; belowDomain: boolean; aboveDomain: boolean } {
  if (wealth <= nodes[0]) return { policy: 0, belowDomain: wealth < nodes[0], aboveDomain: false };
  const lastIndex = nodes.length - 1;
  if (wealth >= nodes[lastIndex]) {
    return { policy: layer.policies[lastIndex], belowDomain: false, aboveDomain: wealth > nodes[lastIndex] };
  }
  let low = 0;
  let high = lastIndex;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (nodes[middle] <= wealth) low = middle;
    else high = middle;
  }
  const weight = (wealth - nodes[low]) / (nodes[high] - nodes[low]);
  return {
    policy: layer.policies[low] * (1 - weight) + layer.policies[high] * weight,
    belowDomain: false,
    aboveDomain: false,
  };
}

/** Interpolate the solved feedback policy at calendar time t and wealth W. */
export function interpolateMertonFeedbackPolicy(
  solved: MertonResult,
  wealth: number,
  calendarTime: number,
): InterpolatedMertonPolicy {
  if (!Number.isFinite(wealth) || !Number.isFinite(calendarTime) || calendarTime < 0 || calendarTime > solved.parameters.maturity) {
    throw new RangeError("Merton policy interpolation requires finite wealth and calendar time in [0,T].");
  }
  const tau = solved.parameters.maturity - calendarTime;
  const layers = solved.solution.layers;
  let lower = layers[0];
  let upper = layers[layers.length - 1];
  if (tau <= layers[0].tau) upper = lower;
  else if (tau >= layers[layers.length - 1].tau) lower = upper;
  else {
    let lowIndex = 0;
    let highIndex = layers.length - 1;
    while (highIndex - lowIndex > 1) {
      const middle = Math.floor((lowIndex + highIndex) / 2);
      if (layers[middle].tau <= tau) lowIndex = middle;
      else highIndex = middle;
    }
    lower = layers[lowIndex];
    upper = layers[highIndex];
    const timeTolerance = 1e-12 * Math.max(1, solved.parameters.maturity);
    if (Math.abs(tau - lower.tau) <= timeTolerance) upper = lower;
    else if (Math.abs(tau - upper.tau) <= timeTolerance) lower = upper;
  }
  const lowerPolicy = interpolateLayerPolicy(solved.solution.nodes, lower, wealth);
  const upperPolicy = interpolateLayerPolicy(solved.solution.nodes, upper, wealth);
  const timeWeight = upper.tau === lower.tau ? 0 : (tau - lower.tau) / (upper.tau - lower.tau);
  return {
    policy: clamp(
      lowerPolicy.policy * (1 - timeWeight) + upperPolicy.policy * timeWeight,
      solved.parameters.controlMin,
      solved.parameters.controlMax,
    ),
    belowDomain: lowerPolicy.belowDomain || upperPolicy.belowDomain,
    aboveDomain: lowerPolicy.aboveDomain || upperPolicy.aboveDomain,
    lowerTimeLayerTau: lower.tau,
    upperTimeLayerTau: upper.tau,
  };
}

function validateRequest(request: MertonPolicyMonteCarloRequest): void {
  const { solved, config } = request;
  if (config.model !== "HJB" || config.scheme !== "feedback-policy-euler") {
    throw new Error("Merton policy Monte Carlo requires the HJB feedback-policy-euler configuration.");
  }
  if (!config.enabled) throw new Error("Monte Carlo must be enabled before running the policy simulator.");
  if (!Number.isInteger(config.paths) || config.paths < 2) throw new Error("Monte Carlo paths must be an integer of at least 2.");
  if (!Number.isInteger(config.timeSteps) || config.timeSteps < 1) throw new Error("Monte Carlo time steps must be a positive integer.");
  if (!Number.isInteger(config.displayPathLimit) || config.displayPathLimit < 1) throw new Error("Display path limit must be a positive integer.");
  if (config.quantileLevels.length === 0 || config.quantileLevels.some((level) => !Number.isFinite(level) || level < 0 || level > 1)) {
    throw new Error("Quantile levels must be finite and between zero and one.");
  }
  if (!solved.solution.diagnostics.finite || !solved.solution.diagnostics.policyConverged) {
    throw new Error("Merton policy simulation requires a finite, converged HJB solution.");
  }
  if (solved.solution.layers.length < 2) throw new Error("Merton policy simulation requires captured policy time layers.");
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
  return { mean: statistics.mean, standardError, confidence95: [statistics.mean - margin, statistics.mean + margin] };
}

/**
 * Forward-evaluate the solved bounded feedback policy under the P-measure
 * wealth dynamics. Policy interpolation is linear in wealth and HJB tau;
 * Euler–Maruyama advances wealth on an independent simulation time grid.
 */
export function simulateMertonPolicyMonteCarlo(
  request: MertonPolicyMonteCarloRequest,
  control?: ComputationControl,
): MertonMonteCarloResult {
  validateRequest(request);
  throwIfCancelled(control);
  const startedAt = performance.now();
  const { solved, config } = request;
  const parameters = solved.parameters;
  const timeStep = parameters.maturity / config.timeSteps;
  const diffusionScale = parameters.volatility * Math.sqrt(timeStep);
  const wealth = new Float64Array(config.paths).fill(parameters.wealth);
  const policy = new Float64Array(config.paths);
  const random = new NormalSampler(new Mulberry32(config.seed));
  const retainedIndices = displayIndices(config.paths, config.displayPathLimit);
  const retainedSlots = new Int32Array(config.paths).fill(-1);
  retainedIndices.forEach((pathIndex, slot) => { retainedSlots[pathIndex] = slot; });
  const displayedWealthPaths = retainedIndices.map(() => [parameters.wealth]);
  const displayedPolicyPaths = retainedIndices.map(() => [] as number[]);
  const time = Array.from({ length: config.timeSteps + 1 }, (_, index) => index * timeStep);
  const wealthMeanPath = [parameters.wealth];
  const policyMeanPath: number[] = [];
  const wealthQuantiles = Object.fromEntries(config.quantileLevels.map((level) => [String(level), [parameters.wealth]])) as Record<string, number[]>;
  const policyQuantiles = Object.fromEntries(config.quantileLevels.map((level) => [String(level), []])) as Record<string, number[]>;
  const theoreticalUnconstrainedWealthMeanPath = solved.unconstrainedBenchmarkApplicable
    ? time.map((calendarTime) => {
        const riskyFraction = (parameters.expectedReturn - parameters.rate)
          / (parameters.riskAversion * parameters.volatility ** 2);
        return parameters.wealth * Math.exp((parameters.rate + riskyFraction * (parameters.expectedReturn - parameters.rate)) * calendarTime);
      })
    : undefined;
  let lowerBoundObservations = 0;
  let upperBoundObservations = 0;
  let belowDomainObservations = 0;
  let aboveDomainObservations = 0;
  let nonPositiveWealthCorrections = 0;
  let minimumAppliedPolicy = Number.POSITIVE_INFINITY;
  let maximumAppliedPolicy = Number.NEGATIVE_INFINITY;
  let minimumReturnedWealth = parameters.wealth;
  let maximumReturnedWealth = parameters.wealth;
  const boundTolerance = 1e-10 * Math.max(1, Math.abs(parameters.controlMin), Math.abs(parameters.controlMax));
  let terminalWealthStatistics = new RunningStatistics();

  for (let timeIndex = 0; timeIndex < config.timeSteps; timeIndex += 1) {
    throwIfCancelled(control);
    const calendarTime = time[timeIndex];
    const policyStatistics = new RunningStatistics();
    const nextWealthStatistics = new RunningStatistics();
    for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
      if ((pathIndex & 0x3fff) === 0) throwIfCancelled(control);
      const interpolation = interpolateMertonFeedbackPolicy(solved, wealth[pathIndex], calendarTime);
      const appliedPolicy = interpolation.policy;
      policy[pathIndex] = appliedPolicy;
      policyStatistics.add(appliedPolicy);
      minimumAppliedPolicy = Math.min(minimumAppliedPolicy, appliedPolicy);
      maximumAppliedPolicy = Math.max(maximumAppliedPolicy, appliedPolicy);
      if (Math.abs(appliedPolicy - parameters.controlMin) <= boundTolerance) lowerBoundObservations += 1;
      if (Math.abs(appliedPolicy - parameters.controlMax) <= boundTolerance) upperBoundObservations += 1;
      if (interpolation.belowDomain) belowDomainObservations += 1;
      if (interpolation.aboveDomain) aboveDomainObservations += 1;
      const drift = parameters.rate * wealth[pathIndex]
        + appliedPolicy * (parameters.expectedReturn - parameters.rate);
      let nextWealth = wealth[pathIndex] + drift * timeStep + appliedPolicy * diffusionScale * random.next();
      if (nextWealth <= 0) {
        nextWealth = solved.solution.nodes[0];
        nonPositiveWealthCorrections += 1;
      }
      wealth[pathIndex] = nextWealth;
      nextWealthStatistics.add(nextWealth);
      minimumReturnedWealth = Math.min(minimumReturnedWealth, nextWealth);
      maximumReturnedWealth = Math.max(maximumReturnedWealth, nextWealth);
      const retainedSlot = retainedSlots[pathIndex];
      if (retainedSlot >= 0) {
        displayedPolicyPaths[retainedSlot].push(appliedPolicy);
        displayedWealthPaths[retainedSlot].push(nextWealth);
      }
    }
    policyMeanPath[timeIndex] = policyStatistics.mean;
    const policySliceQuantiles = quantiles(policy, config.quantileLevels);
    config.quantileLevels.forEach((level, index) => { policyQuantiles[String(level)][timeIndex] = policySliceQuantiles[index]; });
    wealthMeanPath.push(nextWealthStatistics.mean);
    const wealthSliceQuantiles = quantiles(wealth, config.quantileLevels);
    config.quantileLevels.forEach((level, index) => { wealthQuantiles[String(level)].push(wealthSliceQuantiles[index]); });
    if (timeIndex === config.timeSteps - 1) terminalWealthStatistics = nextWealthStatistics;
  }

  const terminalPolicyStatistics = new RunningStatistics();
  for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
    const terminalPolicy = interpolateMertonFeedbackPolicy(solved, wealth[pathIndex], parameters.maturity).policy;
    policy[pathIndex] = terminalPolicy;
    terminalPolicyStatistics.add(terminalPolicy);
    const retainedSlot = retainedSlots[pathIndex];
    if (retainedSlot >= 0) displayedPolicyPaths[retainedSlot].push(terminalPolicy);
  }
  policyMeanPath[config.timeSteps] = terminalPolicyStatistics.mean;
  const terminalPolicyQuantiles = quantiles(policy, config.quantileLevels);
  config.quantileLevels.forEach((level, index) => { policyQuantiles[String(level)][config.timeSteps] = terminalPolicyQuantiles[index]; });

  const utilityValues = new Float64Array(config.paths);
  const utilityStatistics = new RunningStatistics();
  for (let pathIndex = 0; pathIndex < config.paths; pathIndex += 1) {
    const utility = mertonUtility(wealth[pathIndex], parameters.riskAversion);
    utilityValues[pathIndex] = utility;
    utilityStatistics.add(utility);
  }
  const expectedUtility = estimateSummary(utilityStatistics);
  const totalPolicyObservations = config.paths * config.timeSteps;

  return {
    model: "HJB",
    measure: "P",
    stateKind: "controlled-wealth",
    config: { ...config, quantileLevels: [...config.quantileLevels] },
    simulatedPaths: config.paths,
    runtimeMs: performance.now() - startedAt,
    diagnostics: {
      scheme: "feedback-policy-euler",
      measureConvention: "P real-world controlled-wealth evaluation",
      objective: "expected CRRA terminal utility; no consumption",
      comparisonConvention: "Monte Carlo E[U(W_T)] under the interpolated discrete HJB policy versus J(W_0,t=0)",
      policySource: "completed Howard-implicit HJB solution",
      estimatorObservationCount: config.paths,
      standardErrorMethod: "independent terminal-utility path observations",
      hjbValue: solved.value,
      analyticValue: solved.analyticValue,
    },
    wealth: {
      time,
      displayedPathIndices: retainedIndices,
      displayedPaths: displayedWealthPaths,
      meanPath: wealthMeanPath,
      quantiles: wealthQuantiles,
    },
    policy: {
      time: [...time],
      displayedPathIndices: [...retainedIndices],
      displayedPaths: displayedPolicyPaths,
      meanPath: policyMeanPath,
      quantiles: policyQuantiles,
    },
    terminalWealth: sampleSummary(terminalWealthStatistics, wealth, config.quantileLevels),
    terminalUtility: sampleSummary(utilityStatistics, utilityValues, config.quantileLevels),
    expectedUtility,
    hjbValue: solved.value,
    analyticValue: solved.analyticValue,
    valueDifference: expectedUtility.mean - solved.value,
    analyticDifference: expectedUtility.mean - solved.analyticValue,
    policyDiagnostics: {
      interpolation: "linear in wealth and time-to-maturity; zero risky exposure below the HJB domain; upper policy held constant above the domain",
      timeConvention: "calendar t uses HJB layer tau=T-t",
      wealthStep: "Euler–Maruyama with non-positive proposals projected to the HJB lower boundary",
      minimumAppliedPolicy,
      maximumAppliedPolicy,
      lowerBoundObservations,
      upperBoundObservations,
      lowerBoundActivityFraction: lowerBoundObservations / totalPolicyObservations,
      upperBoundActivityFraction: upperBoundObservations / totalPolicyObservations,
      belowDomainObservations,
      aboveDomainObservations,
      nonPositiveWealthCorrections,
      minimumReturnedWealth,
      maximumReturnedWealth,
    },
    ...(theoreticalUnconstrainedWealthMeanPath ? { theoreticalUnconstrainedWealthMeanPath } : {}),
  };
}
