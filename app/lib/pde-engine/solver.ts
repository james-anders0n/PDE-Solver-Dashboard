import { matrixDiagnostics } from "./diagnostics.ts";
import { gridSpacings, validateGrid } from "./grids.ts";
import { applyOperator, assembleOperator, boundaryVector, implicitMatrix, type TridiagonalOperator } from "./operator.ts";
import { solveTridiagonal, tridiagonalResidualNorm } from "./tridiagonal.ts";
import type { Solve1DRequest, Solve1DResult } from "./types.ts";

function addVectors(...vectors: readonly number[][]): number[] {
  return vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0));
}

function scale(values: readonly number[], factor: number): number[] {
  return values.map((value) => value * factor);
}

function solveImplicit(matrix: TridiagonalOperator, rightHandSide: number[]): { values: number[]; residual: number } {
  const values = solveTridiagonal(matrix.lower, matrix.diagonal, matrix.upper, rightHandSide);
  return { values, residual: tridiagonalResidualNorm(matrix.lower, matrix.diagonal, matrix.upper, values, rightHandSide) };
}

export function solve1D(request: Solve1DRequest): Solve1DResult {
  const started = Date.now();
  validateGrid(request.nodes);
  if (!Number.isFinite(request.maturity) || request.maturity <= 0) throw new Error("Maturity must be finite and positive.");
  if (!Number.isInteger(request.timeSteps) || request.timeSteps < 1) throw new Error("Time steps must be a positive integer.");
  const captureEvery = request.captureEvery ?? 1;
  if (!Number.isInteger(captureEvery) || captureEvery < 1) throw new Error("captureEvery must be a positive integer.");

  const timeStep = request.maturity / request.timeSteps;
  const rannacherHalfSteps = request.scheme === "rannacher-cn" ? request.rannacherHalfSteps ?? 4 : 0;
  if (!Number.isInteger(rannacherHalfSteps) || rannacherHalfSteps < 0 || rannacherHalfSteps % 2 !== 0 || rannacherHalfSteps > 2 * request.timeSteps) {
    throw new Error("Rannacher half-steps must be a nonnegative even integer no greater than twice the time-step count.");
  }

  const nodes = [...request.nodes];
  let interior = nodes.slice(1, -1).map(request.initialCondition);
  const fullValues = (tau: number, current: readonly number[]) => [request.boundaries.left(tau), ...current, request.boundaries.right(tau)];
  const layers = [{ tau: 0, values: fullValues(0, interior) }];
  let maxLinearResidual = 0;

  const backwardEulerStep = (current: number[], tauOld: number, tauNew: number): number[] => {
    const step = tauNew - tauOld;
    const operator = assembleOperator(nodes, request.coefficients, tauNew);
    const matrix = implicitMatrix(operator, step);
    const rightHandSide = addVectors(current, scale(boundaryVector(operator, request.boundaries, tauNew), step));
    const solved = solveImplicit(matrix, rightHandSide);
    maxLinearResidual = Math.max(maxLinearResidual, solved.residual);
    return solved.values;
  };

  const crankNicolsonStep = (current: number[], tauOld: number, tauNew: number): number[] => {
    const step = tauNew - tauOld;
    const oldOperator = assembleOperator(nodes, request.coefficients, tauOld);
    const newOperator = assembleOperator(nodes, request.coefficients, tauNew);
    const rightHandSide = addVectors(
      current,
      scale(applyOperator(oldOperator, current), step / 2),
      scale(boundaryVector(oldOperator, request.boundaries, tauOld), step / 2),
      scale(boundaryVector(newOperator, request.boundaries, tauNew), step / 2),
    );
    const matrix = implicitMatrix(newOperator, step / 2);
    const solved = solveImplicit(matrix, rightHandSide);
    maxLinearResidual = Math.max(maxLinearResidual, solved.residual);
    return solved.values;
  };

  const explicitStep = (current: number[], tauOld: number): number[] => {
    const operator = assembleOperator(nodes, request.coefficients, tauOld);
    return addVectors(
      current,
      scale(applyOperator(operator, current), timeStep),
      scale(boundaryVector(operator, request.boundaries, tauOld), timeStep),
    );
  };

  if (request.scheme === "rannacher-cn") {
    const halfStep = timeStep / 2;
    for (let halfIndex = 0; halfIndex < rannacherHalfSteps; halfIndex += 1) {
      const tauOld = halfIndex * halfStep;
      const tauNew = (halfIndex + 1) * halfStep;
      interior = backwardEulerStep(interior, tauOld, tauNew);
      const fullStepIndex = (halfIndex + 1) / 2;
      if ((halfIndex + 1) % 2 === 0 && (fullStepIndex % captureEvery === 0 || fullStepIndex === request.timeSteps)) {
        layers.push({ tau: tauNew, values: fullValues(tauNew, interior) });
      }
    }
    for (let stepIndex = rannacherHalfSteps / 2; stepIndex < request.timeSteps; stepIndex += 1) {
      const tauOld = stepIndex * timeStep;
      const tauNew = (stepIndex + 1) * timeStep;
      interior = crankNicolsonStep(interior, tauOld, tauNew);
      if ((stepIndex + 1) % captureEvery === 0 || stepIndex + 1 === request.timeSteps) {
        layers.push({ tau: tauNew, values: fullValues(tauNew, interior) });
      }
    }
  } else {
    for (let stepIndex = 0; stepIndex < request.timeSteps; stepIndex += 1) {
      const tauOld = stepIndex * timeStep;
      const tauNew = (stepIndex + 1) * timeStep;
      if (request.scheme === "explicit-euler") interior = explicitStep(interior, tauOld);
      else if (request.scheme === "backward-euler") interior = backwardEulerStep(interior, tauOld, tauNew);
      else interior = crankNicolsonStep(interior, tauOld, tauNew);
      if ((stepIndex + 1) % captureEvery === 0 || stepIndex + 1 === request.timeSteps) {
        layers.push({ tau: tauNew, values: fullValues(tauNew, interior) });
      }
    }
  }

  const values = fullValues(request.maturity, interior);
  const spacings = gridSpacings(nodes);
  const representativeOperator = assembleOperator(nodes, request.coefficients, request.maturity / 2);
  const matrix = matrixDiagnostics(representativeOperator, timeStep);
  const finite = values.every(Number.isFinite);
  return {
    nodes,
    values,
    layers,
    scheme: request.scheme,
    diagnostics: {
      runtimeMs: Date.now() - started,
      spaceIntervals: nodes.length - 1,
      timeSteps: request.timeSteps,
      minSpaceStep: spacings.minimum,
      maxSpaceStep: spacings.maximum,
      timeStep,
      domain: [nodes[0], nodes[nodes.length - 1]],
      finite,
      minimumValue: finite ? Math.min(...values) : Number.NaN,
      maximumValue: finite ? Math.max(...values) : Number.NaN,
      maxLinearResidual,
      operatorOffDiagonalsNonnegative: matrix.offDiagonalsNonnegative,
      minimumImplicitDiagonalMargin: matrix.minimumImplicitDiagonalMargin,
      explicitMonotonicityWarning: request.scheme === "explicit-euler" && !matrix.explicitMonotone
        ? "The explicit update is not monotone on this grid and time step; refine time or space before trusting it."
        : null,
      rannacherHalfSteps,
    },
  };
}
