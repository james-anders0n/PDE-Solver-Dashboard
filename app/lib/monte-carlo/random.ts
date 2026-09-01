const UINT32_RANGE = 0x1_0000_0000;
const UINT32_MAX = UINT32_RANGE - 1;

export interface UniformRandomSource {
  /** Return a uniformly distributed unsigned 32-bit integer. */
  nextUint32(): number;
  /** Return a uniform variate in the half-open interval [0, 1). */
  next(): number;
}

/**
 * Small deterministic PRNG with explicitly pinned 32-bit arithmetic.
 *
 * Mulberry32 is suitable for reproducible simulation and testing. It is not a
 * cryptographic random-number generator.
 */
export class Mulberry32 implements UniformRandomSource {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > UINT32_MAX) {
      throw new RangeError(`seed must be an integer between 0 and ${UINT32_MAX}`);
    }
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  next(): number {
    return this.nextUint32() / UINT32_RANGE;
  }
}

export class NormalSampler {
  private spare: number | undefined;
  private readonly random: UniformRandomSource;

  constructor(random: UniformRandomSource) {
    this.random = random;
  }

  /** Draw a standard normal variate using the Box–Muller transform. */
  next(): number {
    if (this.spare !== undefined) {
      const value = this.spare;
      this.spare = undefined;
      return value;
    }

    // 1 - U is in (0, 1], avoiding log(0) without a retry branch.
    const radius = Math.sqrt(-2 * Math.log(1 - this.random.next()));
    const angle = 2 * Math.PI * this.random.next();
    this.spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
}

export interface CorrelatedNormalPair {
  first: number;
  second: number;
}

/**
 * Draw standard normals with the requested Pearson correlation.
 */
export function correlatedNormalPair(
  normal: NormalSampler,
  correlation: number,
): CorrelatedNormalPair {
  if (!Number.isFinite(correlation) || correlation < -1 || correlation > 1) {
    throw new RangeError("correlation must be finite and between -1 and 1");
  }
  const first = normal.next();
  const independent = normal.next();
  return {
    first,
    second: correlation * first + Math.sqrt(Math.max(0, 1 - correlation * correlation)) * independent,
  };
}
