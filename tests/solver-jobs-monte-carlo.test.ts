import assert from "node:assert/strict";
import test from "node:test";
import { ComputationCancelledError } from "../app/lib/computation-control.ts";
import {
  createMonteCarloCsvRows,
  createMonteCarloManifest,
  simulateBlackScholesMonteCarlo,
  type BlackScholesMonteCarloConfig,
  type HestonMonteCarloConfig,
  type MertonMonteCarloConfig,
  type ShortRateMonteCarloConfig,
} from "../app/lib/monte-carlo/index.ts";
import {
  createSolverJobKey,
  executeSolverJob,
  type SolverJob,
  type SolverJobResult,
} from "../app/lib/solver-jobs.ts";
import { createDiscountCurve, type ShortRateResult } from "../app/lib/pde-engine/short-rate.ts";

const pdeOnlyJob: Extract<SolverJob, { model: "Black–Scholes" }> = {
  model: "Black–Scholes",
  request: {
    spot: 100,
    strike: 100,
    maturity: 1,
    rate: 0.05,
    dividend: 0,
    volatility: 0.2,
    side: "Call",
    contract: "european",
    spaceSteps: 80,
    timeSteps: 80,
    scheme: "rannacher-cn",
    gridKind: "nonuniform",
  },
};

const monteCarloConfig = (
  overrides: Partial<BlackScholesMonteCarloConfig> = {},
): BlackScholesMonteCarloConfig => ({
  model: "Black–Scholes",
  enabled: true,
  paths: 2_000,
  timeSteps: 4,
  seed: 42,
  scheme: "exact-gbm",
  displayPathLimit: 5,
  quantileLevels: [0.1, 0.5, 0.9],
  ...overrides,
});

const shortRateMonteCarloConfig = (
  model: "Vasicek" | "Hull–White",
  overrides: Partial<ShortRateMonteCarloConfig> = {},
): ShortRateMonteCarloConfig => ({
  model,
  enabled: true,
  paths: 4_000,
  timeSteps: 4,
  seed: 42,
  scheme: "exact-gaussian",
  displayPathLimit: 3,
  quantileLevels: [0.1, 0.5, 0.9],
  ...overrides,
});

const mertonMonteCarloConfig = (
  overrides: Partial<MertonMonteCarloConfig> = {},
): MertonMonteCarloConfig => ({
  model: "HJB",
  enabled: true,
  paths: 2_000,
  timeSteps: 8,
  seed: 42,
  scheme: "feedback-policy-euler",
  displayPathLimit: 3,
  quantileLevels: [0.1, 0.5, 0.9],
  ...overrides,
});

function withoutRuntimes(result: SolverJobResult): SolverJobResult {
  const copy = structuredClone(result);
  copy.result.solution.diagnostics.runtimeMs = 0;
  if (copy.monteCarlo) copy.monteCarlo.runtimeMs = 0;
  return copy;
}

test("cache identity separates enabled Monte Carlo settings and canonicalises disabled mode", () => {
  const disabled: SolverJob = {
    ...pdeOnlyJob,
    monteCarlo: monteCarloConfig({ enabled: false, paths: 999, seed: 7 }),
  };
  const enabled: SolverJob = { ...pdeOnlyJob, monteCarlo: monteCarloConfig() };
  const otherSeed: SolverJob = { ...pdeOnlyJob, monteCarlo: monteCarloConfig({ seed: 43 }) };
  const otherPathCount: SolverJob = { ...pdeOnlyJob, monteCarlo: monteCarloConfig({ paths: 2_001 }) };

  assert.equal(createSolverJobKey(pdeOnlyJob), createSolverJobKey(disabled));
  assert.notEqual(createSolverJobKey(pdeOnlyJob), createSolverJobKey(enabled));
  assert.notEqual(createSolverJobKey(enabled), createSolverJobKey(otherSeed));
  assert.notEqual(createSolverJobKey(enabled), createSolverJobKey(otherPathCount));

  const reordered: SolverJob = {
    monteCarlo: { ...monteCarloConfig(), quantileLevels: [0.1, 0.5, 0.9] },
    request: { ...pdeOnlyJob.request },
    model: "Black–Scholes",
  };
  assert.equal(createSolverJobKey(enabled), createSolverJobKey(reordered));
});

test("cache identity includes the complete reviewed CPI scenario provenance", () => {
  const scenarioIdentity = {
    forecastRunId: "cpi-run-001",
    distributionMethod: "walk-forward-signed-residual-bootstrap",
    distributionMethodVersion: "1.0.0",
    distributionSeed: 1729,
    mappingVersion: "cpi-to-policy-rate@1.0.0 → cpi-policy-to-pde@1.0.0",
    scenarioInputs: {
      quantile: "p50" as const,
      cpiMomPct: 0.48,
      cpiIntervalPct: [0.22, 0.79] as [number, number],
      neutralPolicyRate: 0.03,
      annualInflationTarget: 0.02,
      reactionCoefficient: 0.5,
      policyRateForecast: 0.0488,
      policyRateInterval: [0.0332, 0.0674] as [number, number],
    },
  };
  const scenarioJob: SolverJob = { ...pdeOnlyJob, scenarioIdentity };
  assert.notEqual(createSolverJobKey(pdeOnlyJob), createSolverJobKey(scenarioJob));
  assert.notEqual(createSolverJobKey(scenarioJob), createSolverJobKey({
    ...scenarioJob,
    scenarioIdentity: { ...scenarioIdentity, distributionSeed: 1730 },
  }));
  assert.notEqual(createSolverJobKey(scenarioJob), createSolverJobKey({
    ...scenarioJob,
    scenarioIdentity: { ...scenarioIdentity, scenarioInputs: { ...scenarioIdentity.scenarioInputs, quantile: "p90" } },
  }));
});

test("omitted and explicitly disabled Monte Carlo preserve the PDE-only result and progress contract", () => {
  const omittedProgress: Array<[number, string]> = [];
  const disabledProgress: Array<[number, string]> = [];
  const omitted = executeSolverJob(pdeOnlyJob, (progress, stage) => omittedProgress.push([progress, stage]));
  const disabled = executeSolverJob({
    ...pdeOnlyJob,
    monteCarlo: monteCarloConfig({ enabled: false }),
  }, (progress, stage) => disabledProgress.push([progress, stage]));

  assert.deepEqual(Object.keys(omitted).sort(), ["convergence", "domainExpansionDelta", "result"]);
  assert.deepEqual(Object.keys(disabled).sort(), ["convergence", "domainExpansionDelta", "result"]);
  assert.deepEqual(omittedProgress, [
    [18, "Assembling finite-difference operator"],
    [58, "Running independent benchmark and refinement study"],
    [86, "Checking domain expansion"],
  ]);
  assert.deepEqual(disabledProgress, omittedProgress);
  assert.deepEqual(withoutRuntimes(disabled), withoutRuntimes(omitted));
});

test("Black–Scholes refinement uses the configured grid for a representative quoted contract", () => {
  const result = executeSolverJob({
    model: "Black–Scholes",
    request: {
      spot: 226.43,
      strike: 230,
      maturity: 0.49863014,
      rate: 0.04324527,
      dividend: 0.00409431,
      volatility: 0.21447575,
      side: "Call",
      contract: "european",
      spaceSteps: 200,
      timeSteps: 200,
      scheme: "rannacher-cn",
      gridKind: "nonuniform",
    },
  }, () => {});

  assert.ok((result.convergence.at(-1)?.observedOrder ?? 0) > 1.8, JSON.stringify(result.convergence));
  assert.ok(result.result.absoluteError < 1e-3, `point error ${result.result.absoluteError}`);
});

test("enabled jobs attach reproducible Monte Carlo payloads and progress stages", () => {
  const job: SolverJob = { ...pdeOnlyJob, monteCarlo: monteCarloConfig() };
  const firstProgress: Array<[number, string]> = [];
  const first = executeSolverJob(job, (progress, stage) => firstProgress.push([progress, stage]));
  const second = executeSolverJob(job, () => {});

  assert.ok(first.monteCarlo);
  assert.ok(second.monteCarlo);
  assert.deepEqual(
    { ...first.monteCarlo, runtimeMs: 0 },
    { ...second.monteCarlo, runtimeMs: 0 },
  );
  assert.deepEqual(firstProgress.slice(-2), [
    [90, "Simulating exact risk-neutral GBM paths"],
    [96, "Monte Carlo statistics and confidence interval complete"],
  ]);
  assert.equal(first.monteCarlo.config.seed, 42);
  assert.equal(first.monteCarlo.simulatedPaths, 2_000);
});

test("barrier jobs attach continuous-monitoring payloads and export contract-specific diagnostics", () => {
  const job: Extract<SolverJob, { model: "Black–Scholes" }> = {
    model: "Black–Scholes",
    request: {
      ...pdeOnlyJob.request,
      contract: "barrier",
      barrier: 130,
      barrierDirection: "up-and-out",
      spaceSteps: 60,
      timeSteps: 60,
    },
    monteCarlo: monteCarloConfig({ paths: 10_000, timeSteps: 8, seed: 713 }),
  };
  const progress: Array<[number, string]> = [];
  const result = executeSolverJob(job, (value, stage) => progress.push([value, stage]));
  assert.equal(result.monteCarlo?.stateKind, "stock");
  if (result.monteCarlo?.stateKind !== "stock") assert.fail("Expected a Black–Scholes Monte Carlo payload");

  assert.deepEqual(progress.slice(-2), [
    [90, "Simulating exact GBM paths with continuous Brownian-bridge barrier monitoring"],
    [96, "Monte Carlo statistics and confidence interval complete"],
  ]);
  assert.equal(result.monteCarlo.diagnostics.contract, "barrier");
  assert.equal(result.monteCarlo.diagnostics.monitoring, "continuous");
  assert.equal(result.monteCarlo.diagnostics.brownianBridgeCorrection, true);
  assert.equal(result.monteCarlo.diagnostics.barrier, 130);
  assert.equal(result.monteCarlo.diagnostics.barrierDirection, "up-and-out");
  assert.ok(Number(result.monteCarlo.diagnostics.monitoringBiasEstimate) > 0);

  const manifest = createMonteCarloManifest(result.monteCarlo);
  const rows = createMonteCarloCsvRows(result.monteCarlo);
  assert.equal(manifest?.diagnostics.monitoring, "continuous");
  assert.equal(manifest?.diagnostics.payoffMethod, "terminal intrinsic payoff times Brownian-bridge conditional survival weight");
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-diagnostic" && entry[8] === "monitoring" && entry[9] === "continuous"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-diagnostic" && entry[8] === "monitoringBiasEstimate"));
});

test("American-put Monte Carlo is rejected before any terminal-payoff simulation or PDE work", () => {
  const progress: Array<[number, string]> = [];
  const job: Extract<SolverJob, { model: "Black–Scholes" }> = {
    model: "Black–Scholes",
    request: {
      ...pdeOnlyJob.request,
      side: "Put",
      contract: "american-put",
    },
    monteCarlo: monteCarloConfig(),
  };
  assert.throws(
    () => executeSolverJob(job, (value, stage) => progress.push([value, stage])),
    /out-of-sample Longstaff–Schwartz policy/,
  );
  assert.deepEqual(progress, []);
});

test("Heston solver jobs attach model-matched Monte Carlo payloads", () => {
  const hestonConfig: HestonMonteCarloConfig = {
    model: "Heston",
    enabled: true,
    paths: 512,
    timeSteps: 8,
    seed: 11,
    scheme: "andersen-qe",
    displayPathLimit: 3,
    quantileLevels: [0.1, 0.5, 0.9],
    varianceReduction: "antithetic",
  };
  const job: SolverJob = {
    model: "Heston",
    request: {
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
      side: "Put",
      spaceSteps: 16,
      varianceSteps: 8,
      timeSteps: 16,
      scheme: "mcs-adi",
      gridKind: "nonuniform",
    },
    monteCarlo: hestonConfig,
  };
  const result = executeSolverJob(job, () => {});

  assert.notEqual(
    createSolverJobKey(job),
    createSolverJobKey({ ...job, monteCarlo: { ...hestonConfig, scheme: "full-truncation-euler" } }),
  );
  assert.notEqual(
    createSolverJobKey(job),
    createSolverJobKey({ ...job, monteCarlo: { ...hestonConfig, varianceReduction: "none" } }),
  );

  assert.equal(result.monteCarlo?.stateKind, "stock-and-variance");
  if (result.monteCarlo?.stateKind !== "stock-and-variance") assert.fail("Expected a Heston Monte Carlo payload");
  assert.deepEqual(result.monteCarlo.config, hestonConfig);
  assert.equal(result.monteCarlo.varianceDiagnostics.treatment, "Andersen QE conditional moment matching");
  assert.equal(result.monteCarlo.diagnostics.scheme, "andersen-qe");
  assert.equal(result.monteCarlo.diagnostics.varianceReduction, "antithetic");
  assert.equal(result.monteCarlo.diagnostics.estimatorObservationCount, hestonConfig.paths / 2);
  assert.ok(result.monteCarlo.variance.displayedPaths.flat().every((variance) => variance >= 0));
  const manifest = createMonteCarloManifest(result.monteCarlo);
  const rows = createMonteCarloCsvRows(result.monteCarlo);
  assert.equal(manifest?.config.scheme, "andersen-qe");
  assert.equal(manifest?.config.varianceReduction, "antithetic");
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-config" && entry[8] === "variance-reduction" && entry[9] === "antithetic"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-diagnostic" && entry[8] === "standardErrorMethod"));
});

test("short-rate jobs preserve disabled mode and attach reproducible exact-Gaussian payloads", () => {
  const baseJob: Extract<SolverJob, { model: "Vasicek" | "Hull–White" }> = {
    model: "Vasicek",
    request: {
      model: "Vasicek",
      contract: "zero-coupon-bond",
      shortRate: 0.03,
      meanReversion: 0.15,
      longRunRate: 0.04,
      rateVolatility: 0.01,
      maturity: 5,
      spaceSteps: 50,
      timeSteps: 50,
      scheme: "rannacher-cn",
      gridKind: "nonuniform",
    },
  };
  const omittedProgress: Array<[number, string]> = [];
  const disabledProgress: Array<[number, string]> = [];
  const omitted = executeSolverJob(baseJob, (value, stage) => omittedProgress.push([value, stage]));
  const disabled = executeSolverJob({
    ...baseJob,
    monteCarlo: shortRateMonteCarloConfig("Vasicek", { enabled: false, seed: 9 }),
  }, (value, stage) => disabledProgress.push([value, stage]));
  assert.deepEqual(omittedProgress, [
    [18, "Assembling finite-difference operator"],
    [58, "Running affine benchmark and refinement study"],
    [86, "Checking short-rate domain expansion"],
  ]);
  assert.deepEqual(disabledProgress, omittedProgress);
  assert.deepEqual(withoutRuntimes(disabled), withoutRuntimes(omitted));

  const config = shortRateMonteCarloConfig("Vasicek");
  const job: SolverJob = { ...baseJob, monteCarlo: config };
  const progress: Array<[number, string]> = [];
  const first = executeSolverJob(job, (value, stage) => progress.push([value, stage]));
  const second = executeSolverJob(job, () => {});
  assert.deepEqual(withoutRuntimes(first), withoutRuntimes(second));
  assert.notEqual(createSolverJobKey(baseJob), createSolverJobKey(job));
  assert.notEqual(createSolverJobKey(job), createSolverJobKey({ ...job, monteCarlo: { ...config, seed: 43 } }));
  assert.deepEqual(progress.slice(-2), [
    [90, "Simulating exact Gaussian Vasicek rates and discount integrals"],
    [96, "Monte Carlo discount-factor statistics and confidence interval complete"],
  ]);
  assert.equal(first.monteCarlo?.stateKind, "short-rate-and-discount-factor");
  if (first.monteCarlo?.stateKind !== "short-rate-and-discount-factor") assert.fail("Expected a short-rate Monte Carlo payload");
  assert.equal(first.monteCarlo.diagnostics.exactJointDiscountIntegral, true);
  assert.equal(first.monteCarlo.discountedValue.mean, first.monteCarlo.discountFactor.mean);

  const manifest = createMonteCarloManifest(first.monteCarlo);
  const rows = createMonteCarloCsvRows(first.monteCarlo);
  assert.equal(manifest?.stateKind, "short-rate-and-discount-factor");
  assert.ok(manifest && "integratedShortRate" in manifest);
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-series" && entry[2] === "short-rate"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-series" && entry[2] === "discount-factor"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-diagnostic" && entry[8] === "payoffMethod"));
});

test("Hull–White solver jobs carry the immutable imported curve through solve, benchmark, refinement, domain, and Monte Carlo paths", () => {
  const discountCurve = {
    id: "USD-TREASURY-PROXY-2026-08-23",
    pillars: [
      { time: 0, discount: 1 },
      { time: 1 / 360, discount: 0.9998803 },
      { time: 0.25, discount: 0.98965 },
      { time: 1, discount: 0.96045 },
      { time: 2, discount: 0.92415 },
      { time: 5, discount: 0.81710 },
      { time: 10, discount: 0.65710 },
      { time: 30, discount: 0.26010 },
    ],
  };
  const frontRate = createDiscountCurve(discountCurve.id, discountCurve.pillars).instantaneousForward(0);
  const job: SolverJob = {
    model: "Hull–White",
    request: {
      model: "Hull–White",
      contract: "zero-coupon-bond",
      shortRate: frontRate,
      meanReversion: 0.1,
      rateVolatility: 0.01,
      maturity: 5,
      curveId: discountCurve.id,
      discountCurve,
      spaceSteps: 50,
      timeSteps: 50,
      scheme: "rannacher-cn",
      gridKind: "nonuniform",
    },
    monteCarlo: shortRateMonteCarloConfig("Hull–White", { paths: 2_000, timeSteps: 8 }),
  };
  const result = executeSolverJob(job, () => {});
  if (!("shortRate" in result.result.parameters)) assert.fail("Expected Hull–White PDE result");
  const shortRateResult = result.result as ShortRateResult;
  assert.equal(shortRateResult.parameters.curveId, discountCurve.id);
  assert.equal(shortRateResult.curveFit?.curveId, discountCurve.id);
  assert.equal(shortRateResult.curveFit?.pillarCount, discountCurve.pillars.length);
  assert.ok((shortRateResult.curveFit?.maximumBasisPointError ?? 1) < 1e-7);
  assert.ok(result.convergence.every((level) => Number.isFinite(level.price) && Number.isFinite(level.absoluteError)));
  assert.ok(Number.isFinite(result.domainExpansionDelta));
  assert.ok(Number.isFinite(shortRateResult.benchmarkPrice));
  assert.equal(result.monteCarlo?.stateKind, "short-rate-and-discount-factor");
  if (result.monteCarlo?.stateKind !== "short-rate-and-discount-factor") assert.fail("Expected Hull–White Monte Carlo payload");
  assert.equal(result.monteCarlo.diagnostics.curveId, discountCurve.id);
  assert.deepEqual(result.monteCarlo.curveReproduction?.map((point) => point.time), [0, 5]);
  assert.ok(result.monteCarlo.curveReproduction?.every((point) => Number.isFinite(point.simulatedDiscountMean)));

  const changedCurve: SolverJob = {
    ...job,
    request: { ...job.request, discountCurve: { ...discountCurve, pillars: discountCurve.pillars.map((point, index) => index === 3 ? { ...point, discount: point.discount - 0.001 } : point) } },
  };
  assert.notEqual(createSolverJobKey(job), createSolverJobKey(changedCurve));
});

test("HJB jobs attach P-measure policy simulations without derivative-pricing fields", () => {
  const baseJob: Extract<SolverJob, { model: "HJB" }> = {
    model: "HJB",
    request: {
      wealth: 100,
      maturity: 1,
      rate: 0.03,
      expectedReturn: 0.08,
      volatility: 0.2,
      riskAversion: 3,
      controlMin: -100,
      controlMax: 200,
      spaceSteps: 60,
      timeSteps: 60,
      gridKind: "nonuniform",
    },
  };
  const config = mertonMonteCarloConfig();
  const job: SolverJob = { ...baseJob, monteCarlo: config };
  const progress: Array<[number, string]> = [];
  const result = executeSolverJob(job, (value, stage) => progress.push([value, stage]));
  assert.notEqual(createSolverJobKey(baseJob), createSolverJobKey(job));
  assert.notEqual(createSolverJobKey(job), createSolverJobKey({ ...job, monteCarlo: { ...config, timeSteps: 9 } }));
  assert.deepEqual(progress.slice(-2), [
    [90, "Simulating controlled wealth under the interpolated HJB feedback policy"],
    [96, "Expected utility and policy-bound diagnostics complete"],
  ]);
  assert.equal(result.monteCarlo?.stateKind, "controlled-wealth");
  if (result.monteCarlo?.stateKind !== "controlled-wealth") assert.fail("Expected a controlled-wealth Monte Carlo payload");
  assert.equal(result.monteCarlo.measure, "P");
  assert.equal(result.monteCarlo.diagnostics.objective, "expected CRRA terminal utility; no consumption");
  assert.ok(result.monteCarlo.policy.displayedPaths.flat().every((value) => value >= -100 && value <= 200));

  const manifest = createMonteCarloManifest(result.monteCarlo);
  const rows = createMonteCarloCsvRows(result.monteCarlo);
  assert.equal(manifest?.stateKind, "controlled-wealth");
  assert.ok(manifest && "expectedUtility" in manifest);
  assert.ok(manifest && !("discountedValue" in manifest));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-series" && entry[2] === "wealth"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-series" && entry[2] === "policy"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-summary" && entry[8] === "expected-utility"));
  assert.ok(!rows.some((entry) => entry[2] === "payoff"));
});

test("manifest and CSV helpers include Monte Carlo configuration, estimates, paths, and diagnostics", () => {
  const result = simulateBlackScholesMonteCarlo({
    spot: 100,
    strike: 100,
    maturity: 1,
    rate: 0.05,
    dividend: 0,
    volatility: 0.2,
    side: "Call",
    contract: "european",
    config: monteCarloConfig({ paths: 64, timeSteps: 2, displayPathLimit: 2 }),
  });
  const manifest = createMonteCarloManifest(result);
  const rows = createMonteCarloCsvRows(result);

  assert.equal(manifest?.config.seed, 42);
  assert.equal(manifest?.discountedValue.mean, result.payoff.discountedValue.mean);
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-config" && entry[8] === "seed" && entry[9] === 42));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-summary" && entry[8] === "standard-error"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-series" && entry[8] === "quantile-0.5"));
  assert.ok(rows.some((entry) => entry[0] === "monte-carlo-path" && entry[7] === 0));
  assert.equal(createMonteCarloManifest(null), null);
  assert.deepEqual(createMonteCarloCsvRows(undefined), []);
});

test("cooperative cancellation prevents partial Monte Carlo and solver payloads", () => {
  assert.throws(
    () => executeSolverJob(pdeOnlyJob, () => {}, { isCancelled: () => true }),
    ComputationCancelledError,
  );

  let checks = 0;
  assert.throws(
    () => simulateBlackScholesMonteCarlo({
      spot: 100,
      strike: 100,
      maturity: 1,
      rate: 0.05,
      dividend: 0,
      volatility: 0.2,
      side: "Call",
      contract: "european",
      config: monteCarloConfig({ paths: 50_000, timeSteps: 8 }),
    }, { isCancelled: () => checks++ >= 3 }),
    ComputationCancelledError,
  );
});
