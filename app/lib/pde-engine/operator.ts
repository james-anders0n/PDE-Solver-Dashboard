import { validateGrid } from "./grids.ts";
import type { Coefficients1D, DirichletBoundaries } from "./types.ts";

export interface TridiagonalOperator {
  lower: number[];
  diagonal: number[];
  upper: number[];
  leftBoundaryWeight: number;
  rightBoundaryWeight: number;
}

export interface DerivativeWeights {
  first: [number, number, number];
  second: [number, number, number];
}

export function derivativeWeights(leftSpacing: number, rightSpacing: number): DerivativeWeights {
  if (!Number.isFinite(leftSpacing) || !Number.isFinite(rightSpacing) || leftSpacing <= 0 || rightSpacing <= 0) {
    throw new Error("Local grid spacings must be finite and positive.");
  }
  const total = leftSpacing + rightSpacing;
  return {
    first: [
      -rightSpacing / (leftSpacing * total),
      (rightSpacing - leftSpacing) / (leftSpacing * rightSpacing),
      leftSpacing / (rightSpacing * total),
    ],
    second: [
      2 / (leftSpacing * total),
      -2 / (leftSpacing * rightSpacing),
      2 / (rightSpacing * total),
    ],
  };
}

export function assembleOperator(nodes: readonly number[], coefficients: Coefficients1D, tau: number): TridiagonalOperator {
  validateGrid(nodes);
  if (!Number.isFinite(tau) || tau < 0) throw new Error("Operator time must be finite and nonnegative.");
  const interiorSize = nodes.length - 2;
  const lower = new Array<number>(Math.max(0, interiorSize - 1));
  const diagonal = new Array<number>(interiorSize);
  const upper = new Array<number>(Math.max(0, interiorSize - 1));
  let leftBoundaryWeight = 0;
  let rightBoundaryWeight = 0;

  for (let row = 0; row < interiorSize; row += 1) {
    const nodeIndex = row + 1;
    const x = nodes[nodeIndex];
    const weights = derivativeWeights(x - nodes[nodeIndex - 1], nodes[nodeIndex + 1] - x);
    const diffusion = coefficients.diffusion(x, tau);
    const drift = coefficients.drift(x, tau);
    const discount = coefficients.discount(x, tau);
    if (![diffusion, drift, discount].every(Number.isFinite)) throw new Error(`PDE coefficients must be finite at x=${x}, tau=${tau}.`);

    const left = diffusion * weights.second[0] + drift * weights.first[0];
    const center = diffusion * weights.second[1] + drift * weights.first[1] - discount;
    const right = diffusion * weights.second[2] + drift * weights.first[2];
    diagonal[row] = center;
    if (row === 0) leftBoundaryWeight = left;
    else lower[row - 1] = left;
    if (row === interiorSize - 1) rightBoundaryWeight = right;
    else upper[row] = right;
  }
  return { lower, diagonal, upper, leftBoundaryWeight, rightBoundaryWeight };
}

export function boundaryVector(operator: TridiagonalOperator, boundaries: DirichletBoundaries, tau: number): number[] {
  const vector = new Array<number>(operator.diagonal.length).fill(0);
  vector[0] = operator.leftBoundaryWeight * boundaries.left(tau);
  vector[vector.length - 1] += operator.rightBoundaryWeight * boundaries.right(tau);
  return vector;
}

export function applyOperator(operator: TridiagonalOperator, values: readonly number[]): number[] {
  if (values.length !== operator.diagonal.length) throw new Error("Operator and vector dimensions are inconsistent.");
  return values.map((value, index) => operator.diagonal[index] * value
    + (index > 0 ? operator.lower[index - 1] * values[index - 1] : 0)
    + (index < values.length - 1 ? operator.upper[index] * values[index + 1] : 0));
}

export function implicitMatrix(operator: TridiagonalOperator, factor: number): TridiagonalOperator {
  return {
    lower: operator.lower.map((value) => -factor * value),
    diagonal: operator.diagonal.map((value) => 1 - factor * value),
    upper: operator.upper.map((value) => -factor * value),
    leftBoundaryWeight: 0,
    rightBoundaryWeight: 0,
  };
}
