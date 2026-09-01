import { gridSpacings, uniformGrid, validateGrid } from "./grids.ts";
import { derivativeWeights } from "./operator.ts";
import { solveTridiagonal, tridiagonalResidualNorm } from "./tridiagonal.ts";
import type { EuropeanSide, GridKind } from "./black-scholes.ts";

export type HestonScheme = "mcs-adi" | "hv-adi";

export interface HestonParameters {
  spot: number;
  strike: number;
  maturity: number;
  rate: number;
  dividend: number;
  v0: number;
  kappa: number;
  theta: number;
  xi: number;
  rho: number;
  side: EuropeanSide;
}

export interface HestonSolveRequest extends HestonParameters {
  spaceSteps: number;
  varianceSteps: number;
  timeSteps: number;
  scheme?: HestonScheme;
  gridKind?: GridKind;
  sMax?: number;
  vMax?: number;
  captureEvery?: number;
  quadratureOrder?: number;
  quadratureLimit?: number;
}

export interface HestonTimeLayer {
  tau: number;
  values: number[][];
}

export interface HestonDiagnostics {
  runtimeMs: number;
  spaceIntervals: number;
  varianceIntervals: number;
  timeSteps: number;
  minSpaceStep: number;
  maxSpaceStep: number;
  minVarianceStep: number;
  maxVarianceStep: number;
  timeStep: number;
  domain: [number, number];
  varianceDomain: [number, number];
  finite: boolean;
  minimumValue: number;
  maximumValue: number;
  maxLinearResidual: number;
  operatorOffDiagonalsNonnegative: boolean;
  minimumImplicitDiagonalMargin: number;
  explicitMonotonicityWarning: null;
  rannacherHalfSteps: 0;
  crossDerivativeStencil: "nine-point nonuniform";
  adiTheta: number;
  fellerRatio: number;
  fellerSatisfied: boolean;
  degenerateBoundaryApplied: boolean;
  maximumFarVarianceGradient: number;
  minimumDirectionalOffDiagonal: number;
}

export interface HestonSolution {
  spotNodes: number[];
  varianceNodes: number[];
  values: number[][];
  layers: HestonTimeLayer[];
  scheme: HestonScheme;
  diagnostics: HestonDiagnostics;
}

export interface BilinearInterpolationResult {
  value: number;
  spotLowerIndex: number;
  spotUpperIndex: number;
  varianceLowerIndex: number;
  varianceUpperIndex: number;
  spotLowerWeight: number;
  spotUpperWeight: number;
  varianceLowerWeight: number;
  varianceUpperWeight: number;
  exactNode: boolean;
}

export interface HestonSensitivities {
  delta: number;
  gamma: number;
  varianceDelta: number;
}

export interface HestonResult {
  parameters: HestonParameters;
  price: number;
  benchmarkPrice: number;
  analyticPrice: number;
  benchmarkLabel: string;
  absoluteError: number;
  relativeError: number;
  maxNormError: number;
  l2Error: number;
  interpolation: BilinearInterpolationResult;
  solution: HestonSolution;
  analyticValues: number[];
  spotSliceValues: number[];
  varianceSliceValues: number[];
  gridKind: GridKind;
  sensitivities: HestonSensitivities;
}

export interface HestonConvergenceLevel {
  spaceSteps: number;
  varianceSteps: number;
  timeSteps: number;
  price: number;
  analyticPrice: number;
  absoluteError: number;
  observedOrder: number | null;
}

interface Complex {
  re: number;
  im: number;
}

interface DirectionCoefficients {
  lower: number;
  diagonal: number;
  upper: number;
}

interface DegenerateVarianceCoefficients extends DirectionCoefficients {
  upperSecond: number;
}

const complex = (re: number, im = 0): Complex => ({ re, im });
const cAdd = (left: Complex, right: Complex): Complex => complex(left.re + right.re, left.im + right.im);
const cSub = (left: Complex, right: Complex): Complex => complex(left.re - right.re, left.im - right.im);
const cMul = (left: Complex, right: Complex): Complex => complex(left.re * right.re - left.im * right.im, left.re * right.im + left.im * right.re);
const cScale = (value: Complex, factor: number): Complex => complex(value.re * factor, value.im * factor);
const cDiv = (left: Complex, right: Complex): Complex => {
  const denominator = right.re * right.re + right.im * right.im;
  return complex((left.re * right.re + left.im * right.im) / denominator, (left.im * right.re - left.re * right.im) / denominator);
};
const cExp = (value: Complex): Complex => {
  const scale = Math.exp(value.re);
  return complex(scale * Math.cos(value.im), scale * Math.sin(value.im));
};
const cLog = (value: Complex): Complex => complex(Math.log(Math.hypot(value.re, value.im)), Math.atan2(value.im, value.re));
const cSqrt = (value: Complex): Complex => {
  const modulus = Math.hypot(value.re, value.im);
  const root = complex(Math.sqrt(Math.max(0, (modulus + value.re) / 2)), Math.sign(value.im || 1) * Math.sqrt(Math.max(0, (modulus - value.re) / 2)));
  return root.re < 0 ? cScale(root, -1) : root;
};

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function validateHestonRequest(request: HestonSolveRequest): void {
  const positive: [number, string][] = [
    [request.spot, "Spot"], [request.strike, "Strike"], [request.maturity, "Maturity"],
    [request.kappa, "Mean reversion"], [request.theta, "Long-run variance"], [request.xi, "Vol of variance"],
  ];
  positive.forEach(([value, label]) => {
    assertFinite(value, label);
    if (value <= 0) throw new Error(`${label} must be positive.`);
  });
  [request.rate, request.dividend, request.v0, request.rho].forEach((value, index) => assertFinite(value, ["Rate", "Dividend yield", "Initial variance", "Correlation"][index]));
  if (request.v0 < 0) throw new Error("Initial variance must be nonnegative.");
  if (request.rho < -1 || request.rho > 1) throw new Error("Correlation must lie in [-1, 1].");
  [[request.spaceSteps, 8, "Spot steps"], [request.varianceSteps, 4, "Variance steps"], [request.timeSteps, 1, "Time steps"]].forEach(([value, minimum, label]) => {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer of at least ${minimum}.`);
  });
  if (request.captureEvery !== undefined && (!Number.isInteger(request.captureEvery) || request.captureEvery < 1)) throw new Error("captureEvery must be a positive integer.");
}

export function recommendedHestonDomains(parameters: HestonParameters): { sMax: number; vMax: number } {
  const equityScale = Math.max(parameters.spot, parameters.strike);
  const totalVolatility = Math.sqrt(Math.max(parameters.v0, parameters.theta)) * Math.sqrt(parameters.maturity);
  const sMax = Math.max(4 * equityScale, parameters.strike + 8 * parameters.spot * totalVolatility);
  const decay = Math.exp(-parameters.kappa * parameters.maturity);
  const varianceMean = parameters.theta + (parameters.v0 - parameters.theta) * decay;
  const varianceVariance = parameters.v0 * parameters.xi ** 2 * decay * (1 - decay) / parameters.kappa
    + parameters.theta * parameters.xi ** 2 * (1 - decay) ** 2 / (2 * parameters.kappa);
  const vMax = Math.max(0.5, 4 * parameters.v0, 4 * parameters.theta, varianceMean + 6 * Math.sqrt(Math.max(0, varianceVariance)));
  return { sMax, vMax };
}

export function buildHestonGrid(request: HestonSolveRequest): { spotNodes: number[]; varianceNodes: number[]; sMax: number; vMax: number } {
  const recommended = recommendedHestonDomains(request);
  const sMax = request.sMax ?? recommended.sMax;
  const vMax = request.vMax ?? recommended.vMax;
  if (!Number.isFinite(sMax) || sMax <= Math.max(request.spot, request.strike)) throw new Error("Smax must be finite and above spot and strike.");
  if (!Number.isFinite(vMax) || vMax <= request.v0) throw new Error("vmax must be finite and above v0.");
  const gridKind = request.gridKind ?? "nonuniform";
  const focusedGrid = (minimum: number, maximum: number, intervals: number, focus: number, scale: number) => {
    const leftExtent = Math.asinh((focus - minimum) / scale);
    const rightExtent = Math.asinh((maximum - focus) / scale);
    const leftIntervals = Math.max(2, Math.min(intervals - 2, Math.round(intervals * leftExtent / (leftExtent + rightExtent))));
    const rightIntervals = intervals - leftIntervals;
    const left = Array.from({ length: leftIntervals + 1 }, (_, index) => focus - scale * Math.sinh(leftExtent * (1 - index / leftIntervals)));
    const right = Array.from({ length: rightIntervals + 1 }, (_, index) => focus + scale * Math.sinh(rightExtent * index / rightIntervals));
    const nodes = [...left.slice(0, -1), ...right];
    nodes[0] = minimum;
    nodes[nodes.length - 1] = maximum;
    validateGrid(nodes);
    return nodes;
  };
  const spotNodes = gridKind === "uniform"
    ? uniformGrid(0, sMax, request.spaceSteps)
    : focusedGrid(0, sMax, request.spaceSteps, request.strike, Math.max(request.strike, request.spot) / 15);
  const varianceFocus = Math.min(vMax * 0.9, Math.max(vMax * 0.02, request.v0 > 0 ? request.v0 : request.theta));
  const varianceNodes = gridKind === "uniform"
    ? uniformGrid(0, vMax, request.varianceSteps)
    : focusedGrid(0, vMax, request.varianceSteps, varianceFocus, Math.max(vMax / 12, request.theta / 2));
  return { spotNodes, varianceNodes, sMax, vMax };
}

function gaussLegendre(order: number): { nodes: number[]; weights: number[] } {
  if (!Number.isInteger(order) || order < 16 || order > 256) throw new Error("Quadrature order must be an integer from 16 to 256.");
  const nodes = new Array<number>(order);
  const weights = new Array<number>(order);
  const half = Math.ceil(order / 2);
  for (let index = 0; index < half; index += 1) {
    let root = Math.cos(Math.PI * (index + 0.75) / (order + 0.5));
    let derivative = 0;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      let previous = 1;
      let current = root;
      for (let degree = 2; degree <= order; degree += 1) {
        const next = ((2 * degree - 1) * root * current - (degree - 1) * previous) / degree;
        previous = current;
        current = next;
      }
      derivative = order * (root * current - previous) / (root * root - 1);
      const nextRoot = root - current / derivative;
      if (Math.abs(nextRoot - root) < 1e-15) {
        root = nextRoot;
        break;
      }
      root = nextRoot;
    }
    const weight = 2 / ((1 - root * root) * derivative * derivative);
    nodes[index] = -root;
    nodes[order - 1 - index] = root;
    weights[index] = weight;
    weights[order - 1 - index] = weight;
  }
  return { nodes, weights };
}

/** Risk-neutral characteristic function of log spot using the Little Heston Trap form. */
export function hestonCharacteristic(parameters: HestonParameters, argument: Complex): Complex {
  const { spot, maturity, rate, dividend, v0, kappa, theta, xi, rho } = parameters;
  const iU = complex(-argument.im, argument.re);
  const beta = cSub(complex(kappa), cScale(iU, rho * xi));
  const uSquaredPlusIU = cAdd(cMul(argument, argument), iU);
  const d = cSqrt(cAdd(cMul(beta, beta), cScale(uSquaredPlusIU, xi * xi)));
  const g = cDiv(cSub(beta, d), cAdd(beta, d));
  const expMinusDT = cExp(cScale(d, -maturity));
  const one = complex(1);
  const logRatio = cLog(cDiv(cSub(one, cMul(g, expMinusDT)), cSub(one, g)));
  const common = cSub(beta, d);
  const cTerm = cScale(cSub(cScale(common, maturity), cScale(logRatio, 2)), kappa * theta / (xi * xi));
  const dTerm = cScale(cDiv(cMul(common, cSub(one, expMinusDT)), cSub(one, cMul(g, expMinusDT))), v0 / (xi * xi));
  const drift = cScale(iU, Math.log(spot) + (rate - dividend) * maturity);
  return cExp(cAdd(drift, cAdd(cTerm, dTerm)));
}

export function hestonSemiAnalyticPrice(parameters: HestonParameters, quadratureOrder = 96, quadratureLimit = 120): number {
  if (parameters.maturity <= 0) return parameters.side === "Call" ? Math.max(parameters.spot - parameters.strike, 0) : Math.max(parameters.strike - parameters.spot, 0);
  if (parameters.spot <= 0) return parameters.side === "Call" ? 0 : parameters.strike * Math.exp(-parameters.rate * parameters.maturity);
  if (!Number.isFinite(quadratureLimit) || quadratureLimit <= 0) throw new Error("Quadrature limit must be positive.");
  const quadrature = gaussLegendre(quadratureOrder);
  const logStrike = Math.log(parameters.strike);
  const forwardMoment = parameters.spot * Math.exp((parameters.rate - parameters.dividend) * parameters.maturity);
  const probability = (kind: 1 | 2) => {
    let integral = 0;
    for (let index = 0; index < quadrature.nodes.length; index += 1) {
      const frequency = quadratureLimit * (quadrature.nodes[index] + 1) / 2;
      const argument = kind === 1 ? complex(frequency, -1) : complex(frequency, 0);
      const characteristic = hestonCharacteristic(parameters, argument);
      const normalized = kind === 1 ? cScale(characteristic, 1 / forwardMoment) : characteristic;
      const strikePhase = complex(Math.cos(-frequency * logStrike), Math.sin(-frequency * logStrike));
      const numerator = cMul(strikePhase, normalized);
      const realIntegrand = numerator.im / frequency;
      integral += quadrature.weights[index] * realIntegrand * quadratureLimit / 2;
    }
    return Math.min(1, Math.max(0, 0.5 + integral / Math.PI));
  };
  const call = parameters.spot * Math.exp(-parameters.dividend * parameters.maturity) * probability(1)
    - parameters.strike * Math.exp(-parameters.rate * parameters.maturity) * probability(2);
  const boundedCall = Math.max(0, call);
  if (parameters.side === "Call") return boundedCall;
  return Math.max(0, boundedCall - parameters.spot * Math.exp(-parameters.dividend * parameters.maturity) + parameters.strike * Math.exp(-parameters.rate * parameters.maturity));
}

function directionalCoefficients(nodes: readonly number[], index: number, diffusion: number, drift: number, discount: number): DirectionCoefficients {
  const leftSpacing = nodes[index] - nodes[index - 1];
  const rightSpacing = nodes[index + 1] - nodes[index];
  const weights = derivativeWeights(leftSpacing, rightSpacing);
  return {
    lower: diffusion * weights.second[0] + drift * weights.first[0],
    diagonal: diffusion * weights.second[1] + drift * weights.first[1] - discount,
    upper: diffusion * weights.second[2] + drift * weights.first[2],
  };
}

function upwindCoefficients(nodes: readonly number[], index: number, drift: number, discount: number): DirectionCoefficients {
  const leftSpacing = nodes[index] - nodes[index - 1];
  const rightSpacing = nodes[index + 1] - nodes[index];
  return drift >= 0
    ? { lower: 0, diagonal: -drift / rightSpacing - discount, upper: drift / rightSpacing }
    : { lower: -drift / leftSpacing, diagonal: drift / leftSpacing - discount, upper: 0 };
}

function bracket(nodes: readonly number[], query: number): { lower: number; upper: number; lowerWeight: number; upperWeight: number } {
  if (query < nodes[0] || query > nodes[nodes.length - 1]) throw new Error("Interpolation query lies outside the grid.");
  let low = 0;
  let high = nodes.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (nodes[middle] === query) return { lower: middle, upper: middle, lowerWeight: 1, upperWeight: 0 };
    if (nodes[middle] < query) low = middle + 1;
    else high = middle - 1;
  }
  const upperWeight = (query - nodes[high]) / (nodes[low] - nodes[high]);
  return { lower: high, upper: low, lowerWeight: 1 - upperWeight, upperWeight };
}

export function interpolateBilinear(
  spotNodes: readonly number[],
  varianceNodes: readonly number[],
  values: readonly (readonly number[])[],
  spot: number,
  variance: number,
): BilinearInterpolationResult {
  validateGrid(spotNodes);
  validateGrid(varianceNodes);
  if (values.length !== varianceNodes.length || values.some((row) => row.length !== spotNodes.length)) throw new Error("Heston value-grid dimensions are inconsistent.");
  const s = bracket(spotNodes, spot);
  const v = bracket(varianceNodes, variance);
  const lowerVarianceValue = s.lowerWeight * values[v.lower][s.lower] + s.upperWeight * values[v.lower][s.upper];
  const upperVarianceValue = s.lowerWeight * values[v.upper][s.lower] + s.upperWeight * values[v.upper][s.upper];
  return {
    value: v.lowerWeight * lowerVarianceValue + v.upperWeight * upperVarianceValue,
    spotLowerIndex: s.lower,
    spotUpperIndex: s.upper,
    varianceLowerIndex: v.lower,
    varianceUpperIndex: v.upper,
    spotLowerWeight: s.lowerWeight,
    spotUpperWeight: s.upperWeight,
    varianceLowerWeight: v.lowerWeight,
    varianceUpperWeight: v.upperWeight,
    exactNode: s.lower === s.upper && v.lower === v.upper,
  };
}

function solveCore(request: HestonSolveRequest): Omit<HestonResult, "sensitivities"> {
  const started = Date.now();
  validateHestonRequest(request);
  const scheme = request.scheme ?? "mcs-adi";
  const gridKind = request.gridKind ?? "nonuniform";
  const { spotNodes, varianceNodes, sMax, vMax } = buildHestonGrid(request);
  const spotCount = spotNodes.length;
  const varianceCount = varianceNodes.length;
  const timeStep = request.maturity / request.timeSteps;
  const captureEvery = request.captureEvery ?? Math.max(1, Math.floor(request.timeSteps / 8));
  const adiTheta = scheme === "mcs-adi" ? 1 / 3 : 0.5 + Math.sqrt(3) / 6;
  const flatIndex = (spotIndex: number, varianceIndex: number) => varianceIndex * spotCount + spotIndex;
  const cloneRows = (flat: readonly number[]) => Array.from({ length: varianceCount }, (_, varianceIndex) => flat.slice(varianceIndex * spotCount, (varianceIndex + 1) * spotCount));
  const boundaryValue = (side: "left" | "right", tau: number) => {
    if (side === "left") return request.side === "Call" ? 0 : request.strike * Math.exp(-request.rate * tau);
    return request.side === "Call" ? Math.max(0, sMax * Math.exp(-request.dividend * tau) - request.strike * Math.exp(-request.rate * tau)) : 0;
  };
  const enforceBoundaries = (values: number[], tau: number): void => {
    for (let varianceIndex = 0; varianceIndex < varianceCount; varianceIndex += 1) {
      values[flatIndex(0, varianceIndex)] = boundaryValue("left", tau);
      values[flatIndex(spotCount - 1, varianceIndex)] = boundaryValue("right", tau);
    }
    for (let spotIndex = 1; spotIndex < spotCount - 1; spotIndex += 1) {
      values[flatIndex(spotIndex, varianceCount - 1)] = values[flatIndex(spotIndex, varianceCount - 2)];
    }
  };
  const payoff = (spot: number) => request.side === "Call" ? Math.max(spot - request.strike, 0) : Math.max(request.strike - spot, 0);
  let values = new Array<number>(spotCount * varianceCount);
  for (let varianceIndex = 0; varianceIndex < varianceCount; varianceIndex += 1) {
    for (let spotIndex = 0; spotIndex < spotCount; spotIndex += 1) values[flatIndex(spotIndex, varianceIndex)] = payoff(spotNodes[spotIndex]);
  }
  enforceBoundaries(values, 0);
  const layers: HestonTimeLayer[] = [{ tau: 0, values: cloneRows(values) }];
  let maxLinearResidual = 0;
  let minimumDirectionalOffDiagonal = Number.POSITIVE_INFINITY;

  const spotCoefficients = (spotIndex: number, varianceIndex: number) => {
    const spot = spotNodes[spotIndex];
    const variance = varianceNodes[varianceIndex];
    const drift = (request.rate - request.dividend) * spot;
    const coefficients = varianceIndex === 0
      ? upwindCoefficients(spotNodes, spotIndex, drift, request.rate / 2)
      : directionalCoefficients(spotNodes, spotIndex, 0.5 * variance * spot * spot, drift, request.rate / 2);
    minimumDirectionalOffDiagonal = Math.min(minimumDirectionalOffDiagonal, coefficients.lower, coefficients.upper);
    return coefficients;
  };
  const varianceCoefficients = (varianceIndex: number): DirectionCoefficients => {
    const variance = varianceNodes[varianceIndex];
    const coefficients = directionalCoefficients(varianceNodes, varianceIndex, 0.5 * request.xi ** 2 * variance, request.kappa * (request.theta - variance), request.rate / 2);
    minimumDirectionalOffDiagonal = Math.min(minimumDirectionalOffDiagonal, coefficients.lower, coefficients.upper);
    return coefficients;
  };
  const degenerateVarianceCoefficients = (): DegenerateVarianceCoefficients => {
    const first = varianceNodes[1] - varianceNodes[0];
    const second = varianceNodes[2] - varianceNodes[1];
    const total = first + second;
    const drift = request.kappa * request.theta;
    const coefficients = {
      lower: 0,
      diagonal: drift * (-(2 * first + second) / (first * total)) - request.rate / 2,
      upper: drift * total / (first * second),
      upperSecond: -drift * first / (second * total),
    };
    minimumDirectionalOffDiagonal = Math.min(minimumDirectionalOffDiagonal, coefficients.upper, coefficients.upperSecond);
    return coefficients;
  };
  const applySpot = (source: readonly number[]) => {
    const output = new Array<number>(source.length).fill(0);
    for (let varianceIndex = 0; varianceIndex < varianceCount; varianceIndex += 1) {
      for (let spotIndex = 1; spotIndex < spotCount - 1; spotIndex += 1) {
        const coefficients = spotCoefficients(spotIndex, varianceIndex);
        output[flatIndex(spotIndex, varianceIndex)] = coefficients.lower * source[flatIndex(spotIndex - 1, varianceIndex)]
          + coefficients.diagonal * source[flatIndex(spotIndex, varianceIndex)]
          + coefficients.upper * source[flatIndex(spotIndex + 1, varianceIndex)];
      }
    }
    return output;
  };
  const applyVariance = (source: readonly number[]) => {
    const output = new Array<number>(source.length).fill(0);
    for (let spotIndex = 1; spotIndex < spotCount - 1; spotIndex += 1) {
      const bottom = degenerateVarianceCoefficients();
      output[flatIndex(spotIndex, 0)] = bottom.diagonal * source[flatIndex(spotIndex, 0)]
        + bottom.upper * source[flatIndex(spotIndex, 1)]
        + bottom.upperSecond * source[flatIndex(spotIndex, 2)];
      for (let varianceIndex = 1; varianceIndex < varianceCount - 1; varianceIndex += 1) {
        const coefficients = varianceCoefficients(varianceIndex);
        output[flatIndex(spotIndex, varianceIndex)] = coefficients.lower * source[flatIndex(spotIndex, varianceIndex - 1)]
          + coefficients.diagonal * source[flatIndex(spotIndex, varianceIndex)]
          + coefficients.upper * source[flatIndex(spotIndex, varianceIndex + 1)];
      }
    }
    return output;
  };
  const applyCross = (source: readonly number[]) => {
    const output = new Array<number>(source.length).fill(0);
    for (let varianceIndex = 1; varianceIndex < varianceCount - 1; varianceIndex += 1) {
      const varianceWeights = derivativeWeights(varianceNodes[varianceIndex] - varianceNodes[varianceIndex - 1], varianceNodes[varianceIndex + 1] - varianceNodes[varianceIndex]).first;
      for (let spotIndex = 1; spotIndex < spotCount - 1; spotIndex += 1) {
        const spotWeights = derivativeWeights(spotNodes[spotIndex] - spotNodes[spotIndex - 1], spotNodes[spotIndex + 1] - spotNodes[spotIndex]).first;
        let mixedDerivative = 0;
        for (let varianceOffset = -1; varianceOffset <= 1; varianceOffset += 1) {
          for (let spotOffset = -1; spotOffset <= 1; spotOffset += 1) {
            mixedDerivative += varianceWeights[varianceOffset + 1] * spotWeights[spotOffset + 1]
              * source[flatIndex(spotIndex + spotOffset, varianceIndex + varianceOffset)];
          }
        }
        output[flatIndex(spotIndex, varianceIndex)] = request.rho * request.xi * varianceNodes[varianceIndex] * spotNodes[spotIndex] * mixedDerivative;
      }
    }
    return output;
  };
  const add = (...terms: { values: readonly number[]; factor: number }[]) => {
    const output = new Array<number>(terms[0].values.length).fill(0);
    for (let index = 0; index < output.length; index += 1) {
      for (const term of terms) output[index] += term.factor * term.values[index];
    }
    return output;
  };
  const fullOperator = (source: readonly number[]) => {
    const spot = applySpot(source);
    const variance = applyVariance(source);
    const cross = applyCross(source);
    return add({ values: spot, factor: 1 }, { values: variance, factor: 1 }, { values: cross, factor: 1 });
  };
  const solveSpotDirection = (base: readonly number[], reference: readonly number[], tau: number) => {
    const referenceOperator = applySpot(reference);
    const result = [...base];
    for (let varianceIndex = 0; varianceIndex < varianceCount; varianceIndex += 1) {
      const lower = new Array<number>(spotCount - 1).fill(0);
      const diagonal = new Array<number>(spotCount).fill(1);
      const upper = new Array<number>(spotCount - 1).fill(0);
      const rhs = new Array<number>(spotCount);
      rhs[0] = boundaryValue("left", tau);
      rhs[spotCount - 1] = boundaryValue("right", tau);
      for (let spotIndex = 1; spotIndex < spotCount - 1; spotIndex += 1) {
        const coefficients = spotCoefficients(spotIndex, varianceIndex);
        lower[spotIndex - 1] = -adiTheta * timeStep * coefficients.lower;
        diagonal[spotIndex] = 1 - adiTheta * timeStep * coefficients.diagonal;
        upper[spotIndex] = -adiTheta * timeStep * coefficients.upper;
        rhs[spotIndex] = base[flatIndex(spotIndex, varianceIndex)] - adiTheta * timeStep * referenceOperator[flatIndex(spotIndex, varianceIndex)];
      }
      const solved = solveTridiagonal(lower, diagonal, upper, rhs);
      maxLinearResidual = Math.max(maxLinearResidual, tridiagonalResidualNorm(lower, diagonal, upper, solved, rhs));
      for (let spotIndex = 0; spotIndex < spotCount; spotIndex += 1) result[flatIndex(spotIndex, varianceIndex)] = solved[spotIndex];
    }
    enforceBoundaries(result, tau);
    return result;
  };
  const solveVarianceDirection = (base: readonly number[], reference: readonly number[], tau: number) => {
    const referenceOperator = applyVariance(reference);
    const result = [...base];
    for (let spotIndex = 0; spotIndex < spotCount; spotIndex += 1) {
      const lower = new Array<number>(varianceCount - 1).fill(0);
      const diagonal = new Array<number>(varianceCount).fill(1);
      const upper = new Array<number>(varianceCount - 1).fill(0);
      const rhs = new Array<number>(varianceCount).fill(0);
      if (spotIndex === 0 || spotIndex === spotCount - 1) {
        const boundary = boundaryValue(spotIndex === 0 ? "left" : "right", tau);
        rhs.fill(boundary);
      } else {
        for (let varianceIndex = 0; varianceIndex < varianceCount - 1; varianceIndex += 1) {
          const coefficients = varianceIndex === 0 ? degenerateVarianceCoefficients() : varianceCoefficients(varianceIndex);
          if (varianceIndex > 0) lower[varianceIndex - 1] = -adiTheta * timeStep * coefficients.lower;
          diagonal[varianceIndex] = 1 - adiTheta * timeStep * coefficients.diagonal;
          upper[varianceIndex] = -adiTheta * timeStep * coefficients.upper;
          rhs[varianceIndex] = base[flatIndex(spotIndex, varianceIndex)] - adiTheta * timeStep * referenceOperator[flatIndex(spotIndex, varianceIndex)];
        }
        lower[varianceCount - 2] = -1;
        diagonal[varianceCount - 1] = 1;
        rhs[varianceCount - 1] = 0;
        const bottom = degenerateVarianceCoefficients();
        const secondUpper = -adiTheta * timeStep * bottom.upperSecond;
        if (Math.abs(secondUpper) > 0) {
          const pivot = upper[1];
          if (Math.abs(pivot) < 1e-14) throw new Error("Degenerate v=0 elimination encountered a zero pivot.");
          const factor = secondUpper / pivot;
          diagonal[0] -= factor * lower[0];
          upper[0] -= factor * diagonal[1];
          rhs[0] -= factor * rhs[1];
        }
      }
      const solved = solveTridiagonal(lower, diagonal, upper, rhs);
      maxLinearResidual = Math.max(maxLinearResidual, tridiagonalResidualNorm(lower, diagonal, upper, solved, rhs));
      for (let varianceIndex = 0; varianceIndex < varianceCount; varianceIndex += 1) result[flatIndex(spotIndex, varianceIndex)] = solved[varianceIndex];
    }
    enforceBoundaries(result, tau);
    return result;
  };

  for (let timeIndex = 0; timeIndex < request.timeSteps; timeIndex += 1) {
    const tau = (timeIndex + 1) * timeStep;
    const previous = values;
    const previousFull = fullOperator(previous);
    const y0 = add({ values: previous, factor: 1 }, { values: previousFull, factor: timeStep });
    enforceBoundaries(y0, tau);
    const y1 = solveSpotDirection(y0, previous, tau);
    const y2 = solveVarianceDirection(y1, previous, tau);
    if (scheme === "mcs-adi") {
      const crossY2 = applyCross(y2);
      const crossPrevious = applyCross(previous);
      const correctedCross = add({ values: y0, factor: 1 }, { values: crossY2, factor: adiTheta * timeStep }, { values: crossPrevious, factor: -adiTheta * timeStep });
      const y2Full = fullOperator(y2);
      const corrected = add(
        { values: correctedCross, factor: 1 },
        { values: y2Full, factor: (0.5 - adiTheta) * timeStep },
        { values: previousFull, factor: -(0.5 - adiTheta) * timeStep },
      );
      enforceBoundaries(corrected, tau);
      const correctedSpot = solveSpotDirection(corrected, previous, tau);
      values = solveVarianceDirection(correctedSpot, previous, tau);
    } else {
      const y2Full = fullOperator(y2);
      const corrected = add({ values: y0, factor: 1 }, { values: y2Full, factor: 0.5 * timeStep }, { values: previousFull, factor: -0.5 * timeStep });
      enforceBoundaries(corrected, tau);
      const correctedSpot = solveSpotDirection(corrected, y2, tau);
      values = solveVarianceDirection(correctedSpot, y2, tau);
    }
    if ((timeIndex + 1) % captureEvery === 0 || timeIndex + 1 === request.timeSteps) layers.push({ tau, values: cloneRows(values) });
  }

  const valueRows = cloneRows(values);
  const interpolation = interpolateBilinear(spotNodes, varianceNodes, valueRows, request.spot, request.v0);
  const quadratureOrder = request.quadratureOrder ?? 96;
  const quadratureLimit = request.quadratureLimit ?? 120;
  const benchmarkPrice = hestonSemiAnalyticPrice(request, quadratureOrder, quadratureLimit);
  const varianceBracket = bracket(varianceNodes, request.v0);
  const spotSliceValues = spotNodes.map((_, spotIndex) => varianceBracket.lowerWeight * valueRows[varianceBracket.lower][spotIndex]
    + varianceBracket.upperWeight * valueRows[varianceBracket.upper][spotIndex]);
  const analyticValues = spotNodes.map((spot) => hestonSemiAnalyticPrice({ ...request, spot }, quadratureOrder, quadratureLimit));
  const spotBracket = bracket(spotNodes, request.spot);
  const varianceSliceValues = varianceNodes.map((_, varianceIndex) => spotBracket.lowerWeight * valueRows[varianceIndex][spotBracket.lower]
    + spotBracket.upperWeight * valueRows[varianceIndex][spotBracket.upper]);
  const comparisonErrors = spotSliceValues.slice(2, -2).map((value, index) => Math.abs(value - analyticValues[index + 2]));
  const maxNormError = comparisonErrors.length > 0 ? Math.max(...comparisonErrors) : Math.abs(interpolation.value - benchmarkPrice);
  const l2Error = comparisonErrors.length > 0 ? Math.sqrt(comparisonErrors.reduce((sum, error) => sum + error * error, 0) / comparisonErrors.length) : Math.abs(interpolation.value - benchmarkPrice);
  const flattened = valueRows.flat();
  let maximumFarVarianceGradient = 0;
  const farSpacing = varianceNodes.at(-1)! - varianceNodes.at(-2)!;
  for (let spotIndex = 1; spotIndex < spotCount - 1; spotIndex += 1) {
    maximumFarVarianceGradient = Math.max(maximumFarVarianceGradient, Math.abs((valueRows.at(-1)![spotIndex] - valueRows.at(-2)![spotIndex]) / farSpacing));
  }
  const spotSpacing = gridSpacings(spotNodes);
  const varianceSpacing = gridSpacings(varianceNodes);
  const finite = flattened.every(Number.isFinite);
  const fellerRatio = 2 * request.kappa * request.theta / (request.xi * request.xi);
  const solution: HestonSolution = {
    spotNodes,
    varianceNodes,
    values: valueRows,
    layers,
    scheme,
    diagnostics: {
      runtimeMs: Date.now() - started,
      spaceIntervals: request.spaceSteps,
      varianceIntervals: request.varianceSteps,
      timeSteps: request.timeSteps,
      minSpaceStep: spotSpacing.minimum,
      maxSpaceStep: spotSpacing.maximum,
      minVarianceStep: varianceSpacing.minimum,
      maxVarianceStep: varianceSpacing.maximum,
      timeStep,
      domain: [0, sMax],
      varianceDomain: [0, vMax],
      finite,
      minimumValue: finite ? Math.min(...flattened) : Number.NaN,
      maximumValue: finite ? Math.max(...flattened) : Number.NaN,
      maxLinearResidual,
      operatorOffDiagonalsNonnegative: minimumDirectionalOffDiagonal >= -1e-12,
      minimumImplicitDiagonalMargin: Number.NaN,
      explicitMonotonicityWarning: null,
      rannacherHalfSteps: 0,
      crossDerivativeStencil: "nine-point nonuniform",
      adiTheta,
      fellerRatio,
      fellerSatisfied: fellerRatio >= 1,
      degenerateBoundaryApplied: true,
      maximumFarVarianceGradient,
      minimumDirectionalOffDiagonal,
    },
  };
  return {
    parameters: {
      spot: request.spot, strike: request.strike, maturity: request.maturity, rate: request.rate, dividend: request.dividend,
      v0: request.v0, kappa: request.kappa, theta: request.theta, xi: request.xi, rho: request.rho, side: request.side,
    },
    price: interpolation.value,
    benchmarkPrice,
    analyticPrice: benchmarkPrice,
    benchmarkLabel: "Heston semi-analytic Fourier price (Gauss–Legendre quadrature)",
    absoluteError: Math.abs(interpolation.value - benchmarkPrice),
    relativeError: Math.abs(interpolation.value - benchmarkPrice) / Math.max(Math.abs(benchmarkPrice), 1e-14),
    maxNormError,
    l2Error,
    interpolation,
    solution,
    analyticValues,
    spotSliceValues,
    varianceSliceValues,
    gridKind,
  };
}

function localSensitivities(result: Omit<HestonResult, "sensitivities">): HestonSensitivities {
  const { spotNodes, varianceNodes, values } = result.solution;
  const interpolation = result.interpolation;
  let spotIndex = interpolation.spotLowerIndex === interpolation.spotUpperIndex
    ? interpolation.spotLowerIndex
    : Math.abs(spotNodes[interpolation.spotLowerIndex] - result.parameters.spot) < Math.abs(spotNodes[interpolation.spotUpperIndex] - result.parameters.spot)
      ? interpolation.spotLowerIndex : interpolation.spotUpperIndex;
  let varianceIndex = interpolation.varianceLowerIndex === interpolation.varianceUpperIndex
    ? interpolation.varianceLowerIndex
    : Math.abs(varianceNodes[interpolation.varianceLowerIndex] - result.parameters.v0) < Math.abs(varianceNodes[interpolation.varianceUpperIndex] - result.parameters.v0)
      ? interpolation.varianceLowerIndex : interpolation.varianceUpperIndex;
  spotIndex = Math.max(1, Math.min(spotNodes.length - 2, spotIndex));
  varianceIndex = Math.max(1, Math.min(varianceNodes.length - 2, varianceIndex));
  const spotWeights = derivativeWeights(spotNodes[spotIndex] - spotNodes[spotIndex - 1], spotNodes[spotIndex + 1] - spotNodes[spotIndex]);
  const varianceWeights = derivativeWeights(varianceNodes[varianceIndex] - varianceNodes[varianceIndex - 1], varianceNodes[varianceIndex + 1] - varianceNodes[varianceIndex]).first;
  const localSpot = [values[varianceIndex][spotIndex - 1], values[varianceIndex][spotIndex], values[varianceIndex][spotIndex + 1]];
  const localVariance = [values[varianceIndex - 1][spotIndex], values[varianceIndex][spotIndex], values[varianceIndex + 1][spotIndex]];
  return {
    delta: spotWeights.first.reduce((sum, weight, index) => sum + weight * localSpot[index], 0),
    gamma: spotWeights.second.reduce((sum, weight, index) => sum + weight * localSpot[index], 0),
    varianceDelta: varianceWeights.reduce((sum, weight, index) => sum + weight * localVariance[index], 0),
  };
}

export function solveHestonEuropean(request: HestonSolveRequest): HestonResult {
  const core = solveCore(request);
  return { ...core, sensitivities: localSensitivities(core) };
}

export function runHestonConvergence(
  request: Omit<HestonSolveRequest, "spaceSteps" | "varianceSteps" | "timeSteps">,
  spaceLevels: readonly number[] = [16, 32, 64],
): HestonConvergenceLevel[] {
  let previousError: number | null = null;
  let previousSteps: number | null = null;
  return spaceLevels.map((spaceSteps) => {
    const varianceSteps = Math.max(8, Math.round(spaceSteps / 2));
    const timeSteps = Math.max(16, 2 * spaceSteps);
    const result = solveCore({ ...request, spaceSteps, varianceSteps, timeSteps, gridKind: "uniform", captureEvery: timeSteps, quadratureOrder: 64 });
    const order = previousError === null || previousSteps === null || result.absoluteError <= 1e-14
      ? null
      : Math.log(previousError / result.absoluteError) / Math.log(spaceSteps / previousSteps);
    previousError = result.absoluteError;
    previousSteps = spaceSteps;
    return { spaceSteps, varianceSteps, timeSteps, price: result.price, analyticPrice: result.analyticPrice, absoluteError: result.absoluteError, observedOrder: order };
  });
}

export function hestonDomainExpansionDelta(request: HestonSolveRequest, expansion = 1.25): number {
  if (!Number.isFinite(expansion) || expansion <= 1) throw new Error("Domain expansion must be greater than one.");
  const domain = recommendedHestonDomains(request);
  const lean = { ...request, captureEvery: request.timeSteps, quadratureOrder: 64 };
  const base = solveCore({ ...lean, sMax: request.sMax ?? domain.sMax, vMax: request.vMax ?? domain.vMax });
  const expanded = solveCore({
    ...lean,
    sMax: (request.sMax ?? domain.sMax) * expansion,
    vMax: (request.vMax ?? domain.vMax) * expansion,
    spaceSteps: Math.ceil(request.spaceSteps * expansion),
    varianceSteps: Math.ceil(request.varianceSteps * expansion),
  });
  return Math.abs(base.price - expanded.price);
}

export function hestonRhoZeroConsistency(request: HestonSolveRequest): number {
  const base = solveCore({ ...request, rho: 0, scheme: "mcs-adi", captureEvery: request.timeSteps, quadratureOrder: 64 });
  const comparison = solveCore({ ...request, rho: 0, scheme: "hv-adi", captureEvery: request.timeSteps, quadratureOrder: 64 });
  return Math.abs(base.price - comparison.price);
}
