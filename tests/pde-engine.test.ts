import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOperator,
  americanPutBinomialPrice,
  assembleOperator,
  blackScholesBarrierPrice,
  blackScholesDigitalPrice,
  blackScholesDomainExpansionDelta,
  blackScholesPrice,
  boundaryVector,
  derivativeWeights,
  demoHullWhiteCurve,
  hullWhiteBondPrice,
  hullWhiteTheta,
  hestonDomainExpansionDelta,
  hestonRhoZeroConsistency,
  hestonSemiAnalyticPrice,
  interpolateLinear,
  mertonAnalyticPolicy,
  mertonAnalyticValue,
  mertonDomainExpansionDelta,
  nonuniformGrid,
  runBlackScholesConvergence,
  runBlackScholesProductConvergence,
  runHestonConvergence,
  runMertonConvergence,
  runShortRateConvergence,
  shortRateDomainExpansionDelta,
  solve1D,
  solveBlackScholesEuropean,
  solveBlackScholesProduct,
  solveHestonEuropean,
  solveMertonHjb,
  solveShortRateProduct,
  solveTridiagonal,
  uniformGrid,
  validateGrid,
  vasicekBondPrice,
} from "../app/lib/pde-engine/index.ts";

const maximumError = (actual: readonly number[], expected: readonly number[]) =>
  Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));

test("uniform and nonuniform grids are finite, ordered and endpoint preserving", () => {
  const uniform = uniformGrid(-2, 3, 10);
  assert.equal(uniform.length, 11);
  assert.equal(uniform[0], -2);
  assert.equal(uniform.at(-1), 3);
  assert.ok(Math.abs(uniform[1] - uniform[0] - 0.5) < 1e-14);

  const fitted = nonuniformGrid(0, 400, 80, { focus: 100, scale: 15 });
  validateGrid(fitted);
  assert.equal(fitted[0], 0);
  assert.equal(fitted.at(-1), 400);
  const strikeIndex = fitted.findIndex((node) => node >= 100);
  assert.ok(fitted[strikeIndex] - fitted[strikeIndex - 1] < fitted.at(-1)! - fitted.at(-2)!);
  assert.throws(() => validateGrid([0, 1, 1, 2]), /strictly increasing/);
});

test("nonuniform derivative weights reduce to centred uniform stencils", () => {
  const weights = derivativeWeights(0.25, 0.25);
  assert.deepEqual(weights.first, [-2, 0, 2]);
  assert.deepEqual(weights.second, [16, -32, 16]);
});

test("operator assembly includes boundary contributions and differentiates quadratics", () => {
  const nodes = [0, 0.2, 0.7, 1.4, 2];
  const coefficients = {
    diffusion: () => 1,
    drift: () => 2,
    discount: () => 0,
  };
  const operator = assembleOperator(nodes, coefficients, 0);
  const interior = nodes.slice(1, -1).map((x) => x * x);
  const applied = applyOperator(operator, interior);
  const withBoundaries = applied.map((value, index) => value + boundaryVector(operator, { left: () => 0, right: () => 4 }, 0)[index]);
  const expected = nodes.slice(1, -1).map((x) => 2 + 4 * x);
  assert.ok(maximumError(withBoundaries, expected) < 1e-12);
});

test("Thomas solver matches a known diagonally dominant system without mutating inputs", () => {
  const lower = [-1, -1];
  const diagonal = [4, 4, 4];
  const upper = [-1, -1];
  const rhs = [2, 4, 10];
  const snapshots = [lower.slice(), diagonal.slice(), upper.slice(), rhs.slice()];
  const solution = solveTridiagonal(lower, diagonal, upper, rhs);
  assert.ok(maximumError(solution, [1, 2, 3]) < 1e-13);
  assert.deepEqual([lower, diagonal, upper, rhs], snapshots);
  assert.throws(() => solveTridiagonal([], [0], [], [1]), /near-zero pivot/);
});

test("explicit, backward Euler, Crank–Nicolson and Rannacher solve the heat equation", () => {
  const nodes = uniformGrid(0, 1, 40);
  const maturity = 0.05;
  const analytic = nodes.map((x) => Math.exp(-Math.PI * Math.PI * maturity) * Math.sin(Math.PI * x));
  const common = {
    nodes,
    maturity,
    coefficients: { diffusion: () => 1, drift: () => 0, discount: () => 0 },
    initialCondition: (x: number) => Math.sin(Math.PI * x),
    boundaries: { left: () => 0, right: () => 0 },
    captureEvery: 10_000,
  } as const;
  const explicit = solve1D({ ...common, timeSteps: 400, scheme: "explicit-euler" });
  const backward = solve1D({ ...common, timeSteps: 100, scheme: "backward-euler" });
  const crank = solve1D({ ...common, timeSteps: 100, scheme: "crank-nicolson" });
  const rannacher = solve1D({ ...common, timeSteps: 100, scheme: "rannacher-cn", rannacherHalfSteps: 4 });
  assert.ok(maximumError(explicit.values, analytic) < 9e-4);
  assert.ok(maximumError(backward.values, analytic) < 2e-3);
  assert.ok(maximumError(crank.values, analytic) < 4e-4);
  assert.ok(maximumError(rannacher.values, analytic) < 4e-4);
  assert.equal(rannacher.layers.at(-1)?.tau, maturity);
  assert.equal(rannacher.diagnostics.rannacherHalfSteps, 4);
  assert.equal(explicit.diagnostics.explicitMonotonicityWarning, null);
});

test("explicit diagnostics flag an unsafe heat-equation step", () => {
  const result = solve1D({
    nodes: uniformGrid(0, 1, 40),
    maturity: 0.05,
    timeSteps: 4,
    coefficients: { diffusion: () => 1, drift: () => 0, discount: () => 0 },
    initialCondition: (x) => Math.sin(Math.PI * x),
    boundaries: { left: () => 0, right: () => 0 },
    scheme: "explicit-euler",
  });
  assert.match(result.diagnostics.explicitMonotonicityWarning ?? "", /not monotone/);
});

test("linear interpolation reports exact nodes, brackets and rejects extrapolation", () => {
  const nodes = [0, 1, 3];
  const values = [0, 2, 6];
  assert.deepEqual(interpolateLinear(nodes, values, 1), {
    value: 2,
    lowerIndex: 1,
    upperIndex: 1,
    lowerWeight: 1,
    upperWeight: 0,
    exactNode: true,
  });
  const between = interpolateLinear(nodes, values, 2);
  assert.equal(between.value, 4);
  assert.equal(between.lowerIndex, 1);
  assert.equal(between.upperIndex, 2);
  assert.throws(() => interpolateLinear(nodes, values, 4), /extrapolation is disabled/);
});

const standard = {
  spot: 100,
  strike: 100,
  maturity: 1,
  rate: 0.05,
  dividend: 0,
  volatility: 0.2,
} as const;

test("Black–Scholes calls and puts agree with closed form and put-call parity", () => {
  const call = solveBlackScholesEuropean({ ...standard, side: "Call", spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn" });
  const put = solveBlackScholesEuropean({ ...standard, side: "Put", spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn" });
  assert.ok(call.absoluteError < 1e-3, `call error ${call.absoluteError}`);
  assert.ok(put.absoluteError < 1e-3, `put error ${put.absoluteError}`);
  const parity = standard.spot * Math.exp(-standard.dividend * standard.maturity)
    - standard.strike * Math.exp(-standard.rate * standard.maturity);
  assert.ok(Math.abs(call.price - put.price - parity) < 2e-4);
  assert.ok(call.solution.values.every((value) => value >= -1e-10));
  assert.ok(put.solution.values.every((value) => value >= -1e-10));
  assert.ok(call.solution.values.every((value, index, values) => index === 0 || value >= values[index - 1] - 1e-10));
  assert.ok(put.solution.values.every((value, index, values) => index === 0 || value <= values[index - 1] + 1e-10));
});

test("Black–Scholes nonuniform grid converges and domain expansion is immaterial", () => {
  const fitted = solveBlackScholesEuropean({ ...standard, side: "Call", spaceSteps: 160, timeSteps: 200, scheme: "rannacher-cn", gridKind: "nonuniform" });
  assert.ok(fitted.absoluteError < 2e-3, `nonuniform error ${fitted.absoluteError}`);
  const domainDelta = blackScholesDomainExpansionDelta({ ...standard, side: "Call", spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn" });
  assert.ok(domainDelta < 1e-3, `domain expansion delta ${domainDelta}`);
});

test("systematic refinement reduces Black–Scholes error", () => {
  const levels = runBlackScholesConvergence({ ...standard, side: "Call", scheme: "rannacher-cn", gridKind: "uniform" });
  assert.equal(levels.length, 3);
  assert.ok(levels[1].absoluteError < levels[0].absoluteError);
  assert.ok(levels[2].absoluteError < levels[1].absoluteError);
  assert.ok((levels[2].observedOrder ?? 0) > 1.7, JSON.stringify(levels));
  assert.ok(Math.abs(blackScholesPrice({ ...standard, side: "Call" }) - 10.4506) < 1e-3);
});

test("cash digitals pass closed-form, boundary, complementarity and refinement checks", () => {
  const common = { ...standard, contract: "digital" as const, spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn" as const };
  const call = solveBlackScholesProduct({ ...common, side: "Call" });
  const put = solveBlackScholesProduct({ ...common, side: "Put" });
  const discountedUnit = Math.exp(-standard.rate * standard.maturity);
  assert.ok(call.absoluteError < 3e-3, `digital call error ${call.absoluteError}`);
  assert.ok(put.absoluteError < 3e-3, `digital put error ${put.absoluteError}`);
  assert.ok(Math.abs(call.price + put.price - discountedUnit) < 2e-4);
  assert.equal(call.solution.values[0], 0);
  assert.ok(Math.abs(call.solution.values.at(-1)! - discountedUnit) < 1e-14);
  assert.ok(call.solution.values.every((value) => value >= -1e-8 && value <= discountedUnit + 1e-7));
  assert.ok(Math.abs(blackScholesDigitalPrice({ ...standard, side: "Call" }) - 0.532325) < 1e-5);

  const levels = runBlackScholesProductConvergence({ ...standard, side: "Call", contract: "digital", scheme: "rannacher-cn", gridKind: "uniform" });
  assert.ok(levels[2].absoluteError < levels[1].absoluteError);
  assert.ok((levels[2].observedOrder ?? 0) > 0.9, JSON.stringify(levels));
});

test("continuous zero-rebate barriers are barrier-fitted, bounded by vanilla and converge to closed form", () => {
  const upCallRequest = {
    ...standard,
    side: "Call" as const,
    contract: "barrier" as const,
    barrier: 130,
    barrierDirection: "up-and-out" as const,
    spaceSteps: 200,
    timeSteps: 200,
    scheme: "rannacher-cn" as const,
  };
  const upCall = solveBlackScholesProduct(upCallRequest);
  const vanillaCall = blackScholesPrice({ ...standard, side: "Call" });
  assert.equal(upCall.solution.nodes.at(-1), 130);
  assert.equal(upCall.solution.values.at(-1), 0);
  assert.ok(upCall.absoluteError < 5e-3, `up-and-out call error ${upCall.absoluteError}`);
  assert.ok(upCall.price >= 0 && upCall.price <= vanillaCall);
  assert.ok(Math.abs(blackScholesBarrierPrice(upCallRequest, 130, "up-and-out") - upCall.analyticPrice) < 1e-13);

  const downPut = solveBlackScholesProduct({
    ...standard,
    side: "Put",
    contract: "barrier",
    barrier: 70,
    barrierDirection: "down-and-out",
    spaceSteps: 200,
    timeSteps: 200,
    scheme: "rannacher-cn",
  });
  assert.equal(downPut.solution.nodes[0], 70);
  assert.equal(downPut.solution.values[0], 0);
  assert.ok(downPut.absoluteError < 5e-3, `down-and-out put error ${downPut.absoluteError}`);
  assert.ok(downPut.price <= blackScholesPrice({ ...standard, side: "Put" }));

  const levels = runBlackScholesProductConvergence({ ...upCallRequest, gridKind: "uniform" });
  assert.ok(levels[2].absoluteError < levels[1].absoluteError);
  assert.ok((levels[2].observedOrder ?? 0) > 1.5, JSON.stringify(levels));
});

test("projected-SOR American put satisfies price, obstacle, boundary and LCP gates", () => {
  const request = {
    ...standard,
    side: "Put" as const,
    contract: "american-put" as const,
    spaceSteps: 200,
    timeSteps: 200,
    scheme: "rannacher-cn" as const,
    gridKind: "nonuniform" as const,
  };
  const american = solveBlackScholesProduct(request);
  const european = solveBlackScholesEuropean({ ...standard, side: "Put", spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn" });
  const tree = americanPutBinomialPrice(request);
  assert.ok(american.absoluteError < 1e-2, `American price error ${american.absoluteError}`);
  assert.ok(Math.abs(american.price - tree) < 1e-2);
  assert.ok(american.price >= european.price);
  assert.ok(american.price <= standard.strike);
  assert.equal(american.solution.values[0], standard.strike);
  assert.equal(american.solution.values.at(-1), 0);
  assert.ok(american.solution.values.every((value, index) => value + 1e-9 >= Math.max(standard.strike - american.solution.nodes[index], 0)));
  assert.ok((american.exerciseDiagnostics?.maxComplementarityResidual ?? 1) < 1e-7);
  assert.ok((american.exerciseDiagnostics?.exerciseBoundary ?? 0) > 70);
  assert.ok((american.exerciseDiagnostics?.exerciseBoundary ?? 100) < standard.strike);
});

test("Phase 2 Greeks reproduce the standard European analytic fixture", () => {
  const result = solveBlackScholesEuropean({ ...standard, side: "Call", spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn", gridKind: "nonuniform" });
  assert.ok(Math.abs(result.greeks.delta - 0.636831) < 4e-3, JSON.stringify(result.greeks));
  assert.ok(Math.abs(result.greeks.gamma - 0.018762) < 3e-4, JSON.stringify(result.greeks));
  assert.ok(Math.abs(result.greeks.theta - -6.41403) < 3e-2, JSON.stringify(result.greeks));
  assert.ok(Math.abs(result.greeks.vega - 37.5240) < 8e-2, JSON.stringify(result.greeks));
  assert.ok(Math.abs(result.greeks.rho - 53.2325) < 8e-2, JSON.stringify(result.greeks));
});

const vasicekStandard = {
  model: "Vasicek" as const,
  shortRate: 0.03,
  meanReversion: 0.15,
  longRunRate: 0.04,
  rateVolatility: 0.01,
  maturity: 5,
} as const;

const hullWhiteStandard = {
  model: "Hull–White" as const,
  shortRate: 0.03,
  meanReversion: 0.1,
  rateVolatility: 0.01,
  maturity: 5,
  curveId: "AUD-OIS-demo-2026-07-29",
} as const;

test("Vasicek bonds use a negative-rate grid and reproduce the affine benchmark", () => {
  const result = solveShortRateProduct({
    ...vasicekStandard,
    contract: "zero-coupon-bond",
    spaceSteps: 200,
    timeSteps: 200,
    scheme: "rannacher-cn",
  });
  assert.ok(result.solution.nodes[0] < 0, `domain ${result.solution.diagnostics.domain}`);
  assert.ok(result.absoluteError < 1e-5, `Vasicek bond error ${result.absoluteError}`);
  assert.ok(result.maxNormError < 5e-5, `Vasicek max error ${result.maxNormError}`);
  assert.ok(shortRateDomainExpansionDelta({ ...vasicekStandard, contract: "zero-coupon-bond", spaceSteps: 200, timeSteps: 200 }) < 1e-5);
  assert.ok(result.solution.values.every((value, index, values) => index === 0 || value <= values[index - 1]));
  assert.ok(Math.abs(result.benchmarkPrice - vasicekBondPrice(vasicekStandard, 5)) < 1e-14);
});

test("Vasicek bond calls pass analytic, domain and refinement gates", () => {
  const request = {
    ...vasicekStandard,
    contract: "bond-option" as const,
    bondMaturity: 10,
    strike: 0.75,
  };
  const result = solveShortRateProduct({ ...request, spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn" });
  assert.ok(result.absoluteError < 1e-4, `Vasicek option error ${result.absoluteError}`);
  assert.ok(result.solution.values.every((value) => value >= -1e-12));
  const levels = runShortRateConvergence(request, [100, 200, 400]);
  assert.ok(levels[2].absoluteError < levels[1].absoluteError, JSON.stringify(levels));
  assert.ok((levels[2].observedOrder ?? 0) > 1.8, JSON.stringify(levels));
});

test("Hull–White reconstructs time-dependent theta and exactly fits every input-curve pillar", () => {
  const curve = demoHullWhiteCurve(hullWhiteStandard.shortRate, hullWhiteStandard.curveId);
  const parameters = { ...hullWhiteStandard, curve };
  for (const pillar of curve.pillars) {
    const fitted = hullWhiteBondPrice(parameters, pillar.time);
    assert.ok(Math.abs(fitted / pillar.discount - 1) < 1e-12, `curve pillar ${pillar.time}: ${fitted} vs ${pillar.discount}`);
  }
  assert.ok(Math.abs(hullWhiteTheta(parameters, 0.25) - hullWhiteTheta(parameters, 4.5)) > 1e-5);

  const result = solveShortRateProduct({
    ...hullWhiteStandard,
    contract: "zero-coupon-bond",
    spaceSteps: 200,
    timeSteps: 200,
    scheme: "rannacher-cn",
  });
  assert.ok(result.solution.nodes[0] < 0);
  assert.ok(result.absoluteError < 1e-5, `Hull–White bond error ${result.absoluteError}`);
  assert.ok((result.curveFit?.maximumBasisPointError ?? 1) < 1e-8, JSON.stringify(result.curveFit));
  assert.equal(result.curveFit?.pillarCount, curve.pillars.length);
});

test("Hull–White bond calls use the fitted curve and converge to the analytic benchmark", () => {
  const request = {
    ...hullWhiteStandard,
    contract: "bond-option" as const,
    bondMaturity: 10,
    strike: 0.75,
  };
  const result = solveShortRateProduct({ ...request, spaceSteps: 200, timeSteps: 200, scheme: "rannacher-cn" });
  assert.ok(result.absoluteError < 2e-4, `Hull–White option error ${result.absoluteError}`);
  assert.ok(result.maxNormError < 1e-3, `Hull–White option max error ${result.maxNormError}`);
  assert.ok(shortRateDomainExpansionDelta({ ...request, spaceSteps: 200, timeSteps: 200 }) < 1e-5);
  const levels = runShortRateConvergence(request, [100, 200, 400]);
  assert.ok(levels[2].absoluteError < levels[1].absoluteError, JSON.stringify(levels));
  assert.ok((levels[2].observedOrder ?? 0) > 1.8, JSON.stringify(levels));
});

const hestonStandard = {
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
  side: "Call" as const,
};

test("Heston Fourier quadrature reproduces the published standard fixture and put-call parity", () => {
  const call = hestonSemiAnalyticPrice(hestonStandard);
  const put = hestonSemiAnalyticPrice({ ...hestonStandard, side: "Put" });
  assert.ok(Math.abs(call - 10.3942185652) < 1e-9, `Heston call ${call}`);
  const parity = hestonStandard.spot * Math.exp(-hestonStandard.dividend * hestonStandard.maturity)
    - hestonStandard.strike * Math.exp(-hestonStandard.rate * hestonStandard.maturity);
  assert.ok(Math.abs(call - put - parity) < 1e-10, `put-call parity ${call - put - parity}`);
});

test("Heston MCS and HV ADI use tensor grids, the nine-point cross stencil and degenerate boundaries", () => {
  for (const scheme of ["mcs-adi", "hv-adi"] as const) {
    const result = solveHestonEuropean({
      ...hestonStandard,
      spaceSteps: 80,
      varianceSteps: 40,
      timeSteps: 160,
      scheme,
      gridKind: "nonuniform",
      captureEvery: 20,
    });
    assert.equal(result.solution.spotNodes.length, 81);
    assert.equal(result.solution.varianceNodes.length, 41);
    assert.equal(result.solution.values.length, 41);
    assert.ok(result.solution.values.every((row) => row.length === 81));
    assert.equal(result.solution.diagnostics.crossDerivativeStencil, "nine-point nonuniform");
    assert.equal(result.solution.diagnostics.degenerateBoundaryApplied, true);
    assert.ok(result.solution.diagnostics.maximumFarVarianceGradient < 1e-12);
    assert.ok(result.solution.diagnostics.maxLinearResidual < 1e-9);
    assert.ok(result.solution.diagnostics.minimumValue > -1e-3);
    assert.ok(result.absoluteError < 5e-3, `${scheme} error ${result.absoluteError}`);
    assert.ok(result.solution.layers.length >= 8);
    assert.ok(Number.isFinite(result.sensitivities.varianceDelta));
  }
});

test("Heston remains accurate when the Feller condition is violated", () => {
  const result = solveHestonEuropean({
    ...hestonStandard,
    rate: 0.03,
    dividend: 0.01,
    kappa: 1.2,
    xi: 0.5,
    rho: -0.65,
    side: "Put",
    spaceSteps: 64,
    varianceSteps: 32,
    timeSteps: 128,
    scheme: "mcs-adi",
    gridKind: "nonuniform",
    captureEvery: 128,
  });
  assert.equal(result.solution.diagnostics.fellerSatisfied, false);
  assert.ok(result.solution.diagnostics.fellerRatio < 1);
  assert.ok(result.absoluteError < 5e-3, `Feller-violating error ${result.absoluteError}`);
  assert.ok(result.solution.values.flat().every(Number.isFinite));
});

test("Heston refinement, domain expansion and rho-zero scheme consistency pass their gates", () => {
  const levels = runHestonConvergence(hestonStandard, [16, 32, 64]);
  assert.ok(levels[1].absoluteError < levels[0].absoluteError, JSON.stringify(levels));
  assert.ok(levels[2].absoluteError < levels[1].absoluteError, JSON.stringify(levels));
  assert.ok((levels[2].observedOrder ?? 0) > 1.5, JSON.stringify(levels));
  const compact = { ...hestonStandard, spaceSteps: 40, varianceSteps: 20, timeSteps: 80, scheme: "mcs-adi" as const, gridKind: "nonuniform" as const };
  assert.ok(hestonDomainExpansionDelta(compact) < 1e-2);
  assert.ok(hestonRhoZeroConsistency(compact) < 1e-3);
});

const mertonStandard = {
  wealth: 100,
  maturity: 1,
  rate: 0.03,
  expectedReturn: 0.08,
  volatility: 0.20,
  riskAversion: 3,
  controlMin: -100,
  controlMax: 200,
};

test("Merton HJB reproduces the unconstrained CRRA value and dollar policy", () => {
  const result = solveMertonHjb({
    ...mertonStandard,
    spaceSteps: 200,
    timeSteps: 200,
    gridKind: "nonuniform",
    captureEvery: 20,
  });
  assert.equal(result.solution.scheme, "howard-implicit");
  assert.equal(result.unconstrainedBenchmarkApplicable, true);
  assert.equal(result.solution.diagnostics.stateConstraintBoundary, true);
  assert.equal(result.solution.diagnostics.operatorOffDiagonalsNonnegative, true);
  assert.equal(result.solution.diagnostics.policyConverged, true);
  assert.ok(result.solution.diagnostics.minimumImplicitDiagonalMargin > 0.999);
  assert.ok(result.solution.diagnostics.maxLinearResidual < 1e-12);
  assert.ok(result.solution.diagnostics.maxBellmanResidual < 5e-5);
  assert.ok(result.relativeError < 1e-3, `value relative error ${result.relativeError}`);
  assert.ok(result.policyAbsoluteError < 0.2, `policy error ${result.policyAbsoluteError}`);
  assert.ok(Math.abs(result.analyticValue - mertonAnalyticValue(100, 1, mertonStandard)) < 1e-15);
  assert.ok(Math.abs(result.analyticPolicy - mertonAnalyticPolicy(100, mertonStandard)) < 1e-12);
  assert.ok(result.solution.values.every((value, index, values) => index === 0 || value >= values[index - 1] - 1e-12));
  assert.ok(result.solution.layers.length >= 10);
});

test("Merton Howard iteration enforces control bounds and the positive-wealth boundary", () => {
  const result = solveMertonHjb({
    ...mertonStandard,
    controlMin: 0,
    controlMax: 20,
    spaceSteps: 160,
    timeSteps: 160,
    gridKind: "nonuniform",
    captureEvery: 160,
  });
  assert.ok(Math.abs(result.policy - 20) < 1e-10, `bounded policy ${result.policy}`);
  assert.equal(result.solution.policies[0], 0);
  assert.ok(result.solution.policies.every((policy) => policy >= -1e-12 && policy <= 20 + 1e-12));
  assert.ok(result.solution.diagnostics.upperControlActivityFraction > 0.5);
  assert.ok(result.value < result.analyticValue, `${result.value} should be below ${result.analyticValue}`);
});

test("Merton value and policy pass refinement and domain-expansion gates", () => {
  const levels = runMertonConvergence({ ...mertonStandard, gridKind: "nonuniform" }, [50, 100, 200, 400]);
  assert.ok(levels[1].absoluteError < levels[0].absoluteError, JSON.stringify(levels));
  assert.ok(levels[2].absoluteError < levels[1].absoluteError, JSON.stringify(levels));
  assert.ok(levels[3].absoluteError < levels[2].absoluteError, JSON.stringify(levels));
  assert.ok((levels[3].observedOrder ?? 0) > 0.9, JSON.stringify(levels));
  assert.ok(levels[0].policyAbsoluteError < 0.2, JSON.stringify(levels));
  assert.ok(levels[3].policyAbsoluteError < 1e-6, JSON.stringify(levels));
  assert.ok(mertonDomainExpansionDelta({ ...mertonStandard, spaceSteps: 100, timeSteps: 100, gridKind: "nonuniform" }) < 1e-7);
});
