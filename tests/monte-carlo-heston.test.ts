import assert from "node:assert/strict";
import test from "node:test";
import {
  ANDERSEN_HESTON_FIXTURES,
  ANDERSEN_QE_PSI_CUTOFF,
  andersenQeVarianceStep,
  cirMoments,
  Mulberry32,
  NormalSampler,
  quantile,
  RunningStatistics,
  simulateHestonMonteCarlo,
  type HestonMonteCarloConfig,
  type HestonMonteCarloRequest,
} from "../app/lib/monte-carlo/index.ts";
import { hestonSemiAnalyticPrice } from "../app/lib/pde-engine/index.ts";

const standard = {
  spot: 100,
  strike: 100,
  maturity: 1,
  rate: 0.05,
  dividend: 0,
  v0: 0.04,
  kappa: 2,
  theta: 0.04,
  xi: 0.3,
  rho: -0.7,
} as const;

const config = (
  overrides: Partial<HestonMonteCarloConfig> = {},
): HestonMonteCarloConfig => ({
  model: "Heston",
  enabled: true,
  paths: 10_000,
  timeSteps: 64,
  seed: 20_260_822,
  scheme: "full-truncation-euler",
  displayPathLimit: 9,
  quantileLevels: [0.05, 0.25, 0.5, 0.75, 0.95],
  ...overrides,
});

const confidenceContains = (confidence: readonly [number, number], value: number) =>
  confidence[0] <= value && value <= confidence[1];

test("Heston paths reproduce the requested shock correlation and diagnose variance projection", () => {
  const request: HestonMonteCarloRequest = {
    ...standard,
    kappa: 1.2,
    xi: 0.6,
    rho: -0.65,
    side: "Put",
    config: config({ paths: 15_000, timeSteps: 32, seed: 73 }),
  };
  const result = simulateHestonMonteCarlo(request);
  const sampledCorrelation = Number(result.diagnostics.sampledShockCorrelation);

  assert.ok(Math.abs(sampledCorrelation - request.rho) < 0.01, `sampled correlation ${sampledCorrelation}`);
  assert.equal(result.varianceDiagnostics.treatment, "projected full-truncation Euler");
  assert.equal(result.varianceDiagnostics.fellerSatisfied, false);
  assert.ok(result.varianceDiagnostics.rawNegativeVarianceSteps > 0);
  assert.ok(result.varianceDiagnostics.correctionFraction > 0);
  assert.ok(result.varianceDiagnostics.correctedPaths > 0);
  assert.ok(result.varianceDiagnostics.minimumRawVariance < 0);
  assert.equal(result.varianceDiagnostics.minimumReturnedVariance, 0);
  assert.equal(result.terminalVariance.minimum, 0);
  assert.ok(result.variance.displayedPaths.flat().every((variance) => variance >= 0));
  assert.ok(result.variance.meanPath.every(Number.isFinite));
  assert.ok(Object.values(result.variance.quantiles).flat().every((variance) => variance >= 0));
});

test("CIR moment bias decreases under full-truncation time-step refinement", () => {
  const parameters = {
    spot: 100,
    strike: 100,
    maturity: 1,
    rate: 0.03,
    dividend: 0.01,
    v0: 0.09,
    kappa: 2,
    theta: 0.04,
    xi: 0.15,
    rho: -0.4,
    side: "Call" as const,
  };
  const exact = cirMoments(parameters, parameters.maturity);
  const results = [4, 16, 64].map((timeSteps) => simulateHestonMonteCarlo({
    ...parameters,
    config: config({
      paths: 30_000,
      timeSteps,
      seed: 77,
      displayPathLimit: 1,
      quantileLevels: [0.5],
    }),
  }));
  const meanErrors = results.map((result) => Math.abs(result.terminalVariance.mean - exact.mean));
  const varianceErrors = results.map((result) => Math.abs(result.terminalVariance.variance - exact.variance));

  assert.ok(meanErrors[1] < meanErrors[0], JSON.stringify(meanErrors));
  assert.ok(meanErrors[2] < meanErrors[1], JSON.stringify(meanErrors));
  assert.ok(varianceErrors[1] < varianceErrors[0], JSON.stringify(varianceErrors));
  assert.ok(varianceErrors[2] < varianceErrors[1], JSON.stringify(varianceErrors));

  const finest = results.at(-1)!;
  const meanStandardError = Math.sqrt(exact.variance / finest.config.paths);
  assert.ok(meanErrors.at(-1)! / meanStandardError < 4, `CIR mean z=${meanErrors.at(-1)! / meanStandardError}`);
  assert.ok(varianceErrors.at(-1)! / exact.variance < 0.03, `CIR variance relative error ${varianceErrors.at(-1)! / exact.variance}`);
  assert.equal(finest.varianceDiagnostics.theoreticalTerminalMean, exact.mean);
  assert.equal(finest.varianceDiagnostics.theoreticalTerminalVariance, exact.variance);
});

test("fixed Heston configuration reproduces stock, variance, quantiles, diagnostics, and price", () => {
  const simulationConfig = config({
    paths: 257,
    timeSteps: 8,
    seed: 17,
    displayPathLimit: 257,
    quantileLevels: [0.1, 0.5, 0.9],
  });
  const request: HestonMonteCarloRequest = {
    ...standard,
    side: "Call",
    config: simulationConfig,
  };
  const first = simulateHestonMonteCarlo(request);
  const second = simulateHestonMonteCarlo(request);

  assert.deepEqual({ ...first, runtimeMs: 0 }, { ...second, runtimeMs: 0 });
  assert.deepEqual(first.stock.displayedPathIndices, Array.from({ length: 257 }, (_, index) => index));
  assert.deepEqual(first.stock.displayedPathIndices, first.variance.displayedPathIndices);
  assert.ok(first.stock.displayedPaths.every((path) => path.length === simulationConfig.timeSteps + 1));
  assert.ok(first.variance.displayedPaths.every((path) => path.length === simulationConfig.timeSteps + 1));

  const terminalStocks = first.stock.displayedPaths.map((path) => path.at(-1)!);
  const terminalVariances = first.variance.displayedPaths.map((path) => path.at(-1)!);
  for (const level of simulationConfig.quantileLevels) {
    assert.equal(first.payoff.terminalStock.quantiles[String(level)], quantile(terminalStocks, level));
    assert.equal(first.terminalVariance.quantiles[String(level)], quantile(terminalVariances, level));
  }
  assert.notEqual(
    first.payoff.discountedValue.mean,
    simulateHestonMonteCarlo({ ...request, config: { ...simulationConfig, seed: 18 } }).payoff.discountedValue.mean,
  );
});

test("Andersen QE matches CIR conditional moments in both quadratic and exponential regimes", () => {
  const cases = [
    { parameters: { kappa: 2, theta: 0.04, xi: 0.3 }, variance: 0.04, timeStep: 1 / 12, seed: 91, regime: "quadratic" },
    { parameters: { kappa: 0.5, theta: 0.04, xi: 1 }, variance: 0.0001, timeStep: 1, seed: 92, regime: "exponential" },
  ] as const;

  for (const fixture of cases) {
    const normal = new NormalSampler(new Mulberry32(fixture.seed));
    const sample = new RunningStatistics();
    let zeroCount = 0;
    let reference: ReturnType<typeof andersenQeVarianceStep> | undefined;
    for (let index = 0; index < 250_000; index += 1) {
      const transition = andersenQeVarianceStep(
        fixture.parameters,
        fixture.variance,
        fixture.timeStep,
        normal.next(),
      );
      reference ??= transition;
      assert.equal(transition.regime, fixture.regime);
      sample.add(transition.nextVariance);
      if (transition.nextVariance === 0) zeroCount += 1;
    }
    assert.ok(reference);
    assert.ok(Math.abs(sample.mean / reference.conditionalMean - 1) < 0.012, `${fixture.regime} mean`);
    assert.ok(Math.abs(sample.populationVariance / reference.conditionalVariance - 1) < 0.025, `${fixture.regime} variance`);
    if (fixture.regime === "exponential") {
      assert.ok(Math.abs(zeroCount / sample.count - reference.atomProbability!) < 0.003);
    } else {
      assert.equal(zeroCount, 0);
    }
  }
});

test("QE-M preserves correlation handling, exercises both regimes, and returns non-negative variance", () => {
  const fixture = ANDERSEN_HESTON_FIXTURES[0];
  const result = simulateHestonMonteCarlo({
    ...fixture,
    config: config({
      scheme: "andersen-qe",
      varianceReduction: "antithetic",
      paths: 12_000,
      timeSteps: 32,
      seed: 313,
      displayPathLimit: 11,
    }),
  });

  assert.equal(result.varianceDiagnostics.treatment, "Andersen QE conditional moment matching");
  assert.equal(result.varianceDiagnostics.qePsiCutoff, ANDERSEN_QE_PSI_CUTOFF);
  assert.ok(result.varianceDiagnostics.qeQuadraticRegimeSteps > 0);
  assert.ok(result.varianceDiagnostics.qeExponentialRegimeSteps > 0);
  assert.equal(
    result.varianceDiagnostics.qeQuadraticRegimeSteps + result.varianceDiagnostics.qeExponentialRegimeSteps,
    result.config.paths * result.config.timeSteps,
  );
  assert.ok(Math.abs(Number(result.diagnostics.sampledShockCorrelation) - fixture.rho) < 0.01);
  assert.ok(Math.abs(Number(result.diagnostics.sampledOrthogonalNormalCorrelation)) < 0.01);
  assert.match(String(result.diagnostics.correlationHandling), /rho\/xi log-stock coupling/);
  assert.equal(result.diagnostics.qeMartingaleCorrection, true);
  assert.equal(result.varianceDiagnostics.rawNegativeVarianceSteps, 0);
  assert.ok(result.variance.displayedPaths.flat().every((variance) => variance >= 0));
});

test("antithetic QE keeps the payoff-mean estimator and uses pair averages for standard error", () => {
  const paths = 512;
  const request: HestonMonteCarloRequest = {
    ...standard,
    side: "Call",
    config: config({
      scheme: "andersen-qe",
      varianceReduction: "antithetic",
      paths,
      timeSteps: 16,
      seed: 818,
      displayPathLimit: paths,
      quantileLevels: [0.5],
    }),
  };
  const first = simulateHestonMonteCarlo(request);
  const second = simulateHestonMonteCarlo(request);
  assert.deepEqual({ ...first, runtimeMs: 0 }, { ...second, runtimeMs: 0 });

  const pairStatistics = new RunningStatistics();
  const terminalPayoffs = first.stock.displayedPaths.map((path) => Math.max(path.at(-1)! - request.strike, 0));
  for (let index = 0; index < terminalPayoffs.length; index += 2) {
    pairStatistics.add(0.5 * (terminalPayoffs[index] + terminalPayoffs[index + 1]));
  }
  const expectedStandardError = Math.exp(-request.rate * request.maturity)
    * Math.sqrt(pairStatistics.sampleVariance / pairStatistics.count);
  assert.ok(Math.abs(first.payoff.discountedValue.standardError - expectedStandardError) < 1e-14);
  assert.equal(first.diagnostics.estimatorObservationCount, paths / 2);
  assert.equal(first.diagnostics.antitheticPairCount, paths / 2);
  assert.equal(first.diagnostics.standardErrorMethod, "independent antithetic pair averages");
});

test("antithetic QE reduces standard error without materially changing the estimator", () => {
  const common = { paths: 20_000, timeSteps: 32, seed: 88, scheme: "andersen-qe" as const, displayPathLimit: 1, quantileLevels: [0.5] };
  const plain = simulateHestonMonteCarlo({ ...standard, side: "Call", config: config({ ...common, varianceReduction: "none" }) });
  const antitheticResult = simulateHestonMonteCarlo({ ...standard, side: "Call", config: config({ ...common, varianceReduction: "antithetic" }) });
  assert.ok(antitheticResult.payoff.discountedValue.standardError < 0.8 * plain.payoff.discountedValue.standardError);
  const combinedStandardError = Math.hypot(plain.payoff.discountedValue.standardError, antitheticResult.payoff.discountedValue.standardError);
  assert.ok(Math.abs(plain.payoff.discountedValue.mean - antitheticResult.payoff.discountedValue.mean) < 2 * combinedStandardError);
});

test("QE-M controls coarse-grid weak bias better than full truncation on Andersen cases I–III", () => {
  let fullTruncationAbsoluteBias = 0;
  let qeAbsoluteBias = 0;
  for (const [fixtureIndex, fixture] of ANDERSEN_HESTON_FIXTURES.entries()) {
    const exact = hestonSemiAnalyticPrice(fixture);
    const shared = {
      paths: 8_000,
      timeSteps: 32,
      seed: 10_001 + fixtureIndex,
      displayPathLimit: 1,
      quantileLevels: [0.5],
      varianceReduction: "antithetic" as const,
    };
    const fullTruncation = simulateHestonMonteCarlo({
      ...fixture,
      config: config({ ...shared, scheme: "full-truncation-euler" }),
    });
    const qe = simulateHestonMonteCarlo({
      ...fixture,
      config: config({ ...shared, scheme: "andersen-qe" }),
    });
    fullTruncationAbsoluteBias += Math.abs(fullTruncation.payoff.discountedValue.mean - exact);
    qeAbsoluteBias += Math.abs(qe.payoff.discountedValue.mean - exact);
  }
  assert.ok(qeAbsoluteBias < 0.15 * fullTruncationAbsoluteBias, JSON.stringify({ qeAbsoluteBias, fullTruncationAbsoluteBias }));
});

let fineBenchmarkResults: ReturnType<typeof simulateHestonMonteCarlo>[] | undefined;

function benchmarkResults() {
  fineBenchmarkResults ??= (["Call", "Put"] as const).map((side) => simulateHestonMonteCarlo({
    ...standard,
    side,
    config: config({
      paths: 20_000,
      timeSteps: 256,
      seed: 20_260_822,
      displayPathLimit: 1,
      quantileLevels: [0.5],
    }),
  }));
  return fineBenchmarkResults;
}

test("fine-grid Heston calls and puts agree with the Fourier benchmark within statistical uncertainty", () => {
  const [call, put] = benchmarkResults();
  for (const [result, side] of [[call, "Call"], [put, "Put"]] as const) {
    const exact = hestonSemiAnalyticPrice({ ...standard, side });
    assert.ok(
      confidenceContains(result.payoff.discountedValue.confidence95, exact),
      JSON.stringify({ side, estimate: result.payoff.discountedValue, exact }),
    );
    assert.ok(result.payoff.discountedValue.standardError > 0);
    assert.ok(result.payoff.undiscountedPayoff.minimum >= 0);
  }
});

test("fine-grid Heston stock mean and common-path put-call parity pass their uncertainty gates", () => {
  const [call, put] = benchmarkResults();
  const discountFactor = Math.exp(-standard.rate * standard.maturity);
  const theoreticalStockMean = standard.spot * Math.exp((standard.rate - standard.dividend) * standard.maturity);
  const terminalMeanStandardError = call.payoff.terminalStock.standardDeviation / Math.sqrt(call.simulatedPaths);
  assert.ok(
    Math.abs(call.payoff.terminalStock.mean - theoreticalStockMean) <= 1.959963984540054 * terminalMeanStandardError,
    JSON.stringify({ sample: call.payoff.terminalStock.mean, theoreticalStockMean, terminalMeanStandardError }),
  );

  const sampleParity = call.payoff.discountedValue.mean - put.payoff.discountedValue.mean;
  const pathwiseParity = discountFactor * (call.payoff.terminalStock.mean - standard.strike);
  assert.ok(Math.abs(sampleParity - pathwiseParity) < 1e-10);

  const theoreticalParity = standard.spot * Math.exp(-standard.dividend * standard.maturity)
    - standard.strike * discountFactor;
  const parityStandardError = discountFactor * terminalMeanStandardError;
  assert.ok(
    Math.abs(sampleParity - theoreticalParity) <= 1.959963984540054 * parityStandardError,
    JSON.stringify({ sampleParity, theoreticalParity, parityStandardError }),
  );
});

test("Heston rejects disabled, unknown-scheme, and unpaired antithetic configurations", () => {
  const request: HestonMonteCarloRequest = {
    ...standard,
    side: "Call",
    config: config({ paths: 10 }),
  };
  assert.throws(
    () => simulateHestonMonteCarlo({ ...request, config: { ...request.config, enabled: false } }),
    /must be enabled/,
  );
  assert.throws(
    () => simulateHestonMonteCarlo({
      ...request,
      config: { ...request.config, scheme: "unknown" },
    } as unknown as HestonMonteCarloRequest),
    /requires full-truncation-euler or andersen-qe/,
  );
  assert.throws(
    () => simulateHestonMonteCarlo({
      ...request,
      config: { ...request.config, scheme: "andersen-qe", varianceReduction: "antithetic", paths: 11 },
    }),
    /requires an even path count/,
  );
});
