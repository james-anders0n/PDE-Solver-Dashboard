function requireFiniteArray(values: readonly number[], label: string): void {
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new Error(`${label}[${index}] must be finite.`);
  });
}

export function solveTridiagonal(
  lower: readonly number[],
  diagonal: readonly number[],
  upper: readonly number[],
  rightHandSide: readonly number[],
  pivotTolerance = 1e-13,
): number[] {
  const size = diagonal.length;
  if (size === 0) return [];
  if (lower.length !== size - 1 || upper.length !== size - 1 || rightHandSide.length !== size) {
    throw new Error("Tridiagonal dimensions are inconsistent.");
  }
  if (!Number.isFinite(pivotTolerance) || pivotTolerance <= 0) throw new Error("Pivot tolerance must be positive.");
  requireFiniteArray(lower, "lower");
  requireFiniteArray(diagonal, "diagonal");
  requireFiniteArray(upper, "upper");
  requireFiniteArray(rightHandSide, "rightHandSide");

  const d = [...diagonal];
  const rhs = [...rightHandSide];
  const u = [...upper];

  const checkPivot = (pivot: number, index: number) => {
    const rowScale = Math.max(1, Math.abs(d[index]), Math.abs(index > 0 ? lower[index - 1] : 0), Math.abs(index < u.length ? u[index] : 0));
    if (Math.abs(pivot) <= pivotTolerance * rowScale) throw new Error(`Tridiagonal solve encountered a near-zero pivot at row ${index}.`);
  };

  checkPivot(d[0], 0);
  for (let index = 1; index < size; index += 1) {
    const multiplier = lower[index - 1] / d[index - 1];
    d[index] -= multiplier * u[index - 1];
    rhs[index] -= multiplier * rhs[index - 1];
    checkPivot(d[index], index);
  }

  const solution = new Array<number>(size);
  solution[size - 1] = rhs[size - 1] / d[size - 1];
  for (let index = size - 2; index >= 0; index -= 1) {
    solution[index] = (rhs[index] - u[index] * solution[index + 1]) / d[index];
  }
  return solution;
}

export function tridiagonalResidualNorm(
  lower: readonly number[],
  diagonal: readonly number[],
  upper: readonly number[],
  solution: readonly number[],
  rightHandSide: readonly number[],
): number {
  let maximum = 0;
  for (let index = 0; index < diagonal.length; index += 1) {
    const value = diagonal[index] * solution[index]
      + (index > 0 ? lower[index - 1] * solution[index - 1] : 0)
      + (index < diagonal.length - 1 ? upper[index] * solution[index + 1] : 0);
    maximum = Math.max(maximum, Math.abs(value - rightHandSide[index]));
  }
  return maximum;
}
