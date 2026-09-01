import { observedOrder } from "./diagnostics.ts";
import { gridSpacings, nonuniformGrid, uniformGrid } from "./grids.ts";
import { interpolateLinear, type InterpolationResult } from "./interpolation.ts";
import { solveTridiagonal, tridiagonalResidualNorm } from "./tridiagonal.ts";
import type { SolverDiagnostics } from "./types.ts";

export type MertonScheme = "howard-implicit";
export type MertonGridKind = "uniform" | "nonuniform";

export interface MertonParameters {
  wealth: number;
  maturity: number;
  rate: number;
  expectedReturn: number;
  volatility: number;
  riskAversion: number;
  controlMin: number;
  controlMax: number;
}

export interface MertonSolveRequest extends MertonParameters {
  spaceSteps: number;
  timeSteps: number;
  gridKind?: MertonGridKind;
  wealthMin?: number;
  wealthMax?: number;
  captureEvery?: number;
  maxPolicyIterations?: number;
  policyTolerance?: number;
}

export interface MertonTimeLayer {
  tau: number;
  values: number[];
  policies: number[];
}

export interface MertonDiagnostics extends SolverDiagnostics {
  maxBellmanResidual: number;
  maxPolicyChange: number;
  maximumHowardIterations: number;
  totalHowardIterations: number;
  policyConverged: boolean;
  lowerControlActivityFraction: number;
  upperControlActivityFraction: number;
  minimumDiscreteCurvature: number;
  stateConstraintBoundary: true;
}

export interface MertonSolution {
  nodes: number[];
  values: number[];
  policies: number[];
  layers: MertonTimeLayer[];
  scheme: MertonScheme;
  diagnostics: MertonDiagnostics;
}

export interface MertonResult {
  parameters: MertonParameters;
  gridKind: MertonGridKind;
  solution: MertonSolution;
  value: number;
  price: number;
  analyticValue: number;
  analyticPrice: number;
  policy: number;
  analyticPolicy: number;
  analyticValues: number[];
  absoluteError: number;
  relativeError: number;
  policyAbsoluteError: number;
  maxNormError: number;
  l2Error: number;
  maxPolicyError: number;
  interpolation: InterpolationResult;
  policyInterpolation: InterpolationResult;
  unconstrainedBenchmarkApplicable: boolean;
}

export interface MertonConvergenceLevel {
  spaceSteps: number;
  timeSteps: number;
  price: number;
  policy: number;
  absoluteError: number;
  policyAbsoluteError: number;
  observedOrder: number | null;
  policyObservedOrder: number | null;
}

interface OperatorRow {
  lower: number;
  diagonal: number;
  upper: number;
}

const requireFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
};

function validateRequest(request: MertonSolveRequest): void {
  const finite: Array<[number, string]> = [
    [request.wealth, "Initial wealth"],
    [request.maturity, "Maturity"],
    [request.rate, "Risk-free rate"],
    [request.expectedReturn, "Expected return"],
    [request.volatility, "Volatility"],
    [request.riskAversion, "Risk aversion"],
    [request.controlMin, "Minimum control"],
    [request.controlMax, "Maximum control"],
  ];
  finite.forEach(([value, label]) => requireFinite(value, label));
  if (request.wealth <= 0) throw new Error("Initial wealth must be positive.");
  if (request.maturity <= 0) throw new Error("Maturity must be positive.");
  if (request.volatility <= 0) throw new Error("Volatility must be positive.");
  if (request.riskAversion <= 0 || Math.abs(request.riskAversion - 1) < 1e-12) {
    throw new Error("CRRA risk aversion must be positive and different from one.");
  }
  if (request.controlMin >= request.controlMax) throw new Error("Minimum control must be below maximum control.");
  if (request.controlMin > 0 || request.controlMax < 0) {
    throw new Error("The control interval must include zero for the positive-wealth state constraint.");
  }
  if (!Number.isInteger(request.spaceSteps) || request.spaceSteps < 20) throw new Error("Space steps must be an integer of at least 20.");
  if (!Number.isInteger(request.timeSteps) || request.timeSteps < 1) throw new Error("Time steps must be a positive integer.");
}

export function mertonUtility(wealth: number, riskAversion: number): number {
  if (wealth <= 0) throw new Error("CRRA utility requires positive wealth.");
  return wealth ** (1 - riskAversion) / (1 - riskAversion);
}

export function mertonAnalyticPolicy(wealth: number, parameters: Pick<MertonParameters, "rate" | "expectedReturn" | "volatility" | "riskAversion">): number {
  return (parameters.expectedReturn - parameters.rate) * wealth
    / (parameters.riskAversion * parameters.volatility ** 2);
}

export function mertonAnalyticValue(wealth: number, tau: number, parameters: Pick<MertonParameters, "rate" | "expectedReturn" | "volatility" | "riskAversion">): number {
  const excessReturn = parameters.expectedReturn - parameters.rate;
  const certaintyEquivalentGrowth = parameters.rate
    + excessReturn ** 2 / (2 * parameters.riskAversion * parameters.volatility ** 2);
  return mertonUtility(wealth, parameters.riskAversion)
    * Math.exp((1 - parameters.riskAversion) * certaintyEquivalentGrowth * tau);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function makeGrid(request: MertonSolveRequest): { nodes: number[]; minimum: number; maximum: number; kind: MertonGridKind } {
  const minimum = request.wealthMin ?? request.wealth * 0.05;
  const maximum = request.wealthMax ?? request.wealth * 4;
  requireFinite(minimum, "Minimum wealth boundary");
  requireFinite(maximum, "Maximum wealth boundary");
  if (minimum <= 0 || minimum >= request.wealth || maximum <= request.wealth) {
    throw new Error("The wealth domain must satisfy 0 < Wmin < W₀ < Wmax.");
  }
  const kind = request.gridKind ?? "nonuniform";
  const nodes = kind === "uniform"
    ? uniformGrid(minimum, maximum, request.spaceSteps)
    : nonuniformGrid(minimum, maximum, request.spaceSteps, {
      focus: request.wealth,
      scale: Math.max(request.wealth * 0.05, (maximum - minimum) / 100),
    });
  return { nodes, minimum, maximum, kind };
}

function derivatives(nodes: readonly number[], values: readonly number[], index: number): { backward: number; centred: number; forward: number; second: number; hLeft: number; hRight: number } {
  const hLeft = nodes[index] - nodes[index - 1];
  const hRight = nodes[index + 1] - nodes[index];
  const backward = (values[index] - values[index - 1]) / hLeft;
  const forward = (values[index + 1] - values[index]) / hRight;
  const centred = -hRight * values[index - 1] / (hLeft * (hLeft + hRight))
    + (hRight - hLeft) * values[index] / (hLeft * hRight)
    + hLeft * values[index + 1] / (hRight * (hLeft + hRight));
  const second = 2 * values[index - 1] / (hLeft * (hLeft + hRight))
    - 2 * values[index] / (hLeft * hRight)
    + 2 * values[index + 1] / (hRight * (hLeft + hRight));
  return { backward, centred, forward, second, hLeft, hRight };
}

function monotoneFirstDerivative(control: number, wealth: number, derivative: ReturnType<typeof derivatives>, parameters: MertonParameters): number {
  const diffusion = 0.5 * parameters.volatility ** 2 * control ** 2;
  const drift = parameters.rate * wealth + control * (parameters.expectedReturn - parameters.rate);
  const lower = diffusion * 2 / (derivative.hLeft * (derivative.hLeft + derivative.hRight))
    - drift * derivative.hRight / (derivative.hLeft * (derivative.hLeft + derivative.hRight));
  const upper = diffusion * 2 / (derivative.hRight * (derivative.hLeft + derivative.hRight))
    + drift * derivative.hLeft / (derivative.hRight * (derivative.hLeft + derivative.hRight));
  return lower >= -1e-14 && upper >= -1e-14
    ? derivative.centred
    : drift >= 0 ? derivative.forward : derivative.backward;
}

function hamiltonian(
  control: number,
  wealth: number,
  derivative: ReturnType<typeof derivatives>,
  parameters: MertonParameters,
): number {
  const drift = parameters.rate * wealth + control * (parameters.expectedReturn - parameters.rate);
  const first = monotoneFirstDerivative(control, wealth, derivative, parameters);
  return drift * first + 0.5 * parameters.volatility ** 2 * control ** 2 * derivative.second;
}

/** Maximises the piecewise-quadratic Hamiltonian induced by the monotone upwind stencil. */
function optimiseControl(
  wealth: number,
  derivative: ReturnType<typeof derivatives>,
  parameters: MertonParameters,
  previous: number,
): number {
  const excessReturn = parameters.expectedReturn - parameters.rate;
  const candidates = [parameters.controlMin, parameters.controlMax, clamp(previous, parameters.controlMin, parameters.controlMax)];
  if (Math.abs(excessReturn) > 1e-14) {
    const driftSwitch = -parameters.rate * wealth / excessReturn;
    if (driftSwitch > parameters.controlMin && driftSwitch < parameters.controlMax) candidates.push(driftSwitch);
  }
  if (Math.abs(derivative.second) > 1e-16 && Math.abs(excessReturn) > 1e-16) {
    for (const first of [derivative.backward, derivative.centred, derivative.forward]) {
      const stationary = -excessReturn * first / (parameters.volatility ** 2 * derivative.second);
      if (stationary >= parameters.controlMin && stationary <= parameters.controlMax) {
        const drift = parameters.rate * wealth + stationary * excessReturn;
        if (first === monotoneFirstDerivative(stationary, wealth, derivative, parameters)
          || (first === derivative.forward && drift >= -1e-12)
          || (first === derivative.backward && drift <= 1e-12)) candidates.push(stationary);
      }
    }
  }

  let best = candidates[0];
  let bestValue = hamiltonian(best, wealth, derivative, parameters);
  for (const candidate of candidates.slice(1)) {
    const value = hamiltonian(candidate, wealth, derivative, parameters);
    const scale = Math.max(1, Math.abs(bestValue), Math.abs(value));
    if (value > bestValue + 1e-13 * scale
      || (Math.abs(value - bestValue) <= 1e-13 * scale && Math.abs(candidate - previous) < Math.abs(best - previous))) {
      best = candidate;
      bestValue = value;
    }
  }
  return clamp(best, parameters.controlMin, parameters.controlMax);
}

function operatorRow(nodes: readonly number[], index: number, control: number, parameters: MertonParameters): OperatorRow {
  const hLeft = nodes[index] - nodes[index - 1];
  const hRight = nodes[index + 1] - nodes[index];
  const diffusion = 0.5 * parameters.volatility ** 2 * control ** 2;
  const drift = parameters.rate * nodes[index] + control * (parameters.expectedReturn - parameters.rate);
  let lower = diffusion * 2 / (hLeft * (hLeft + hRight));
  let diagonal = -diffusion * 2 / (hLeft * hRight);
  let upper = diffusion * 2 / (hRight * (hLeft + hRight));
  const centredLower = lower - drift * hRight / (hLeft * (hLeft + hRight));
  const centredUpper = upper + drift * hLeft / (hRight * (hLeft + hRight));
  if (centredLower >= -1e-14 && centredUpper >= -1e-14) {
    lower = centredLower;
    diagonal += drift * (hRight - hLeft) / (hLeft * hRight);
    upper = centredUpper;
  } else if (drift >= 0) {
    diagonal -= drift / hRight;
    upper += drift / hRight;
  } else {
    lower -= drift / hLeft;
    diagonal += drift / hLeft;
  }
  return { lower, diagonal, upper };
}

function assembleAndSolve(
  nodes: readonly number[],
  oldValues: readonly number[],
  policy: readonly number[],
  parameters: MertonParameters,
  dt: number,
  tau: number,
): { values: number[]; residual: number; margin: number; offDiagonalsNonnegative: boolean } {
  const size = nodes.length;
  const lower = new Array<number>(size - 1).fill(0);
  const diagonal = new Array<number>(size).fill(1);
  const upper = new Array<number>(size - 1).fill(0);
  const rhs = [...oldValues];
  let margin = Number.POSITIVE_INFINITY;
  let offDiagonalsNonnegative = true;

  // Positive-wealth state constraint: risky exposure is zero at Wmin and only
  // the inward, risk-free characteristic is retained in a one-sided stencil.
  const leftSpacing = nodes[1] - nodes[0];
  const inwardDrift = Math.max(0, parameters.rate * nodes[0]);
  diagonal[0] = 1 + dt * inwardDrift / leftSpacing;
  upper[0] = -dt * inwardDrift / leftSpacing;
  margin = Math.min(margin, diagonal[0] - Math.abs(upper[0]));

  for (let index = 1; index < size - 1; index += 1) {
    const row = operatorRow(nodes, index, policy[index], parameters);
    lower[index - 1] = -dt * row.lower;
    diagonal[index] = 1 - dt * row.diagonal;
    upper[index] = -dt * row.upper;
    margin = Math.min(margin, diagonal[index] - Math.abs(lower[index - 1]) - Math.abs(upper[index]));
    if (row.lower < -1e-13 || row.upper < -1e-13) offDiagonalsNonnegative = false;
  }

  // The upper boundary is in the unconstrained asymptotic region for the
  // standard domain. CRRA homogeneity supplies the far-field growth value.
  lower[size - 2] = 0;
  diagonal[size - 1] = 1;
  const farPolicy = mertonAnalyticPolicy(nodes[size - 1], parameters);
  rhs[size - 1] = farPolicy >= parameters.controlMin && farPolicy <= parameters.controlMax
    ? mertonAnalyticValue(nodes[size - 1], tau, parameters)
    : mertonUtility(nodes[size - 1], parameters.riskAversion)
      * Math.exp((1 - parameters.riskAversion) * parameters.rate * tau);

  const values = solveTridiagonal(lower, diagonal, upper, rhs);
  return {
    values,
    residual: tridiagonalResidualNorm(lower, diagonal, upper, values, rhs),
    margin,
    offDiagonalsNonnegative,
  };
}

function bellmanResidual(
  nodes: readonly number[],
  oldValues: readonly number[],
  values: readonly number[],
  parameters: MertonParameters,
  dt: number,
): number {
  let maximum = 0;
  for (let index = 1; index < nodes.length - 1; index += 1) {
    const derivative = derivatives(nodes, values, index);
    const optimum = optimiseControl(nodes[index], derivative, parameters, 0);
    const residual = (values[index] - oldValues[index]) / dt
      - hamiltonian(optimum, nodes[index], derivative, parameters);
    maximum = Math.max(maximum, Math.abs(residual));
  }
  return maximum;
}

export function solveMertonHjb(request: MertonSolveRequest): MertonResult {
  validateRequest(request);
  const started = performance.now();
  const parameters: MertonParameters = {
    wealth: request.wealth,
    maturity: request.maturity,
    rate: request.rate,
    expectedReturn: request.expectedReturn,
    volatility: request.volatility,
    riskAversion: request.riskAversion,
    controlMin: request.controlMin,
    controlMax: request.controlMax,
  };
  const { nodes, minimum, maximum, kind } = makeGrid(request);
  const dt = request.maturity / request.timeSteps;
  const maxPolicyIterations = request.maxPolicyIterations ?? 30;
  const policyTolerance = request.policyTolerance ?? 1e-8 * Math.max(1, request.controlMax - request.controlMin);
  const captureEvery = request.captureEvery ?? Math.max(1, Math.floor(request.timeSteps / 16));
  let values = nodes.map((wealth) => mertonUtility(wealth, request.riskAversion));
  let policy = nodes.map((wealth) => clamp(mertonAnalyticPolicy(wealth, parameters), request.controlMin, request.controlMax));
  policy[0] = 0;
  const layers: MertonTimeLayer[] = [{ tau: 0, values: [...values], policies: [...policy] }];
  let maxLinearResidual = 0;
  let maxBellman = 0;
  let maxPolicyChange = 0;
  let maximumHowardIterations = 0;
  let totalHowardIterations = 0;
  let minimumMargin = Number.POSITIVE_INFINITY;
  let offDiagonalsNonnegative = true;
  let policyConverged = true;

  for (let step = 1; step <= request.timeSteps; step += 1) {
    const oldValues = values;
    let stepConverged = false;
    let solved = values;
    let iteration = 0;
    for (; iteration < maxPolicyIterations; iteration += 1) {
      const linear = assembleAndSolve(nodes, oldValues, policy, parameters, dt, step * dt);
      solved = linear.values;
      maxLinearResidual = Math.max(maxLinearResidual, linear.residual);
      minimumMargin = Math.min(minimumMargin, linear.margin);
      offDiagonalsNonnegative &&= linear.offDiagonalsNonnegative;
      const nextPolicy = [...policy];
      nextPolicy[0] = 0;
      nextPolicy[nodes.length - 1] = clamp(mertonAnalyticPolicy(nodes[nodes.length - 1], parameters), request.controlMin, request.controlMax);
      let change = 0;
      for (let index = 1; index < nodes.length - 1; index += 1) {
        nextPolicy[index] = optimiseControl(nodes[index], derivatives(nodes, solved, index), parameters, policy[index]);
        change = Math.max(change, Math.abs(nextPolicy[index] - policy[index]));
      }
      maxPolicyChange = Math.max(maxPolicyChange, change);
      policy = nextPolicy;
      if (change <= policyTolerance) {
        stepConverged = true;
        break;
      }
    }
    totalHowardIterations += iteration + 1;
    maximumHowardIterations = Math.max(maximumHowardIterations, iteration + 1);
    policyConverged &&= stepConverged;
    // Re-solve using the accepted policy so value and policy satisfy one system.
    const finalLinear = assembleAndSolve(nodes, oldValues, policy, parameters, dt, step * dt);
    values = finalLinear.values;
    maxLinearResidual = Math.max(maxLinearResidual, finalLinear.residual);
    minimumMargin = Math.min(minimumMargin, finalLinear.margin);
    offDiagonalsNonnegative &&= finalLinear.offDiagonalsNonnegative;
    maxBellman = Math.max(maxBellman, bellmanResidual(nodes, oldValues, values, parameters, dt));
    if (step % captureEvery === 0 || step === request.timeSteps) {
      layers.push({ tau: step * dt, values: [...values], policies: [...policy] });
    }
  }

  let lowerActive = 0;
  let upperActive = 0;
  let minimumCurvature = Number.POSITIVE_INFINITY;
  let maxNormError = 0;
  let squaredError = 0;
  let maxPolicyError = 0;
  let benchmarkNodes = 0;
  for (let index = 1; index < nodes.length - 1; index += 1) {
    if (Math.abs(policy[index] - request.controlMin) <= 1e-7 * Math.max(1, Math.abs(request.controlMin))) lowerActive += 1;
    if (Math.abs(policy[index] - request.controlMax) <= 1e-7 * Math.max(1, Math.abs(request.controlMax))) upperActive += 1;
    minimumCurvature = Math.min(minimumCurvature, derivatives(nodes, values, index).second);
    const analyticPolicy = mertonAnalyticPolicy(nodes[index], parameters);
    if (analyticPolicy >= request.controlMin && analyticPolicy <= request.controlMax) {
      const error = Math.abs(values[index] - mertonAnalyticValue(nodes[index], request.maturity, parameters));
      maxNormError = Math.max(maxNormError, error);
      squaredError += error ** 2;
      maxPolicyError = Math.max(maxPolicyError, Math.abs(policy[index] - analyticPolicy));
      benchmarkNodes += 1;
    }
  }

  const interpolation = interpolateLinear(nodes, values, request.wealth);
  const policyInterpolation = interpolateLinear(nodes, policy, request.wealth);
  const analyticValue = mertonAnalyticValue(request.wealth, request.maturity, parameters);
  const analyticPolicy = mertonAnalyticPolicy(request.wealth, parameters);
  const spacing = gridSpacings(nodes);
  const interiorCount = nodes.length - 2;
  const solution: MertonSolution = {
    nodes,
    values,
    policies: policy,
    layers,
    scheme: "howard-implicit",
    diagnostics: {
      runtimeMs: Math.round((performance.now() - started) * 1000) / 1000,
      spaceIntervals: request.spaceSteps,
      timeSteps: request.timeSteps,
      minSpaceStep: spacing.minimum,
      maxSpaceStep: spacing.maximum,
      timeStep: dt,
      domain: [minimum, maximum],
      finite: values.every(Number.isFinite) && policy.every(Number.isFinite),
      minimumValue: Math.min(...values),
      maximumValue: Math.max(...values),
      maxLinearResidual,
      operatorOffDiagonalsNonnegative: offDiagonalsNonnegative,
      minimumImplicitDiagonalMargin: minimumMargin,
      explicitMonotonicityWarning: null,
      rannacherHalfSteps: 0,
      maxBellmanResidual: maxBellman,
      maxPolicyChange,
      maximumHowardIterations,
      totalHowardIterations,
      policyConverged,
      lowerControlActivityFraction: lowerActive / interiorCount,
      upperControlActivityFraction: upperActive / interiorCount,
      minimumDiscreteCurvature: minimumCurvature,
      stateConstraintBoundary: true,
    },
  };
  const absoluteError = Math.abs(interpolation.value - analyticValue);
  return {
    parameters,
    gridKind: kind,
    solution,
    value: interpolation.value,
    price: interpolation.value,
    analyticValue,
    analyticPrice: analyticValue,
    policy: policyInterpolation.value,
    analyticPolicy,
    analyticValues: nodes.map((node) => mertonAnalyticValue(node, request.maturity, parameters)),
    absoluteError,
    relativeError: absoluteError / Math.max(1e-14, Math.abs(analyticValue)),
    policyAbsoluteError: Math.abs(policyInterpolation.value - analyticPolicy),
    maxNormError,
    l2Error: Math.sqrt(squaredError / Math.max(1, benchmarkNodes)),
    maxPolicyError,
    interpolation,
    policyInterpolation,
    unconstrainedBenchmarkApplicable: analyticPolicy >= request.controlMin && analyticPolicy <= request.controlMax,
  };
}

export function runMertonConvergence(
  request: Omit<MertonSolveRequest, "spaceSteps" | "timeSteps">,
  levels: readonly number[] = [50, 100, 200],
): MertonConvergenceLevel[] {
  let previousValueError: number | null = null;
  let previousPolicyError: number | null = null;
  return levels.map((spaceSteps) => {
    const result = solveMertonHjb({ ...request, spaceSteps, timeSteps: spaceSteps, captureEvery: spaceSteps });
    const level: MertonConvergenceLevel = {
      spaceSteps,
      timeSteps: spaceSteps,
      price: result.value,
      policy: result.policy,
      absoluteError: result.absoluteError,
      policyAbsoluteError: result.policyAbsoluteError,
      observedOrder: previousValueError === null ? null : observedOrder(previousValueError, result.absoluteError),
      policyObservedOrder: previousPolicyError === null ? null : observedOrder(previousPolicyError, result.policyAbsoluteError),
    };
    previousValueError = result.absoluteError;
    previousPolicyError = result.policyAbsoluteError;
    return level;
  });
}

export function mertonDomainExpansionDelta(request: MertonSolveRequest, expansion = 1.5): number {
  if (expansion <= 1) throw new Error("Domain expansion factor must exceed one.");
  const base = solveMertonHjb(request);
  const expanded = solveMertonHjb({
    ...request,
    wealthMin: (request.wealthMin ?? request.wealth * 0.05) / expansion,
    wealthMax: (request.wealthMax ?? request.wealth * 4) * expansion,
  });
  return Math.abs(base.value - expanded.value);
}
