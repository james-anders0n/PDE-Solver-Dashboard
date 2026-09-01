import assert from "node:assert/strict";
import test from "node:test";
import { ComputationCancelledError } from "../app/lib/computation-control.ts";
import {
  gaussianRateIntegralMoments,
  hullWhiteRateShift,
  hullWhiteRateShiftIntegral,
  shortRateTheoreticalMoments,
  simulateShortRateMonteCarlo,
  type ShortRateMonteCarloConfig,
  type ShortRateMonteCarloRequest,
} from "../app/lib/monte-carlo/index.ts";
import {
  demoHullWhiteCurve,
  hullWhiteBondOptionPrice,
  hullWhiteBondPrice,
  hullWhiteTheta,
  vasicekBondOptionPrice,
  vasicekBondPrice,
} from "../app/lib/pde-engine/index.ts";

const vasicek = {
  model: "Vasicek",
  shortRate: 0.03,
  meanReversion: 0.15,
  longRunRate: 0.04,
  rateVolatility: 0.01,
  maturity: 5,
} as const;

const hullWhite = {
  model: "Hull–White",
  shortRate: 0.03,
  meanReversion: 0.1,
  rateVolatility: 0.01,
  maturity: 5,
  curveId: "AUD-OIS-demo-2026-07-29",
} as const;

const config = (
  model: "Vasicek" | "Hull–White",
  overrides: Partial<ShortRateMonteCarloConfig> = {},
): ShortRateMonteCarloConfig => ({
  model,
  enabled: true,
  paths: 100_000,
  timeSteps: 1,
  seed: 42,
  scheme: "exact-gaussian",
  displayPathLimit: 5,
  quantileLevels: [0.05, 0.25, 0.5, 0.75, 0.95],
  ...overrides,
});

const contains = (interval: readonly [number, number], value: number) => interval[0] <= value && value <= interval[1];

test("joint Gaussian rate/integral moments are positive and match the closed-form covariance", () => {
  const moments = gaussianRateIntegralMoments(0.15, 0.01, 0.25);
  const a = 0.15;
  const dt = 0.25;
  const sigma = 0.01;
  const b = (1 - Math.exp(-a * dt)) / a;
  const rateKernelVariance = (1 - Math.exp(-2 * a * dt)) / (2 * a);
  const expectedRateVariance = sigma ** 2 * rateKernelVariance;
  const expectedIntegralVariance = sigma ** 2 * (dt - 2 * b + rateKernelVariance) / a ** 2;
  const expectedCovariance = sigma ** 2 * (b - rateKernelVariance) / a;
  assert.ok(Math.abs(moments.rateVariance / expectedRateVariance - 1) < 1e-12);
  assert.ok(Math.abs(moments.integralVariance / expectedIntegralVariance - 1) < 1e-10);
  assert.ok(Math.abs(moments.covariance / expectedCovariance - 1) < 1e-11);
  assert.ok(moments.correlation > 0 && moments.correlation < 1);
});

test("exact Vasicek transitions reproduce terminal-rate and discount-integral moments", () => {
  const request: ShortRateMonteCarloRequest = {
    ...vasicek,
    contract: "zero-coupon-bond",
    config: config("Vasicek", { paths: 120_000 }),
  };
  const result = simulateShortRateMonteCarlo(request);
  const theory = shortRateTheoreticalMoments(request, request.maturity);
  const rateMeanZ = Math.abs(result.terminalShortRate.mean - theory.rateMean)
    / Math.sqrt(theory.rateVariance / request.config.paths);
  const integralMeanZ = Math.abs(result.integratedShortRate.mean - theory.integratedRateMean)
    / Math.sqrt(theory.integratedRateVariance / request.config.paths);

  assert.ok(rateMeanZ < 4, `terminal-rate mean z=${rateMeanZ}`);
  assert.ok(integralMeanZ < 4, `integral mean z=${integralMeanZ}`);
  assert.ok(Math.abs(result.terminalShortRate.variance / theory.rateVariance - 1) < 0.025);
  assert.ok(Math.abs(result.integratedShortRate.variance / theory.integratedRateVariance - 1) < 0.025);
  assert.ok(contains(result.discountedValue.confidence95, vasicekBondPrice(vasicek, vasicek.maturity)));
  assert.equal(result.diagnostics.exactConditionalRateTransition, true);
  assert.equal(result.diagnostics.exactJointDiscountIntegral, true);
});

test("Hull–White shift matches the PDE theta convention and its exact integral prices the frozen curve", () => {
  const curve = demoHullWhiteCurve(hullWhite.shortRate, hullWhite.curveId);
  const parameters = { ...hullWhite, curve };
  for (const time of [0.25, 1, 4.5, 10]) {
    const epsilon = 1e-5;
    const derivative = (
      hullWhiteRateShift(curve, hullWhite.meanReversion, hullWhite.rateVolatility, time + epsilon)
      - hullWhiteRateShift(curve, hullWhite.meanReversion, hullWhite.rateVolatility, time - epsilon)
    ) / (2 * epsilon);
    const reconstructedTheta = derivative + hullWhite.meanReversion
      * hullWhiteRateShift(curve, hullWhite.meanReversion, hullWhite.rateVolatility, time);
    assert.ok(Math.abs(reconstructedTheta - hullWhiteTheta(parameters, time)) < 2e-8);
  }
  const integral = hullWhiteRateShiftIntegral(curve, hullWhite.meanReversion, hullWhite.rateVolatility, 0, 5);
  assert.ok(Number.isFinite(integral));
  const moments = shortRateTheoreticalMoments(hullWhite, 5);
  assert.ok(Math.abs(moments.discountFactorMean - curve.discount(5)) < 1e-13);
  assert.ok(Math.abs(moments.discountFactorMean - hullWhiteBondPrice(parameters, 5)) < 1e-13);
});

test("Vasicek and Hull–White bonds and bond calls contain every affine benchmark in the 95% interval", () => {
  const curve = demoHullWhiteCurve(hullWhite.shortRate, hullWhite.curveId);
  const fixtures = [
    {
      request: vasicek,
      bond: vasicekBondPrice(vasicek, vasicek.maturity),
      option: vasicekBondOptionPrice(vasicek, vasicek.maturity, 10, 0.75),
    },
    {
      request: hullWhite,
      bond: hullWhiteBondPrice({ ...hullWhite, curve }, hullWhite.maturity),
      option: hullWhiteBondOptionPrice({ ...hullWhite, curve }, hullWhite.maturity, 10, 0.75),
    },
  ] as const;

  for (const fixture of fixtures) {
    for (const contract of ["zero-coupon-bond", "bond-option"] as const) {
      const request: ShortRateMonteCarloRequest = {
        ...fixture.request,
        contract,
        ...(contract === "bond-option" ? { bondMaturity: 10, strike: 0.75 } : {}),
        config: config(fixture.request.model),
      };
      const result = simulateShortRateMonteCarlo(request);
      const analytic = contract === "bond-option" ? fixture.option : fixture.bond;
      assert.ok(contains(result.discountedValue.confidence95, analytic), `${fixture.request.model} ${contract}: ${JSON.stringify({ estimate: result.discountedValue, analytic })}`);
      assert.equal(result.terminalPayoff.count, request.config.paths);
      assert.equal(result.discountedPathValue.mean, result.discountedValue.mean);
      if (contract === "bond-option") assert.ok(result.terminalUnderlyingBond);
    }
  }
});

test("exact scheme is reproducible and remains unbiased under a finer display time grid", () => {
  const request: ShortRateMonteCarloRequest = {
    ...hullWhite,
    contract: "bond-option",
    bondMaturity: 10,
    strike: 0.75,
    config: config("Hull–White", { paths: 30_000, timeSteps: 8, displayPathLimit: 7 }),
  };
  const first = simulateShortRateMonteCarlo(request);
  const second = simulateShortRateMonteCarlo(request);
  assert.deepEqual({ ...first, runtimeMs: 0 }, { ...second, runtimeMs: 0 });
  assert.equal(first.shortRate.displayedPaths.length, 7);
  assert.ok(first.shortRate.displayedPaths.every((path) => path.length === 9));

  const curve = demoHullWhiteCurve(hullWhite.shortRate, hullWhite.curveId);
  const analytic = hullWhiteBondOptionPrice({ ...hullWhite, curve }, hullWhite.maturity, 10, 0.75);
  const coarse = simulateShortRateMonteCarlo({ ...request, config: { ...request.config, timeSteps: 1 } });
  assert.ok(Math.abs(first.discountedValue.mean - analytic) < 4 * first.discountedValue.standardError);
  assert.ok(Math.abs(coarse.discountedValue.mean - analytic) < 4 * coarse.discountedValue.standardError);
});

test("Hull–White Monte Carlo reproduces every frozen-curve pillar within its statistical gate", () => {
  const curve = demoHullWhiteCurve(hullWhite.shortRate, hullWhite.curveId);
  for (const pillar of curve.pillars.filter((point) => point.time > 0)) {
    const result = simulateShortRateMonteCarlo({
      ...hullWhite,
      maturity: pillar.time,
      contract: "zero-coupon-bond",
      config: config("Hull–White", { paths: 30_000, displayPathLimit: 1 }),
    });
    const check = result.curveReproduction?.find((point) => point.time === pillar.time);
    assert.ok(check, `missing curve check at ${pillar.time}`);
    assert.equal(check.inputDiscount, pillar.discount);
    assert.ok(Math.abs(check.standardizedError) < 4, `pillar ${pillar.time}: z=${check.standardizedError}`);
    assert.ok(Math.abs(check.simulatedDiscountMean / check.inputDiscount - 1) < 0.01, `pillar ${pillar.time}`);
  }
});

test("short-rate engine rejects disabled, mismatched, and incomplete product configurations", () => {
  const request: ShortRateMonteCarloRequest = {
    ...vasicek,
    contract: "zero-coupon-bond",
    config: config("Vasicek"),
  };
  assert.throws(() => simulateShortRateMonteCarlo({ ...request, config: { ...request.config, enabled: false } }), /must be enabled/);
  assert.throws(() => simulateShortRateMonteCarlo({ ...request, config: { ...request.config, model: "Hull–White" } }), /model-matched/);
  assert.throws(() => simulateShortRateMonteCarlo({ ...request, contract: "bond-option" }), /bond maturity must be after option expiry/);
});

test("short-rate simulation is cooperatively cancellation safe", () => {
  let checks = 0;
  assert.throws(() => simulateShortRateMonteCarlo({
    ...vasicek,
    contract: "zero-coupon-bond",
    config: config("Vasicek", { paths: 50_000, timeSteps: 8 }),
  }, { isCancelled: () => checks++ >= 3 }), ComputationCancelledError);
});
