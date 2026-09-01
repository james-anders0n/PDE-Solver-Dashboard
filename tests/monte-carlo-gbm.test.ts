import assert from "node:assert/strict";
import test from "node:test";
import {
  brownianBridgeBarrierCrossingProbability,
  gbmMoments,
  simulateBlackScholesMonteCarlo,
  type BlackScholesMonteCarloConfig,
  type BlackScholesMonteCarloRequest,
} from "../app/lib/monte-carlo/index.ts";
import {
  blackScholesBarrierPrice,
  blackScholesDigitalPrice,
  blackScholesPrice,
} from "../app/lib/pde-engine/index.ts";

const standard = {
  spot: 100,
  strike: 100,
  maturity: 1,
  rate: 0.05,
  dividend: 0.02,
  volatility: 0.2,
} as const;

const config = (
  overrides: Partial<BlackScholesMonteCarloConfig> = {},
): BlackScholesMonteCarloConfig => ({
  model: "Black–Scholes",
  enabled: true,
  paths: 100_000,
  timeSteps: 1,
  seed: 20_260_822,
  scheme: "exact-gbm",
  displayPathLimit: 9,
  quantileLevels: [0.05, 0.25, 0.5, 0.75, 0.95],
  ...overrides,
});

const confidenceContains = (confidence: readonly [number, number], value: number) =>
  confidence[0] <= value && value <= confidence[1];

test("exact GBM paths reproduce risk-neutral mean and variance without time-step bias", () => {
  const simulationConfig = config({ paths: 120_000, timeSteps: 8, seed: 404 });
  const result = simulateBlackScholesMonteCarlo({
    ...standard,
    side: "Call",
    contract: "european",
    config: simulationConfig,
  });

  result.stock.time.forEach((time, index) => {
    const exact = gbmMoments(standard, time);
    if (time === 0) {
      assert.equal(result.stock.meanPath[index], standard.spot);
      return;
    }
    const meanStandardError = Math.sqrt(exact.variance / simulationConfig.paths);
    const standardisedError = Math.abs(result.stock.meanPath[index] - exact.mean) / meanStandardError;
    assert.ok(standardisedError < 4, `mean at t=${time}: z=${standardisedError}`);
  });

  const terminalMoments = gbmMoments(standard, standard.maturity);
  assert.ok(
    Math.abs(result.payoff.terminalStock.variance / terminalMoments.variance - 1) < 0.03,
    `terminal variance ${result.payoff.terminalStock.variance} vs ${terminalMoments.variance}`,
  );
  assert.equal(result.diagnostics.exactTransition, true);
  assert.equal(result.diagnostics.theoreticalTerminalMean, terminalMoments.mean);
  assert.equal(result.diagnostics.theoreticalTerminalVariance, terminalMoments.variance);
});

test("European call and put prices contain closed form inside their 95% confidence intervals", () => {
  for (const side of ["Call", "Put"] as const) {
    const request = {
      ...standard,
      side,
      contract: "european" as const,
      config: config(),
    };
    const result = simulateBlackScholesMonteCarlo(request);
    const exact = blackScholesPrice(request);
    const estimate = result.payoff.discountedValue;

    assert.ok(confidenceContains(estimate.confidence95, exact), `${side}: ${JSON.stringify({ estimate, exact })}`);
    assert.ok(estimate.standardError > 0);
    assert.equal(result.payoff.undiscountedPayoff.count, request.config.paths);
    assert.ok(result.payoff.undiscountedPayoff.minimum >= 0);
    assert.equal(
      estimate.standardError,
      Math.exp(-request.rate * request.maturity)
        * Math.sqrt(result.payoff.undiscountedPayoff.variance / request.config.paths),
    );
  }
});

test("digital call and put use strict indicator payoffs and pass their separate benchmarks", () => {
  const callRequest = {
    ...standard,
    side: "Call" as const,
    contract: "digital" as const,
    config: config(),
  };
  const putRequest = { ...callRequest, side: "Put" as const };
  const call = simulateBlackScholesMonteCarlo(callRequest);
  const put = simulateBlackScholesMonteCarlo(putRequest);

  assert.ok(confidenceContains(call.payoff.discountedValue.confidence95, blackScholesDigitalPrice(callRequest)));
  assert.ok(confidenceContains(put.payoff.discountedValue.confidence95, blackScholesDigitalPrice(putRequest)));
  for (const result of [call, put]) {
    assert.equal(result.payoff.undiscountedPayoff.minimum, 0);
    assert.equal(result.payoff.undiscountedPayoff.maximum, 1);
  }

  // The same seed gives the same terminal stocks. Strict call/put indicators
  // are complementary because no simulated terminal stock equals the strike.
  assert.ok(Math.abs(
    call.payoff.undiscountedPayoff.mean + put.payoff.undiscountedPayoff.mean - 1,
  ) < 1e-14);
  assert.ok(Math.abs(
    call.payoff.discountedValue.mean + put.payoff.discountedValue.mean
      - Math.exp(-standard.rate * standard.maturity),
  ) < 1e-14);
});

test("fixed configuration and seed reproduce paths, summaries, quantiles, and prices", () => {
  const simulationConfig = config({
    paths: 257,
    timeSteps: 6,
    seed: 17,
    displayPathLimit: 7,
    quantileLevels: [0.1, 0.5, 0.9],
  });
  const request: BlackScholesMonteCarloRequest = {
    ...standard,
    side: "Call",
    contract: "european",
    config: simulationConfig,
  };
  const first = simulateBlackScholesMonteCarlo(request);
  const second = simulateBlackScholesMonteCarlo(request);

  assert.deepEqual(
    { ...first, runtimeMs: 0 },
    { ...second, runtimeMs: 0 },
  );
  assert.deepEqual(first.stock.displayedPathIndices, [0, 43, 85, 128, 171, 213, 256]);
  assert.equal(first.stock.displayedPaths.length, 7);
  assert.ok(first.stock.displayedPaths.every((path) => path.length === simulationConfig.timeSteps + 1));
  assert.equal(first.stock.meanPath.length, simulationConfig.timeSteps + 1);
  assert.ok(Object.values(first.stock.quantiles).every((path) => path.length === simulationConfig.timeSteps + 1));
  assert.equal(first.payoff.terminalStock.count, simulationConfig.paths);
  assert.equal(first.simulatedPaths, simulationConfig.paths);
  assert.notEqual(
    first.payoff.terminalStock.mean,
    simulateBlackScholesMonteCarlo({ ...request, config: { ...simulationConfig, seed: 18 } }).payoff.terminalStock.mean,
  );
});

test("Brownian-bridge crossing probabilities handle both barrier directions and endpoint breaches", () => {
  const up = brownianBridgeBarrierCrossingProbability(100, 110, 130, "up-and-out", 0.2, 0.25);
  const down = brownianBridgeBarrierCrossingProbability(100, 90, 75, "down-and-out", 0.2, 0.25);
  assert.ok(up > 0 && up < 1);
  assert.ok(down > 0 && down < 1);
  assert.equal(
    up,
    Math.exp(-2 * Math.log(130 / 100) * Math.log(130 / 110) / (0.2 ** 2 * 0.25)),
  );
  assert.equal(brownianBridgeBarrierCrossingProbability(100, 131, 130, "up-and-out", 0.2, 0.25), 1);
  assert.equal(brownianBridgeBarrierCrossingProbability(100, 74, 75, "down-and-out", 0.2, 0.25), 1);
});

test("continuous barrier estimators are reproducible and agree with Reiner–Rubinstein benchmarks", () => {
  const fixtures = [
    { side: "Call", barrier: 130, barrierDirection: "up-and-out" },
    { side: "Put", barrier: 75, barrierDirection: "down-and-out" },
  ] as const;

  for (const fixture of fixtures) {
    const request: BlackScholesMonteCarloRequest = {
      ...standard,
      ...fixture,
      contract: "barrier",
      config: config({ paths: 100_000, timeSteps: 16, seed: 20_260_822 }),
    };
    const first = simulateBlackScholesMonteCarlo(request);
    const second = simulateBlackScholesMonteCarlo(request);
    const analytic = blackScholesBarrierPrice(request, fixture.barrier, fixture.barrierDirection);

    assert.deepEqual({ ...first, runtimeMs: 0 }, { ...second, runtimeMs: 0 });
    assert.ok(confidenceContains(first.payoff.discountedValue.confidence95, analytic), `${fixture.barrierDirection}: ${JSON.stringify({ estimate: first.payoff.discountedValue, analytic })}`);
    assert.equal(first.diagnostics.monitoring, "continuous");
    assert.equal(first.diagnostics.brownianBridgeCorrection, true);
    assert.equal(first.diagnostics.barrierDirection, fixture.barrierDirection);
    assert.equal(first.diagnostics.payoffMethod, "terminal intrinsic payoff times Brownian-bridge conditional survival weight");
    assert.ok(Number(first.diagnostics.meanSurvivalWeight) > 0);
    assert.ok(Number(first.diagnostics.meanSurvivalWeight) < 1);
    assert.ok(Number(first.diagnostics.discreteMonitoringValue) > first.payoff.discountedValue.mean);
  }
});

test("Brownian-bridge correction removes endpoint monitoring bias as the endpoint-only estimate refines", () => {
  const request = {
    ...standard,
    side: "Call" as const,
    contract: "barrier" as const,
    barrier: 130,
    barrierDirection: "up-and-out" as const,
  };
  const analytic = blackScholesBarrierPrice(request, request.barrier, request.barrierDirection);
  const results = [1, 4, 16, 64].map((timeSteps) => simulateBlackScholesMonteCarlo({
    ...request,
    config: config({ paths: 100_000, timeSteps, seed: 20_260_822 }),
  }));
  const endpointBiases = results.map((result) => Number(result.diagnostics.monitoringBiasEstimate));

  assert.ok(endpointBiases.every((bias) => bias > 0), `endpoint biases ${endpointBiases.join(", ")}`);
  for (let index = 1; index < endpointBiases.length; index += 1) {
    assert.ok(endpointBiases[index] < endpointBiases[index - 1], `endpoint biases ${endpointBiases.join(", ")}`);
  }
  for (const result of results) {
    assert.ok(confidenceContains(result.payoff.discountedValue.confidence95, analytic));
  }
  assert.ok(endpointBiases.at(-1)! < endpointBiases[0] * 0.25);
});

test("GBM engine rejects disabled, invalid barrier, and American Monte Carlo requests", () => {
  const request: BlackScholesMonteCarloRequest = {
    ...standard,
    side: "Call",
    contract: "european",
    config: config({ paths: 10 }),
  };
  assert.throws(
    () => simulateBlackScholesMonteCarlo({ ...request, config: { ...request.config, enabled: false } }),
    /must be enabled/,
  );
  assert.throws(
    () => simulateBlackScholesMonteCarlo({ ...request, config: { ...request.config, paths: 1 } }),
    /at least 2/,
  );
  assert.throws(
    () => simulateBlackScholesMonteCarlo({ ...request, contract: "barrier" } as unknown as BlackScholesMonteCarloRequest),
    /finite positive barrier/,
  );
  assert.throws(
    () => simulateBlackScholesMonteCarlo({ ...request, contract: "american-put" } as unknown as BlackScholesMonteCarloRequest),
    /continuous knock-out barrier contracts/,
  );
});
