import assert from "node:assert/strict";
import test from "node:test";
import { ComputationCancelledError } from "../app/lib/computation-control.ts";
import {
  interpolateMertonFeedbackPolicy,
  simulateMertonPolicyMonteCarlo,
  type MertonMonteCarloConfig,
} from "../app/lib/monte-carlo/index.ts";
import {
  mertonAnalyticValue,
  solveMertonHjb,
  type MertonResult,
} from "../app/lib/pde-engine/index.ts";

const standard = {
  wealth: 100,
  maturity: 1,
  rate: 0.03,
  expectedReturn: 0.08,
  volatility: 0.2,
  riskAversion: 3,
  controlMin: -100,
  controlMax: 200,
} as const;

const solve = (overrides: Partial<typeof standard> = {}): MertonResult => solveMertonHjb({
  ...standard,
  ...overrides,
  spaceSteps: 160,
  timeSteps: 160,
  gridKind: "nonuniform",
  captureEvery: 10,
});

const config = (overrides: Partial<MertonMonteCarloConfig> = {}): MertonMonteCarloConfig => ({
  model: "HJB",
  enabled: true,
  paths: 60_000,
  timeSteps: 64,
  seed: 42,
  scheme: "feedback-policy-euler",
  displayPathLimit: 7,
  quantileLevels: [0.05, 0.25, 0.5, 0.75, 0.95],
  ...overrides,
});

const contains = (interval: readonly [number, number], value: number) => interval[0] <= value && value <= interval[1];

test("feedback-policy interpolation follows HJB tau, wealth interpolation, and domain rules", () => {
  const solved = solve();
  const nodes = solved.solution.nodes;
  const layers = solved.solution.layers;
  const layer = layers[Math.floor(layers.length / 2)];
  const nodeIndex = Math.floor(nodes.length / 2);
  const calendarTime = solved.parameters.maturity - layer.tau;
  const exact = interpolateMertonFeedbackPolicy(solved, nodes[nodeIndex], calendarTime);
  assert.ok(Math.abs(exact.policy - layer.policies[nodeIndex]) < 1e-12);
  assert.equal(exact.lowerTimeLayerTau, layer.tau);
  assert.equal(exact.upperTimeLayerTau, layer.tau);

  const midpointWealth = 0.5 * (nodes[nodeIndex] + nodes[nodeIndex + 1]);
  const midpoint = interpolateMertonFeedbackPolicy(solved, midpointWealth, calendarTime);
  assert.ok(Math.abs(midpoint.policy - 0.5 * (layer.policies[nodeIndex] + layer.policies[nodeIndex + 1])) < 1e-10);

  const lowerLayer = layers[3];
  const upperLayer = layers[4];
  const midpointTau = 0.5 * (lowerLayer.tau + upperLayer.tau);
  const timeMidpoint = interpolateMertonFeedbackPolicy(solved, nodes[nodeIndex], solved.parameters.maturity - midpointTau);
  assert.ok(Math.abs(timeMidpoint.policy - 0.5 * (lowerLayer.policies[nodeIndex] + upperLayer.policies[nodeIndex])) < 1e-10);

  const below = interpolateMertonFeedbackPolicy(solved, nodes[0] * 0.5, 0);
  const above = interpolateMertonFeedbackPolicy(solved, nodes.at(-1)! * 1.1, 0);
  assert.equal(below.policy, 0);
  assert.equal(below.belowDomain, true);
  assert.equal(above.aboveDomain, true);
  assert.ok(above.policy >= standard.controlMin && above.policy <= standard.controlMax);
});

test("unconstrained policy simulation agrees with HJB and closed-form expected utility", () => {
  const solved = solve();
  const result = simulateMertonPolicyMonteCarlo({ solved, config: config() });
  const analytic = mertonAnalyticValue(standard.wealth, standard.maturity, standard);

  assert.equal(result.measure, "P");
  assert.equal(result.stateKind, "controlled-wealth");
  assert.ok(contains(result.expectedUtility.confidence95, solved.value));
  assert.ok(contains(result.expectedUtility.confidence95, analytic));
  assert.equal(result.expectedUtility.mean, result.terminalUtility.mean);
  assert.equal(result.policyDiagnostics.nonPositiveWealthCorrections, 0);
  assert.ok(result.policyDiagnostics.minimumAppliedPolicy >= standard.controlMin);
  assert.ok(result.policyDiagnostics.maximumAppliedPolicy <= standard.controlMax);
  assert.ok(result.terminalWealth.minimum > 0);
  assert.ok(result.theoreticalUnconstrainedWealthMeanPath);
  assert.equal(result.wealth.meanPath.length, result.config.timeSteps + 1);
  assert.equal(result.policy.meanPath.length, result.config.timeSteps + 1);
  assert.ok(result.wealth.displayedPaths.every((path) => path.length === result.config.timeSteps + 1));
  assert.ok(result.policy.displayedPaths.every((path) => path.length === result.config.timeSteps + 1));
});

test("forward time-step refinement remains inside documented sampling and discretisation error", () => {
  const solved = solve();
  const analytic = solved.analyticValue;
  const coarse = simulateMertonPolicyMonteCarlo({ solved, config: config({ paths: 40_000, timeSteps: 16 }) });
  const fine = simulateMertonPolicyMonteCarlo({ solved, config: config({ paths: 40_000, timeSteps: 128 }) });
  for (const result of [coarse, fine]) {
    assert.ok(Math.abs(result.expectedUtility.mean - analytic) < 4 * result.expectedUtility.standardError + 2e-8);
  }
  assert.ok(Math.abs(fine.valueDifference) < 4 * fine.expectedUtility.standardError + 2e-8);
});

test("binding HJB control is respected and policy-bound activity is reported", () => {
  const solved = solve({ controlMin: 0, controlMax: 20 });
  const result = simulateMertonPolicyMonteCarlo({
    solved,
    config: config({ paths: 20_000, timeSteps: 64 }),
  });
  assert.ok(result.policy.displayedPaths.flat().every((value) => value >= -1e-12 && value <= 20 + 1e-12));
  assert.ok(result.policyDiagnostics.minimumAppliedPolicy >= -1e-12);
  assert.ok(result.policyDiagnostics.maximumAppliedPolicy <= 20 + 1e-12);
  assert.ok(result.policyDiagnostics.upperBoundActivityFraction > 0.99);
  assert.equal(result.policyDiagnostics.lowerBoundActivityFraction, 0);
  assert.ok(contains(result.expectedUtility.confidence95, solved.value));
});

test("fixed HJB solution, simulation grid, and seed reproduce every returned statistic", () => {
  const solved = solve();
  const simulationConfig = config({ paths: 257, timeSteps: 6, seed: 17 });
  const first = simulateMertonPolicyMonteCarlo({ solved, config: simulationConfig });
  const second = simulateMertonPolicyMonteCarlo({ solved, config: simulationConfig });
  assert.deepEqual({ ...first, runtimeMs: 0 }, { ...second, runtimeMs: 0 });
  assert.notEqual(
    first.terminalWealth.mean,
    simulateMertonPolicyMonteCarlo({ solved, config: { ...simulationConfig, seed: 18 } }).terminalWealth.mean,
  );
});

test("policy simulation rejects invalid inputs and cooperatively cancels", () => {
  const solved = solve();
  assert.throws(() => simulateMertonPolicyMonteCarlo({ solved, config: config({ enabled: false }) }), /must be enabled/);
  let checks = 0;
  assert.throws(() => simulateMertonPolicyMonteCarlo({
    solved,
    config: config({ paths: 50_000, timeSteps: 8 }),
  }, { isCancelled: () => checks++ >= 3 }), ComputationCancelledError);
});
