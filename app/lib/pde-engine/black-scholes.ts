import { matrixDiagnostics, observedOrder } from "./diagnostics.ts";
import { gridSpacings, nonuniformGrid, uniformGrid } from "./grids.ts";
import { interpolateLinear, type InterpolationResult } from "./interpolation.ts";
import { applyOperator, assembleOperator, boundaryVector, derivativeWeights, implicitMatrix, type TridiagonalOperator } from "./operator.ts";
import { solve1D } from "./solver.ts";
import type { Scheme, Solve1DResult, TimeLayer } from "./types.ts";

export type EuropeanSide = "Call" | "Put";
export type GridKind = "uniform" | "nonuniform";
export type BlackScholesContract = "european" | "digital" | "barrier" | "american-put";
export type BarrierDirection = "up-and-out" | "down-and-out";

export interface BlackScholesParameters {
  spot: number;
  strike: number;
  maturity: number;
  rate: number;
  dividend: number;
  volatility: number;
  side: EuropeanSide;
}

export interface BlackScholesSolveRequest extends BlackScholesParameters {
  spaceSteps: number;
  timeSteps: number;
  scheme?: Scheme;
  gridKind?: GridKind;
  sMax?: number;
  rannacherHalfSteps?: number;
  captureEvery?: number;
}

export interface BlackScholesProductSolveRequest extends BlackScholesSolveRequest {
  contract: BlackScholesContract;
  barrier?: number;
  barrierDirection?: BarrierDirection;
  psorOmega?: number;
  psorTolerance?: number;
  psorMaxIterations?: number;
}

export interface BlackScholesGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface ExerciseDiagnostics {
  method: "Projected SOR";
  omega: number;
  tolerance: number;
  totalIterations: number;
  maximumIterations: number;
  maxComplementarityResidual: number;
  activeNodes: number;
  exerciseBoundary: number | null;
}

export interface BlackScholesResult {
  parameters: BlackScholesParameters;
  contract: BlackScholesContract;
  barrierDirection?: BarrierDirection;
  barrier?: number;
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
  gridKind: GridKind;
  greeks: BlackScholesGreeks;
  exerciseDiagnostics?: ExerciseDiagnostics;
}

export interface ConvergenceLevel {
  spaceSteps: number;
  timeSteps: number;
  price: number;
  analyticPrice: number;
  absoluteError: number;
  observedOrder: number | null;
}

function normalCdf(value: number): number {
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = Math.exp(-0.5 * absolute * absolute) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const positive = 1 - tail;
  return value >= 0 ? positive : 1 - positive;
}

function d1d2(parameters: BlackScholesParameters, spot: number, maturity: number): [number, number] {
  const rootTime = Math.sqrt(maturity);
  const d1 = (Math.log(spot / parameters.strike)
    + (parameters.rate - parameters.dividend + 0.5 * parameters.volatility ** 2) * maturity)
    / (parameters.volatility * rootTime);
  return [d1, d1 - parameters.volatility * rootTime];
}

export function blackScholesPrice(parameters: BlackScholesParameters, spot = parameters.spot, maturity = parameters.maturity): number {
  const { strike, rate, dividend, side } = parameters;
  if (maturity <= 0) return side === "Call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  if (spot <= 0) return side === "Call" ? 0 : strike * Math.exp(-rate * maturity);
  const [d1, d2] = d1d2(parameters, spot, maturity);
  if (side === "Call") return spot * Math.exp(-dividend * maturity) * normalCdf(d1) - strike * Math.exp(-rate * maturity) * normalCdf(d2);
  return strike * Math.exp(-rate * maturity) * normalCdf(-d2) - spot * Math.exp(-dividend * maturity) * normalCdf(-d1);
}

export function blackScholesDigitalPrice(parameters: BlackScholesParameters, spot = parameters.spot, maturity = parameters.maturity): number {
  if (maturity <= 0) return parameters.side === "Call" ? Number(spot > parameters.strike) : Number(spot < parameters.strike);
  if (spot <= 0) return parameters.side === "Call" ? 0 : Math.exp(-parameters.rate * maturity);
  const [, d2] = d1d2(parameters, spot, maturity);
  return Math.exp(-parameters.rate * maturity) * normalCdf(parameters.side === "Call" ? d2 : -d2);
}

/** Reiner–Rubinstein continuously monitored, zero-rebate knock-out formula. */
export function blackScholesBarrierPrice(
  parameters: BlackScholesParameters,
  barrier: number,
  direction: BarrierDirection,
  spot = parameters.spot,
  maturity = parameters.maturity,
): number {
  if (!Number.isFinite(barrier) || barrier <= 0) throw new Error("Barrier must be finite and positive.");
  if ((direction === "up-and-out" && spot >= barrier) || (direction === "down-and-out" && spot <= barrier)) return 0;
  if (maturity <= 0) return parameters.side === "Call" ? Math.max(spot - parameters.strike, 0) : Math.max(parameters.strike - spot, 0);

  const { strike, rate, dividend, volatility, side } = parameters;
  const phi = side === "Call" ? 1 : -1;
  const eta = direction === "down-and-out" ? 1 : -1;
  const sigmaRoot = volatility * Math.sqrt(maturity);
  const carry = rate - dividend;
  const lambda = (carry + 0.5 * volatility ** 2) / volatility ** 2;
  const x1 = Math.log(spot / strike) / sigmaRoot + lambda * sigmaRoot;
  const x2 = Math.log(spot / barrier) / sigmaRoot + lambda * sigmaRoot;
  const y1 = Math.log(barrier ** 2 / (spot * strike)) / sigmaRoot + lambda * sigmaRoot;
  const y2 = Math.log(barrier / spot) / sigmaRoot + lambda * sigmaRoot;
  const stockDiscount = Math.exp(-dividend * maturity);
  const strikeDiscount = Math.exp(-rate * maturity);
  const imageStock = (barrier / spot) ** (2 * lambda);
  const imageStrike = (barrier / spot) ** (2 * (lambda - 1));
  const A = phi * spot * stockDiscount * normalCdf(phi * x1)
    - phi * strike * strikeDiscount * normalCdf(phi * (x1 - sigmaRoot));
  const B = phi * spot * stockDiscount * normalCdf(phi * x2)
    - phi * strike * strikeDiscount * normalCdf(phi * (x2 - sigmaRoot));
  const C = phi * spot * stockDiscount * imageStock * normalCdf(eta * y1)
    - phi * strike * strikeDiscount * imageStrike * normalCdf(eta * (y1 - sigmaRoot));
  const D = phi * spot * stockDiscount * imageStock * normalCdf(eta * y2)
    - phi * strike * strikeDiscount * imageStrike * normalCdf(eta * (y2 - sigmaRoot));

  if (direction === "down-and-out" && side === "Call") return Math.max(0, strike > barrier ? A - C : B - D);
  if (direction === "down-and-out") return Math.max(0, strike > barrier ? A - B + C - D : 0);
  if (side === "Call") return Math.max(0, strike >= barrier ? 0 : A - B + C - D);
  return Math.max(0, strike > barrier ? B - D : A - C);
}

export function americanPutBinomialPrice(parameters: BlackScholesParameters, steps = 1600): number {
  if (!Number.isInteger(steps) || steps < 1) throw new Error("Tree steps must be a positive integer.");
  if (parameters.side !== "Put") throw new Error("The Phase 2 American solver supports puts only.");
  const dt = parameters.maturity / steps;
  const up = Math.exp(parameters.volatility * Math.sqrt(dt));
  const down = 1 / up;
  const growth = Math.exp((parameters.rate - parameters.dividend) * dt);
  const probability = (growth - down) / (up - down);
  if (!(probability > 0 && probability < 1)) throw new Error("The CRR reference tree requires a finer time grid for these parameters.");
  const discount = Math.exp(-parameters.rate * dt);
  const values = Array.from({ length: steps + 1 }, (_, index) => {
    const terminalSpot = parameters.spot * up ** (steps - 2 * index);
    return Math.max(parameters.strike - terminalSpot, 0);
  });
  for (let level = steps - 1; level >= 0; level -= 1) {
    for (let index = 0; index <= level; index += 1) {
      const nodeSpot = parameters.spot * up ** (level - 2 * index);
      const continuation = discount * (probability * values[index] + (1 - probability) * values[index + 1]);
      values[index] = Math.max(parameters.strike - nodeSpot, continuation);
    }
  }
  return values[0];
}

function validateParameters(parameters: BlackScholesProductSolveRequest): void {
  const finite = [parameters.spot, parameters.strike, parameters.maturity, parameters.rate, parameters.dividend, parameters.volatility];
  if (!finite.every(Number.isFinite)) throw new Error("Black–Scholes parameters must be finite.");
  if (parameters.spot <= 0 || parameters.strike <= 0 || parameters.maturity <= 0 || parameters.volatility <= 0) {
    throw new Error("Spot, strike, maturity and volatility must be positive.");
  }
  if (!Number.isInteger(parameters.spaceSteps) || parameters.spaceSteps < 4) throw new Error("Space steps must be an integer of at least 4.");
  if (!Number.isInteger(parameters.timeSteps) || parameters.timeSteps < 1) throw new Error("Time steps must be a positive integer.");
  if (parameters.contract === "american-put" && parameters.side !== "Put") throw new Error("The Phase 2 American contract supports puts only.");
  if (parameters.contract === "american-put" && parameters.scheme === "explicit-euler") throw new Error("American exercise requires an implicit scheme.");
  if (parameters.contract === "barrier" && (!Number.isFinite(parameters.barrier) || (parameters.barrier ?? 0) <= 0)) {
    throw new Error("Barrier contracts require a finite positive barrier.");
  }
}

export function recommendedBlackScholesDomain(parameters: BlackScholesParameters): number {
  const sixSigmaState = parameters.strike * Math.exp((parameters.rate - parameters.dividend) * parameters.maturity + 6 * parameters.volatility * Math.sqrt(parameters.maturity));
  return Math.max(4 * parameters.spot, 4 * parameters.strike, sixSigmaState);
}

function createGrid(request: BlackScholesProductSolveRequest): { nodes: number[]; sMax: number } {
  const gridKind = request.gridKind ?? "nonuniform";
  const sMax = request.sMax ?? recommendedBlackScholesDomain(request);
  if (!Number.isFinite(sMax) || sMax <= request.spot || sMax <= request.strike) throw new Error("Smax must exceed spot and strike.");
  const barrier = request.barrier!;
  const minimum = request.contract === "barrier" && request.barrierDirection === "down-and-out" ? barrier : 0;
  const maximum = request.contract === "barrier" && request.barrierDirection === "up-and-out" ? barrier : sMax;
  if (maximum <= minimum) throw new Error("The barrier domain is empty.");
  const focusCandidate = request.strike > minimum && request.strike < maximum
    ? request.strike
    : request.spot > minimum && request.spot < maximum
      ? request.spot
      : (minimum + maximum) / 2;
  const nodes = gridKind === "uniform"
    ? uniformGrid(minimum, maximum, request.spaceSteps)
    : nonuniformGrid(minimum, maximum, request.spaceSteps, {
        focus: focusCandidate,
        scale: Math.max(request.strike * 0.12, (maximum - minimum) / 60),
      });
  return { nodes, sMax };
}

function coefficients(request: BlackScholesProductSolveRequest) {
  return {
    diffusion: (spot: number) => 0.5 * request.volatility ** 2 * spot ** 2,
    drift: (spot: number) => (request.rate - request.dividend) * spot,
    discount: () => request.rate,
  };
}

function payoff(request: BlackScholesProductSolveRequest, spot: number): number {
  if (request.contract === "digital") return request.side === "Call" ? Number(spot > request.strike) : Number(spot < request.strike);
  return request.side === "Call" ? Math.max(spot - request.strike, 0) : Math.max(request.strike - spot, 0);
}

function projectedDigitalPayoff(nodes: readonly number[], strike: number, side: EuropeanSide): Map<number, number> {
  return new Map(nodes.map((spot, index) => {
    const left = index === 0 ? spot : (nodes[index - 1] + spot) / 2;
    const right = index === nodes.length - 1 ? spot : (spot + nodes[index + 1]) / 2;
    const callFraction = right <= strike ? 0 : left >= strike ? 1 : (right - strike) / (right - left);
    return [spot, side === "Call" ? callFraction : 1 - callFraction];
  }));
}

function boundaries(request: BlackScholesProductSolveRequest, maximum: number) {
  if (request.contract === "american-put") return { left: () => request.strike, right: () => 0 };
  if (request.contract === "barrier") {
    if (request.barrierDirection === "up-and-out") {
      return { left: (tau: number) => request.side === "Call" ? 0 : request.strike * Math.exp(-request.rate * tau), right: () => 0 };
    }
    return {
      left: () => 0,
      right: (tau: number) => request.side === "Call"
        ? maximum * Math.exp(-request.dividend * tau) - request.strike * Math.exp(-request.rate * tau)
        : 0,
    };
  }
  if (request.contract === "digital") {
    return request.side === "Call"
      ? { left: () => 0, right: (tau: number) => Math.exp(-request.rate * tau) }
      : { left: (tau: number) => Math.exp(-request.rate * tau), right: () => 0 };
  }
  return request.side === "Call"
    ? { left: () => 0, right: (tau: number) => maximum * Math.exp(-request.dividend * tau) - request.strike * Math.exp(-request.rate * tau) }
    : { left: (tau: number) => request.strike * Math.exp(-request.rate * tau), right: () => 0 };
}

function vectorSum(...vectors: readonly number[][]): number[] {
  return vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0));
}

function scale(values: readonly number[], factor: number): number[] {
  return values.map((value) => value * factor);
}

function matrixVector(matrix: TridiagonalOperator, values: readonly number[]): number[] {
  return values.map((value, index) => matrix.diagonal[index] * value
    + (index > 0 ? matrix.lower[index - 1] * values[index - 1] : 0)
    + (index < values.length - 1 ? matrix.upper[index] * values[index + 1] : 0));
}

function projectedSor(
  matrix: TridiagonalOperator,
  rightHandSide: readonly number[],
  obstacle: readonly number[],
  initial: readonly number[],
  omega: number,
  tolerance: number,
  maxIterations: number,
): { values: number[]; iterations: number; residual: number } {
  const values = [...initial];
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    let maximumChange = 0;
    for (let index = 0; index < values.length; index += 1) {
      const offDiagonal = (index > 0 ? matrix.lower[index - 1] * values[index - 1] : 0)
        + (index < values.length - 1 ? matrix.upper[index] * values[index + 1] : 0);
      const relaxed = values[index] + omega * ((rightHandSide[index] - offDiagonal) / matrix.diagonal[index] - values[index]);
      const projected = Math.max(obstacle[index], relaxed);
      maximumChange = Math.max(maximumChange, Math.abs(projected - values[index]));
      values[index] = projected;
    }
    if (maximumChange <= tolerance) break;
  }
  if (iterations === maxIterations) throw new Error(`Projected SOR failed to converge in ${maxIterations} iterations.`);
  const residualVector = matrixVector(matrix, values).map((value, index) => value - rightHandSide[index]);
  const residual = Math.max(...values.map((value, index) => Math.abs(Math.min(value - obstacle[index], residualVector[index]))));
  return { values, iterations: iterations + 1, residual };
}

function solveAmericanPut(request: BlackScholesProductSolveRequest, nodes: number[], boundaryData: ReturnType<typeof boundaries>): { solution: Solve1DResult; exercise: ExerciseDiagnostics } {
  const started = Date.now();
  const dt = request.maturity / request.timeSteps;
  const captureEvery = request.captureEvery ?? Math.max(1, Math.floor(request.timeSteps / 24));
  const obstacle = nodes.slice(1, -1).map((spot) => Math.max(request.strike - spot, 0));
  let interior = [...obstacle];
  const layers: TimeLayer[] = [{ tau: 0, values: [request.strike, ...interior, 0] }];
  const omega = request.psorOmega ?? 1.2;
  const tolerance = request.psorTolerance ?? 1e-9;
  const maxIterations = request.psorMaxIterations ?? 20_000;
  if (!(omega > 0 && omega < 2)) throw new Error("Projected-SOR omega must lie strictly between zero and two.");
  let totalIterations = 0;
  let maximumIterations = 0;
  let maxComplementarityResidual = 0;

  const implicitStep = (tauOld: number, tauNew: number, theta: number) => {
    const step = tauNew - tauOld;
    const oldOperator = assembleOperator(nodes, coefficients(request), tauOld);
    const newOperator = assembleOperator(nodes, coefficients(request), tauNew);
    const rhs = theta === 1
      ? vectorSum(interior, scale(boundaryVector(newOperator, boundaryData, tauNew), step))
      : vectorSum(
          interior,
          scale(applyOperator(oldOperator, interior), step * (1 - theta)),
          scale(boundaryVector(oldOperator, boundaryData, tauOld), step * (1 - theta)),
          scale(boundaryVector(newOperator, boundaryData, tauNew), step * theta),
        );
    const matrix = implicitMatrix(newOperator, step * theta);
    const solved = projectedSor(matrix, rhs, obstacle, interior, omega, tolerance, maxIterations);
    interior = solved.values;
    totalIterations += solved.iterations;
    maximumIterations = Math.max(maximumIterations, solved.iterations);
    maxComplementarityResidual = Math.max(maxComplementarityResidual, solved.residual);
  };

  const useRannacher = (request.scheme ?? "rannacher-cn") === "rannacher-cn";
  const halfSteps = useRannacher ? request.rannacherHalfSteps ?? 4 : 0;
  for (let halfIndex = 0; halfIndex < halfSteps; halfIndex += 1) {
    const tauOld = halfIndex * dt / 2;
    const tauNew = (halfIndex + 1) * dt / 2;
    implicitStep(tauOld, tauNew, 1);
    const fullIndex = (halfIndex + 1) / 2;
    if ((halfIndex + 1) % 2 === 0 && (fullIndex % captureEvery === 0 || fullIndex === request.timeSteps)) {
      layers.push({ tau: tauNew, values: [request.strike, ...interior, 0] });
    }
  }
  for (let stepIndex = halfSteps / 2; stepIndex < request.timeSteps; stepIndex += 1) {
    const tauOld = stepIndex * dt;
    const tauNew = (stepIndex + 1) * dt;
    const scheme = request.scheme ?? "rannacher-cn";
    implicitStep(tauOld, tauNew, scheme === "backward-euler" ? 1 : 0.5);
    if ((stepIndex + 1) % captureEvery === 0 || stepIndex + 1 === request.timeSteps) {
      layers.push({ tau: tauNew, values: [request.strike, ...interior, 0] });
    }
  }

  const values = [request.strike, ...interior, 0];
  const spacings = gridSpacings(nodes);
  const representative = assembleOperator(nodes, coefficients(request), request.maturity / 2);
  const matrixInfo = matrixDiagnostics(representative, dt);
  const activeIndices = interior
    .map((value, index) => ({ value, index: index + 1 }))
    .filter(({ value, index }) => obstacle[index - 1] > 0 && Math.abs(value - obstacle[index - 1]) <= 2e-6);
  const exerciseBoundary = activeIndices.length > 0 ? nodes[activeIndices.at(-1)!.index] : null;
  return {
    solution: {
      nodes,
      values,
      layers,
      scheme: request.scheme ?? "rannacher-cn",
      diagnostics: {
        runtimeMs: Date.now() - started,
        spaceIntervals: nodes.length - 1,
        timeSteps: request.timeSteps,
        minSpaceStep: spacings.minimum,
        maxSpaceStep: spacings.maximum,
        timeStep: dt,
        domain: [nodes[0], nodes.at(-1)!],
        finite: values.every(Number.isFinite),
        minimumValue: Math.min(...values),
        maximumValue: Math.max(...values),
        maxLinearResidual: maxComplementarityResidual,
        operatorOffDiagonalsNonnegative: matrixInfo.offDiagonalsNonnegative,
        minimumImplicitDiagonalMargin: matrixInfo.minimumImplicitDiagonalMargin,
        explicitMonotonicityWarning: null,
        rannacherHalfSteps: halfSteps,
      },
    },
    exercise: {
      method: "Projected SOR",
      omega,
      tolerance,
      totalIterations,
      maximumIterations,
      maxComplementarityResidual,
      activeNodes: activeIndices.length,
      exerciseBoundary,
    },
  };
}

function solveCore(request: BlackScholesProductSolveRequest): { solution: Solve1DResult; interpolation: InterpolationResult; exercise?: ExerciseDiagnostics } {
  validateParameters(request);
  if (request.contract === "barrier") {
    const knockedOut = request.barrierDirection === "up-and-out" ? request.spot >= request.barrier! : request.spot <= request.barrier!;
    if (knockedOut) throw new Error("Spot is already beyond the knock-out barrier; the contract value is exactly zero.");
  }
  const { nodes } = createGrid(request);
  const boundaryData = boundaries(request, nodes.at(-1)!);
  if (request.contract === "american-put") {
    const american = solveAmericanPut(request, nodes, boundaryData);
    return { ...american, interpolation: interpolateLinear(nodes, american.solution.values, request.spot) };
  }
  const digitalPayoff = request.contract === "digital" ? projectedDigitalPayoff(nodes, request.strike, request.side) : null;
  const solution = solve1D({
    nodes,
    maturity: request.maturity,
    timeSteps: request.timeSteps,
    coefficients: coefficients(request),
    initialCondition: (spot) => digitalPayoff?.get(spot) ?? payoff(request, spot),
    boundaries: boundaryData,
    scheme: request.scheme ?? "rannacher-cn",
    rannacherHalfSteps: request.rannacherHalfSteps,
    captureEvery: request.captureEvery ?? Math.max(1, Math.floor(request.timeSteps / 24)),
  });
  return { solution, interpolation: interpolateLinear(solution.nodes, solution.values, request.spot) };
}

function benchmarkAt(request: BlackScholesProductSolveRequest, spot = request.spot): number {
  if (request.contract === "digital") return blackScholesDigitalPrice(request, spot);
  if (request.contract === "barrier") return blackScholesBarrierPrice(request, request.barrier!, request.barrierDirection ?? "up-and-out", spot);
  if (request.contract === "american-put") return spot === request.spot ? americanPutBinomialPrice(request) : Number.NaN;
  return blackScholesPrice(request, spot);
}

function calculateGreeks(request: BlackScholesProductSolveRequest, core: ReturnType<typeof solveCore>): BlackScholesGreeks {
  const { nodes, values } = core.solution;
  const bracket = core.interpolation;
  let center = bracket.exactNode ? bracket.lowerIndex : Math.abs(nodes[bracket.lowerIndex] - request.spot) < Math.abs(nodes[bracket.upperIndex] - request.spot)
    ? bracket.lowerIndex
    : bracket.upperIndex;
  center = Math.max(1, Math.min(nodes.length - 2, center));
  const weights = derivativeWeights(nodes[center] - nodes[center - 1], nodes[center + 1] - nodes[center]);
  const local = [values[center - 1], values[center], values[center + 1]];
  const delta = weights.first.reduce((sum, weight, index) => sum + weight * local[index], 0);
  const gamma = weights.second.reduce((sum, weight, index) => sum + weight * local[index], 0);
  const theta = -(0.5 * request.volatility ** 2 * request.spot ** 2 * gamma
    + (request.rate - request.dividend) * request.spot * delta - request.rate * core.interpolation.value);
  const vegaBump = Math.max(1e-4, request.volatility * 0.005);
  const rateBump = 1e-4;
  const lean = { ...request, captureEvery: request.timeSteps };
  const volUp = solveCore({ ...lean, volatility: request.volatility + vegaBump }).interpolation.value;
  const volDown = solveCore({ ...lean, volatility: Math.max(1e-8, request.volatility - vegaBump) }).interpolation.value;
  const rateUp = solveCore({ ...lean, rate: request.rate + rateBump }).interpolation.value;
  const rateDown = solveCore({ ...lean, rate: request.rate - rateBump }).interpolation.value;
  return { delta, gamma, theta, vega: (volUp - volDown) / (2 * vegaBump), rho: (rateUp - rateDown) / (2 * rateBump) };
}

export function solveBlackScholesProduct(request: BlackScholesProductSolveRequest): BlackScholesResult {
  const normalized = { ...request, barrierDirection: request.barrierDirection ?? "up-and-out" };
  const core = solveCore(normalized);
  const benchmarkPrice = benchmarkAt(normalized);
  const analyticValues = core.solution.nodes.map((spot, index) => {
    const value = benchmarkAt(normalized, spot);
    return Number.isFinite(value) ? value : core.solution.values[index];
  });
  const comparableErrors = core.solution.values
    .map((value, index) => Math.abs(value - analyticValues[index]))
    .filter(Number.isFinite);
  const absoluteError = Math.abs(core.interpolation.value - benchmarkPrice);
  return {
    parameters: {
      spot: request.spot,
      strike: request.strike,
      maturity: request.maturity,
      rate: request.rate,
      dividend: request.dividend,
      volatility: request.volatility,
      side: request.side,
    },
    contract: request.contract,
    barrier: request.barrier,
    barrierDirection: request.contract === "barrier" ? normalized.barrierDirection : undefined,
    price: core.interpolation.value,
    benchmarkPrice,
    analyticPrice: benchmarkPrice,
    benchmarkLabel: request.contract === "american-put" ? "High-resolution CRR tree" : "Closed-form Black–Scholes",
    absoluteError,
    relativeError: absoluteError / Math.max(Math.abs(benchmarkPrice), 1e-14),
    maxNormError: request.contract === "american-put" ? absoluteError : Math.max(...comparableErrors),
    l2Error: request.contract === "american-put" ? absoluteError : Math.sqrt(comparableErrors.reduce((sum, error) => sum + error * error, 0) / comparableErrors.length),
    interpolation: core.interpolation,
    solution: core.solution,
    analyticValues,
    gridKind: request.gridKind ?? "nonuniform",
    greeks: calculateGreeks(normalized, core),
    exerciseDiagnostics: core.exercise,
  };
}

export function solveBlackScholesEuropean(request: BlackScholesSolveRequest): BlackScholesResult {
  return solveBlackScholesProduct({ ...request, contract: "european" });
}

export function runBlackScholesProductConvergence(
  request: Omit<BlackScholesProductSolveRequest, "spaceSteps" | "timeSteps">,
  spaceLevels: readonly number[] = [50, 100, 200],
): ConvergenceLevel[] {
  let previousError: number | null = null;
  return spaceLevels.map((spaceSteps) => {
    const result = solveBlackScholesProduct({ ...request, spaceSteps, timeSteps: spaceSteps, captureEvery: spaceSteps });
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

export function runBlackScholesConvergence(
  request: Omit<BlackScholesSolveRequest, "spaceSteps" | "timeSteps">,
  spaceLevels: readonly number[] = [50, 100, 200],
): ConvergenceLevel[] {
  return runBlackScholesProductConvergence({ ...request, contract: "european" }, spaceLevels);
}

export function blackScholesProductDomainExpansionDelta(request: BlackScholesProductSolveRequest, expansion = 1.25): number {
  if (request.contract === "barrier" && request.barrierDirection === "up-and-out") return 0;
  const baseDomain = request.sMax ?? recommendedBlackScholesDomain(request);
  const base = solveCore({ ...request, sMax: baseDomain, captureEvery: request.timeSteps });
  const expanded = solveCore({
    ...request,
    sMax: baseDomain * expansion,
    spaceSteps: Math.ceil(request.spaceSteps * expansion),
    captureEvery: request.timeSteps,
  });
  return Math.abs(base.interpolation.value - expanded.interpolation.value);
}

export function blackScholesDomainExpansionDelta(request: BlackScholesSolveRequest, expansion = 1.25): number {
  return blackScholesProductDomainExpansionDelta({ ...request, contract: "european" }, expansion);
}
