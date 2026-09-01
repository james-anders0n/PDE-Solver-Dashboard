import { observedOrder } from "./diagnostics.ts";
import { nonuniformGrid, uniformGrid } from "./grids.ts";
import { interpolateLinear, type InterpolationResult } from "./interpolation.ts";
import { derivativeWeights } from "./operator.ts";
import { solve1D } from "./solver.ts";
import type { Scheme, Solve1DResult } from "./types.ts";

export type ShortRateModel = "Vasicek" | "Hull–White";
export type ShortRateContract = "zero-coupon-bond" | "bond-option";
export type RateGridKind = "uniform" | "nonuniform";

export interface DiscountCurvePoint {
  time: number;
  discount: number;
}

export interface DiscountCurve {
  id: string;
  pillars: readonly DiscountCurvePoint[];
  discount: (time: number) => number;
  instantaneousForward: (time: number) => number;
  forwardDerivative: (time: number) => number;
}

export interface SerializableDiscountCurve {
  id: string;
  pillars: readonly DiscountCurvePoint[];
}

export interface ShortRateSolveRequest {
  model: ShortRateModel;
  contract: ShortRateContract;
  shortRate: number;
  meanReversion: number;
  rateVolatility: number;
  maturity: number;
  longRunRate?: number;
  bondMaturity?: number;
  strike?: number;
  curveId?: string;
  discountCurve?: SerializableDiscountCurve;
  spaceSteps: number;
  timeSteps: number;
  scheme?: Scheme;
  gridKind?: RateGridKind;
  rateMin?: number;
  rateMax?: number;
  rannacherHalfSteps?: number;
  captureEvery?: number;
}

export interface ShortRateSensitivities {
  rateDelta: number;
  rateGamma: number;
  volatilitySensitivity: number;
}

export interface CurveFitDiagnostics {
  curveId: string;
  pillarCount: number;
  maximumRelativeError: number;
  maximumBasisPointError: number;
  thetaMinimum: number;
  thetaMaximum: number;
}

export interface ShortRateResult {
  model: ShortRateModel;
  contract: ShortRateContract;
  parameters: {
    shortRate: number;
    meanReversion: number;
    longRunRate?: number;
    rateVolatility: number;
    maturity: number;
    bondMaturity?: number;
    strike?: number;
    curveId?: string;
  };
  price: number;
  benchmarkPrice: number;
  analyticPrice: number;
  benchmarkLabel: string;
  absoluteError: number;
  relativeError: number;
  maxNormError: number;
  l2Error: number;
  interpolation: InterpolationResult;
  solution: Solve1DResult;
  analyticValues: number[];
  gridKind: RateGridKind;
  sensitivities: ShortRateSensitivities;
  curveFit?: CurveFitDiagnostics;
}

export interface ShortRateConvergenceLevel {
  spaceSteps: number;
  timeSteps: number;
  price: number;
  analyticPrice: number;
  absoluteError: number;
  observedOrder: number | null;
}

export const HULL_WHITE_DEMO_CURVE_ID = "AUD-OIS-demo-2026-07-29";
const DEMO_ZERO_RATES = [
  [0, 0.03], [0.25, 0.0302], [0.5, 0.0305], [1, 0.0315], [2, 0.033],
  [3, 0.0342], [5, 0.036], [7, 0.0373], [10, 0.039], [15, 0.041],
  [20, 0.0423], [30, 0.0435], [60, 0.0445],
] as const;

function normalCdf(value: number): number {
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = Math.exp(-0.5 * absolute * absolute) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
}

export function validateDiscountCurvePillars(points: readonly DiscountCurvePoint[]): void {
  if (points.length < 3 || points[0].time !== 0 || points[0].discount !== 1) {
    throw new Error("A discount curve requires at least three pillars and must start at P(0,0)=1.");
  }
  points.forEach((point, index) => {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.discount) || point.discount <= 0) {
      throw new Error("Discount-curve times and discounts must be finite, with positive discounts.");
    }
    if (index > 0 && point.time <= points[index - 1].time) throw new Error("Discount-curve pillar times must be strictly increasing.");
    if (index > 0 && point.discount > points[index - 1].discount + 1e-14) throw new Error("The Phase 3 input discount curve must be non-increasing.");
  });
}

/** Natural cubic interpolation of log-discount factors, with linear end extrapolation. */
export function createDiscountCurve(id: string, pillars: readonly DiscountCurvePoint[]): DiscountCurve {
  validateDiscountCurvePillars(pillars);
  const times = pillars.map((point) => point.time);
  const logs = pillars.map((point) => Math.log(point.discount));
  const count = times.length;
  const second = new Array<number>(count).fill(0);
  const lower = new Array<number>(count).fill(0);
  const diagonal = new Array<number>(count).fill(1);
  const upper = new Array<number>(count).fill(0);
  const rhs = new Array<number>(count).fill(0);
  for (let index = 1; index < count - 1; index += 1) {
    const left = times[index] - times[index - 1];
    const right = times[index + 1] - times[index];
    lower[index] = left;
    diagonal[index] = 2 * (left + right);
    upper[index] = right;
    rhs[index] = 6 * ((logs[index + 1] - logs[index]) / right - (logs[index] - logs[index - 1]) / left);
  }
  for (let index = 1; index < count; index += 1) {
    const factor = lower[index] / diagonal[index - 1];
    diagonal[index] -= factor * upper[index - 1];
    rhs[index] -= factor * rhs[index - 1];
  }
  second[count - 1] = rhs[count - 1] / diagonal[count - 1];
  for (let index = count - 2; index >= 0; index -= 1) second[index] = (rhs[index] - upper[index] * second[index + 1]) / diagonal[index];

  const interval = (time: number) => {
    if (!Number.isFinite(time) || time < 0) throw new Error("Curve time must be finite and nonnegative.");
    if (time >= times[count - 1]) return count - 2;
    let low = 0;
    let high = count - 1;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (times[middle] <= time) low = middle;
      else high = middle;
    }
    return low;
  };
  const evaluateLog = (time: number): [number, number, number] => {
    const index = interval(time);
    const leftTime = times[index];
    const rightTime = times[index + 1];
    const h = rightTime - leftTime;
    if (time > times[count - 1]) {
      const slope = (logs[count - 1] - logs[count - 2]) / h + h * (second[count - 2] + 2 * second[count - 1]) / 6;
      return [logs[count - 1] + slope * (time - times[count - 1]), slope, 0];
    }
    const a = (rightTime - time) / h;
    const b = (time - leftTime) / h;
    const value = a * logs[index] + b * logs[index + 1]
      + ((a ** 3 - a) * second[index] + (b ** 3 - b) * second[index + 1]) * h ** 2 / 6;
    const first = (logs[index + 1] - logs[index]) / h
      + h * ((1 - 3 * a ** 2) * second[index] + (3 * b ** 2 - 1) * second[index + 1]) / 6;
    const curvature = a * second[index] + b * second[index + 1];
    return [value, first, curvature];
  };
  return {
    id,
    pillars: pillars.map((point) => ({ ...point })),
    discount: (time) => Math.exp(evaluateLog(time)[0]),
    instantaneousForward: (time) => -evaluateLog(time)[1],
    forwardDerivative: (time) => -evaluateLog(time)[2],
  };
}

export function demoHullWhiteCurve(shortRate = 0.03, id = HULL_WHITE_DEMO_CURVE_ID): DiscountCurve {
  const unshifted = createDiscountCurve(id, DEMO_ZERO_RATES.map(([time, zeroRate]) => ({
    time,
    discount: time === 0 ? 1 : Math.exp(-zeroRate * time),
  })));
  const shift = shortRate - unshifted.instantaneousForward(0);
  return createDiscountCurve(id, DEMO_ZERO_RATES.map(([time, zeroRate]) => ({
    time,
    discount: time === 0 ? 1 : Math.exp(-(zeroRate + shift) * time),
  })));
}

export function resolveHullWhiteCurve(request: ShortRateSolveRequest): DiscountCurve {
  if (request.discountCurve) return createDiscountCurve(request.discountCurve.id, request.discountCurve.pillars);
  const id = request.curveId ?? HULL_WHITE_DEMO_CURVE_ID;
  if (id !== HULL_WHITE_DEMO_CURVE_ID) throw new Error(`Unknown discount-curve snapshot: ${id}.`);
  return demoHullWhiteCurve(request.shortRate, id);
}

function bFactor(meanReversion: number, elapsed: number): number {
  return -Math.expm1(-meanReversion * elapsed) / meanReversion;
}

export interface VasicekParameters {
  shortRate: number;
  meanReversion: number;
  longRunRate: number;
  rateVolatility: number;
}

export function vasicekBondPrice(parameters: VasicekParameters, maturity: number, time = 0, shortRate = parameters.shortRate): number {
  if (maturity <= time) return 1;
  const elapsed = maturity - time;
  const b = bFactor(parameters.meanReversion, elapsed);
  const varianceAdjustment = parameters.rateVolatility ** 2 / (2 * parameters.meanReversion ** 2);
  const logA = (parameters.longRunRate - varianceAdjustment) * (b - elapsed)
    - parameters.rateVolatility ** 2 * b ** 2 / (4 * parameters.meanReversion);
  return Math.exp(logA - b * shortRate);
}

export function vasicekBondOptionPrice(
  parameters: VasicekParameters,
  optionMaturity: number,
  bondMaturity: number,
  strike: number,
  time = 0,
  shortRate = parameters.shortRate,
): number {
  const bond = vasicekBondPrice(parameters, bondMaturity, time, shortRate);
  const discount = vasicekBondPrice(parameters, optionMaturity, time, shortRate);
  if (optionMaturity <= time) return Math.max(bond - strike, 0);
  const variance = parameters.rateVolatility * bFactor(parameters.meanReversion, bondMaturity - optionMaturity)
    * Math.sqrt(-Math.expm1(-2 * parameters.meanReversion * (optionMaturity - time)) / (2 * parameters.meanReversion));
  if (variance < 1e-14) return Math.max(bond - strike * discount, 0);
  const h = Math.log(bond / (strike * discount)) / variance + variance / 2;
  return bond * normalCdf(h) - strike * discount * normalCdf(h - variance);
}

export interface HullWhiteParameters {
  shortRate: number;
  meanReversion: number;
  rateVolatility: number;
  curve: DiscountCurve;
}

export function hullWhiteTheta(parameters: HullWhiteParameters, time: number): number {
  const { meanReversion: a, rateVolatility: sigma, curve } = parameters;
  return curve.forwardDerivative(time) + a * curve.instantaneousForward(time)
    + sigma ** 2 * -Math.expm1(-2 * a * time) / (2 * a);
}

export function hullWhiteBondPrice(parameters: HullWhiteParameters, maturity: number, time = 0, shortRate = parameters.shortRate): number {
  if (maturity <= time) return 1;
  const { meanReversion: a, rateVolatility: sigma, curve } = parameters;
  const b = bFactor(a, maturity - time);
  const logA = Math.log(curve.discount(maturity) / curve.discount(time))
    + b * curve.instantaneousForward(time)
    - sigma ** 2 * -Math.expm1(-2 * a * time) * b ** 2 / (4 * a);
  return Math.exp(logA - b * shortRate);
}

export function hullWhiteBondOptionPrice(
  parameters: HullWhiteParameters,
  optionMaturity: number,
  bondMaturity: number,
  strike: number,
  time = 0,
  shortRate = parameters.shortRate,
): number {
  const bond = hullWhiteBondPrice(parameters, bondMaturity, time, shortRate);
  const discount = hullWhiteBondPrice(parameters, optionMaturity, time, shortRate);
  if (optionMaturity <= time) return Math.max(bond - strike, 0);
  const variance = parameters.rateVolatility * bFactor(parameters.meanReversion, bondMaturity - optionMaturity)
    * Math.sqrt(-Math.expm1(-2 * parameters.meanReversion * (optionMaturity - time)) / (2 * parameters.meanReversion));
  if (variance < 1e-14) return Math.max(bond - strike * discount, 0);
  const h = Math.log(bond / (strike * discount)) / variance + variance / 2;
  return bond * normalCdf(h) - strike * discount * normalCdf(h - variance);
}

function validateRequest(request: ShortRateSolveRequest): void {
  const finite = [request.shortRate, request.meanReversion, request.rateVolatility, request.maturity, request.spaceSteps, request.timeSteps];
  if (!finite.every(Number.isFinite)) throw new Error("Short-rate and grid parameters must be finite.");
  if (request.meanReversion <= 0 || request.rateVolatility <= 0 || request.maturity <= 0) throw new Error("Mean reversion, rate volatility and maturity must be positive.");
  if (!Number.isInteger(request.spaceSteps) || request.spaceSteps < 10) throw new Error("Rate-space steps must be an integer of at least 10.");
  if (!Number.isInteger(request.timeSteps) || request.timeSteps < 1) throw new Error("Time steps must be a positive integer.");
  if (request.model === "Vasicek" && !Number.isFinite(request.longRunRate)) throw new Error("Vasicek requires a finite long-run rate.");
  if (request.contract === "bond-option") {
    if (!Number.isFinite(request.bondMaturity) || request.bondMaturity! <= request.maturity) throw new Error("The underlying bond maturity must be after option expiry.");
    if (!Number.isFinite(request.strike) || request.strike! <= 0) throw new Error("A bond option requires a positive strike.");
  }
}

function modelData(request: ShortRateSolveRequest) {
  if (request.model === "Vasicek") {
    const parameters: VasicekParameters = {
      shortRate: request.shortRate,
      meanReversion: request.meanReversion,
      longRunRate: request.longRunRate!,
      rateVolatility: request.rateVolatility,
    };
    return {
      drift: (rate: number) => request.meanReversion * (request.longRunRate! - rate),
      bond: (maturity: number, time: number, rate: number) => vasicekBondPrice(parameters, maturity, time, rate),
      option: (time: number, rate: number) => vasicekBondOptionPrice(parameters, request.maturity, request.bondMaturity!, request.strike!, time, rate),
      curve: undefined,
    };
  }
  const curve = resolveHullWhiteCurve(request);
  const parameters: HullWhiteParameters = {
    shortRate: request.shortRate,
    meanReversion: request.meanReversion,
    rateVolatility: request.rateVolatility,
    curve,
  };
  return {
    drift: (rate: number, time: number) => hullWhiteTheta(parameters, time) - request.meanReversion * rate,
    bond: (maturity: number, time: number, rate: number) => hullWhiteBondPrice(parameters, maturity, time, rate),
    option: (time: number, rate: number) => hullWhiteBondOptionPrice(parameters, request.maturity, request.bondMaturity!, request.strike!, time, rate),
    curve,
  };
}

export function recommendedShortRateDomain(request: ShortRateSolveRequest): [number, number] {
  validateRequest(request);
  const standardDeviation = request.rateVolatility
    * Math.sqrt(-Math.expm1(-2 * request.meanReversion * request.maturity) / (2 * request.meanReversion));
  const means: number[] = [];
  if (request.model === "Vasicek") {
    for (let index = 0; index <= 40; index += 1) {
      const time = request.maturity * index / 40;
      means.push(request.longRunRate! + (request.shortRate - request.longRunRate!) * Math.exp(-request.meanReversion * time));
    }
  } else {
    const curve = resolveHullWhiteCurve(request);
    const phi = (time: number) => curve.instantaneousForward(time)
      + request.rateVolatility ** 2 * (1 - Math.exp(-request.meanReversion * time)) ** 2 / (2 * request.meanReversion ** 2);
    const displacement = request.shortRate - phi(0);
    for (let index = 0; index <= 40; index += 1) {
      const time = request.maturity * index / 40;
      means.push(displacement * Math.exp(-request.meanReversion * time) + phi(time));
    }
  }
  const padding = Math.max(6 * standardDeviation, 0.025);
  const rawMinimum = Math.min(...means) - padding;
  const rawMaximum = Math.max(...means) + padding;
  const halfWidth = Math.max(request.shortRate - rawMinimum, rawMaximum - request.shortRate);
  return [request.shortRate - halfWidth, request.shortRate + halfWidth];
}

function solveCore(request: ShortRateSolveRequest): Omit<ShortRateResult, "sensitivities"> {
  validateRequest(request);
  const data = modelData(request);
  const recommended = recommendedShortRateDomain(request);
  const minimum = request.rateMin ?? recommended[0];
  const maximum = request.rateMax ?? recommended[1];
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= request.shortRate || maximum <= request.shortRate) {
    throw new Error("The rate domain must be finite and bracket the current short rate.");
  }
  const gridKind = request.gridKind ?? "nonuniform";
  const nodes = gridKind === "uniform"
    ? uniformGrid(minimum, maximum, request.spaceSteps)
    : nonuniformGrid(minimum, maximum, request.spaceSteps, {
        focus: request.shortRate,
        scale: Math.max((maximum - minimum) / 14, 0.005),
      });
  const calendarTime = (tau: number) => Math.max(0, request.maturity - tau);
  const exactValue = (time: number, rate: number) => request.contract === "zero-coupon-bond"
    ? data.bond(request.maturity, time, rate)
    : data.option(time, rate);
  const solution = solve1D({
    nodes,
    maturity: request.maturity,
    timeSteps: request.timeSteps,
    coefficients: {
      diffusion: () => 0.5 * request.rateVolatility ** 2,
      drift: (rate, tau) => data.drift(rate, calendarTime(tau)),
      discount: (rate) => rate,
    },
    initialCondition: (rate) => exactValue(request.maturity, rate),
    boundaries: {
      left: (tau) => exactValue(calendarTime(tau), minimum),
      right: (tau) => exactValue(calendarTime(tau), maximum),
    },
    scheme: request.scheme ?? "rannacher-cn",
    rannacherHalfSteps: request.rannacherHalfSteps,
    captureEvery: request.captureEvery ?? Math.max(1, Math.floor(request.timeSteps / 24)),
  });
  const interpolation = interpolateLinear(nodes, solution.values, request.shortRate);
  const analyticValues = nodes.map((rate) => exactValue(0, rate));
  const benchmarkPrice = exactValue(0, request.shortRate);
  const errors = solution.values.map((value, index) => Math.abs(value - analyticValues[index]));
  const absoluteError = Math.abs(interpolation.value - benchmarkPrice);
  let curveFit: CurveFitDiagnostics | undefined;
  if (request.model === "Hull–White") {
    const curve = data.curve!;
    const fitted = curve.pillars.map((point) => hullWhiteBondPrice({
      shortRate: request.shortRate,
      meanReversion: request.meanReversion,
      rateVolatility: request.rateVolatility,
      curve,
    }, point.time));
    const relativeErrors = fitted.map((value, index) => Math.abs(value / curve.pillars[index].discount - 1));
    const thetaSamples = Array.from({ length: 101 }, (_, index) => hullWhiteTheta({
      shortRate: request.shortRate,
      meanReversion: request.meanReversion,
      rateVolatility: request.rateVolatility,
      curve,
    }, request.maturity * index / 100));
    curveFit = {
      curveId: curve.id,
      pillarCount: curve.pillars.length,
      maximumRelativeError: Math.max(...relativeErrors),
      maximumBasisPointError: Math.max(...relativeErrors) * 10_000,
      thetaMinimum: Math.min(...thetaSamples),
      thetaMaximum: Math.max(...thetaSamples),
    };
  }
  return {
    model: request.model,
    contract: request.contract,
    parameters: {
      shortRate: request.shortRate,
      meanReversion: request.meanReversion,
      longRunRate: request.longRunRate,
      rateVolatility: request.rateVolatility,
      maturity: request.maturity,
      bondMaturity: request.bondMaturity,
      strike: request.strike,
      curveId: data.curve?.id,
    },
    price: interpolation.value,
    benchmarkPrice,
    analyticPrice: benchmarkPrice,
    benchmarkLabel: request.model === "Vasicek"
      ? `Analytic Vasicek ${request.contract === "zero-coupon-bond" ? "affine bond" : "bond-option"}`
      : `Analytic Hull–White ${request.contract === "zero-coupon-bond" ? "curve-fitted bond" : "bond-option"}`,
    absoluteError,
    relativeError: absoluteError / Math.max(Math.abs(benchmarkPrice), 1e-14),
    maxNormError: Math.max(...errors),
    l2Error: Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length),
    interpolation,
    solution,
    analyticValues,
    gridKind,
    curveFit,
  };
}

export function solveShortRateProduct(request: ShortRateSolveRequest): ShortRateResult {
  const core = solveCore(request);
  const { nodes, values } = core.solution;
  const { interpolation } = core;
  let center = interpolation.exactNode ? interpolation.lowerIndex : Math.abs(nodes[interpolation.lowerIndex] - request.shortRate) < Math.abs(nodes[interpolation.upperIndex] - request.shortRate)
    ? interpolation.lowerIndex : interpolation.upperIndex;
  center = Math.max(1, Math.min(nodes.length - 2, center));
  const weights = derivativeWeights(nodes[center] - nodes[center - 1], nodes[center + 1] - nodes[center]);
  const local = [values[center - 1], values[center], values[center + 1]];
  const rateDelta = weights.first.reduce((sum, weight, index) => sum + weight * local[index], 0);
  const rateGamma = weights.second.reduce((sum, weight, index) => sum + weight * local[index], 0);
  const bump = Math.max(1e-5, request.rateVolatility * 0.01);
  const lean = { ...request, captureEvery: request.timeSteps };
  const up = solveCore({ ...lean, rateVolatility: request.rateVolatility + bump }).price;
  const down = solveCore({ ...lean, rateVolatility: Math.max(1e-8, request.rateVolatility - bump) }).price;
  return { ...core, sensitivities: { rateDelta, rateGamma, volatilitySensitivity: (up - down) / (2 * bump) } };
}

export function runShortRateConvergence(
  request: Omit<ShortRateSolveRequest, "spaceSteps" | "timeSteps">,
  spaceLevels: readonly number[] = [50, 100, 200],
): ShortRateConvergenceLevel[] {
  let previousError: number | null = null;
  return spaceLevels.map((spaceSteps) => {
    const result = solveCore({ ...request, spaceSteps, timeSteps: spaceSteps, gridKind: "uniform", captureEvery: spaceSteps });
    const level = {
      spaceSteps,
      timeSteps: spaceSteps,
      price: result.price,
      analyticPrice: result.analyticPrice,
      absoluteError: result.absoluteError,
      observedOrder: previousError === null || result.absoluteError <= 1e-14 ? null : observedOrder(previousError, result.absoluteError),
    };
    previousError = result.absoluteError;
    return level;
  });
}

export function shortRateDomainExpansionDelta(request: ShortRateSolveRequest, expansion = 1.25): number {
  if (!Number.isFinite(expansion) || expansion <= 1) throw new Error("Domain expansion must be greater than one.");
  const domain = recommendedShortRateDomain(request);
  const center = (domain[0] + domain[1]) / 2;
  const halfWidth = (domain[1] - domain[0]) / 2;
  const base = solveCore({ ...request, rateMin: domain[0], rateMax: domain[1], captureEvery: request.timeSteps });
  const expanded = solveCore({
    ...request,
    rateMin: center - expansion * halfWidth,
    rateMax: center + expansion * halfWidth,
    spaceSteps: Math.ceil(request.spaceSteps * expansion),
    captureEvery: request.timeSteps,
  });
  return Math.abs(base.price - expanded.price);
}
