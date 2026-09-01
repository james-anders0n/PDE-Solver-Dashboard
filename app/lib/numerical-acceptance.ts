export interface NumericalAcceptanceTolerance {
  pointwiseAbsolute: number;
  maxNorm?: number;
  observedOrder?: number;
}

export interface NumericalAcceptanceResultLike {
  absoluteError: number;
  maxNormError: number;
  solution: { diagnostics: { finite: boolean } };
}

export interface NumericalAcceptanceLevelLike {
  absoluteError: number;
  observedOrder: number | null;
}

export interface NumericalAcceptanceEvaluation {
  accepted: boolean;
  issues: string[];
  observedOrderAcceptedByErrorFloor: boolean;
}

const scientific = (value: number) => value.toExponential(3);

export function evaluateNumericalAcceptance(options: {
  result: NumericalAcceptanceResultLike;
  convergence: NumericalAcceptanceLevelLike[];
  tolerance: NumericalAcceptanceTolerance;
}): NumericalAcceptanceEvaluation {
  const { result, convergence, tolerance } = options;
  const issues: string[] = [];
  if (result.absoluteError > tolerance.pointwiseAbsolute) {
    issues.push(`Point error ${scientific(result.absoluteError)} exceeds ${scientific(tolerance.pointwiseAbsolute)}.`);
  }
  if (tolerance.maxNorm !== undefined && result.maxNormError > tolerance.maxNorm) {
    issues.push(`Maximum-norm error ${scientific(result.maxNormError)} exceeds ${scientific(tolerance.maxNorm)}.`);
  }

  const observedOrder = convergence.at(-1)?.observedOrder;
  const finestTwo = convergence.slice(-2);
  const observedOrderAcceptedByErrorFloor = tolerance.observedOrder !== undefined
    && observedOrder != null
    && observedOrder < tolerance.observedOrder
    && finestTwo.length === 2
    && finestTwo.every((level) => level.absoluteError <= tolerance.pointwiseAbsolute);
  if (tolerance.observedOrder !== undefined
    && observedOrder != null
    && observedOrder < tolerance.observedOrder
    && !observedOrderAcceptedByErrorFloor) {
    issues.push(`Observed convergence order ${observedOrder.toFixed(2)} is below ${tolerance.observedOrder.toFixed(2)}.`);
  }
  if (!result.solution.diagnostics.finite) {
    issues.push("The numerical solution contains a non-finite value.");
  }
  return { accepted: issues.length === 0, issues, observedOrderAcceptedByErrorFloor };
}
