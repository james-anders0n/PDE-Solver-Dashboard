export interface RunningStatisticsSnapshot {
  count: number;
  mean: number;
  populationVariance: number;
  sampleVariance: number;
  minimum: number;
  maximum: number;
}

/** Numerically stable, constant-memory mean and variance using Welford's method. */
export class RunningStatistics {
  private sampleCount = 0;
  private runningMean = 0;
  private sumSquaredDeviation = 0;
  private runningMinimum = Number.POSITIVE_INFINITY;
  private runningMaximum = Number.NEGATIVE_INFINITY;

  add(value: number): this {
    if (!Number.isFinite(value)) {
      throw new RangeError("running statistics accept only finite values");
    }
    this.sampleCount += 1;
    const delta = value - this.runningMean;
    this.runningMean += delta / this.sampleCount;
    this.sumSquaredDeviation += delta * (value - this.runningMean);
    this.runningMinimum = Math.min(this.runningMinimum, value);
    this.runningMaximum = Math.max(this.runningMaximum, value);
    return this;
  }

  get count(): number {
    return this.sampleCount;
  }

  get mean(): number {
    return this.sampleCount === 0 ? Number.NaN : this.runningMean;
  }

  get populationVariance(): number {
    return this.sampleCount === 0 ? Number.NaN : this.sumSquaredDeviation / this.sampleCount;
  }

  get sampleVariance(): number {
    return this.sampleCount < 2 ? Number.NaN : this.sumSquaredDeviation / (this.sampleCount - 1);
  }

  get minimum(): number {
    return this.sampleCount === 0 ? Number.NaN : this.runningMinimum;
  }

  get maximum(): number {
    return this.sampleCount === 0 ? Number.NaN : this.runningMaximum;
  }

  snapshot(): RunningStatisticsSnapshot {
    return {
      count: this.count,
      mean: this.mean,
      populationVariance: this.populationVariance,
      sampleVariance: this.sampleVariance,
      minimum: this.minimum,
      maximum: this.maximum,
    };
  }
}

function validateProbability(probability: number): void {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("quantile probability must be finite and between 0 and 1");
  }
}

function sortedFiniteValues(values: ArrayLike<number>): number[] {
  if (values.length === 0) throw new RangeError("quantiles require at least one value");
  const sorted = Array.from(values);
  if (!sorted.every(Number.isFinite)) {
    throw new RangeError("quantiles accept only finite values");
  }
  return sorted.sort((left, right) => left - right);
}

function quantileFromSorted(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

/** R-7/NumPy-linear sample quantile. The input is never mutated. */
export function quantile(values: ArrayLike<number>, probability: number): number {
  validateProbability(probability);
  return quantileFromSorted(sortedFiniteValues(values), probability);
}

/** Calculate several quantiles with one sort, preserving probability order. */
export function quantiles(
  values: ArrayLike<number>,
  probabilities: readonly number[],
): number[] {
  probabilities.forEach(validateProbability);
  const sorted = sortedFiniteValues(values);
  return probabilities.map((probability) => quantileFromSorted(sorted, probability));
}

/** Calculate several quantiles keyed by the canonical string form of each level. */
export function quantileRecord(
  values: ArrayLike<number>,
  probabilities: readonly number[],
): Record<string, number> {
  const calculated = quantiles(values, probabilities);
  return Object.fromEntries(probabilities.map((probability, index) => [String(probability), calculated[index]]));
}
