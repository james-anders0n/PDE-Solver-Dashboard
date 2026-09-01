import type { TridiagonalOperator } from "./operator.ts";

export interface MatrixDiagnostics {
  offDiagonalsNonnegative: boolean;
  minimumImplicitDiagonalMargin: number;
  explicitMonotone: boolean;
}

export function matrixDiagnostics(operator: TridiagonalOperator, timeStep: number): MatrixDiagnostics {
  const offDiagonals = [operator.leftBoundaryWeight, ...operator.lower, ...operator.upper, operator.rightBoundaryWeight];
  const offDiagonalsNonnegative = offDiagonals.every((value) => value >= -1e-13);
  let minimumImplicitDiagonalMargin = Number.POSITIVE_INFINITY;
  let explicitMonotone = offDiagonalsNonnegative;
  operator.diagonal.forEach((diagonal, index) => {
    const implicitDiagonal = 1 - timeStep * diagonal;
    const offDiagonalMagnitude = timeStep
      * (Math.abs(index > 0 ? operator.lower[index - 1] : 0) + Math.abs(index < operator.diagonal.length - 1 ? operator.upper[index] : 0));
    minimumImplicitDiagonalMargin = Math.min(minimumImplicitDiagonalMargin, implicitDiagonal - offDiagonalMagnitude);
    if (1 + timeStep * diagonal < -1e-13) explicitMonotone = false;
  });
  return { offDiagonalsNonnegative, minimumImplicitDiagonalMargin, explicitMonotone };
}

export function observedOrder(coarseError: number, fineError: number): number | null {
  if (!Number.isFinite(coarseError) || !Number.isFinite(fineError) || coarseError <= 0 || fineError <= 0) return null;
  return Math.log(coarseError / fineError) / Math.log(2);
}
