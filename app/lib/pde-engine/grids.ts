function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

export function validateGrid(nodes: readonly number[]): void {
  if (nodes.length < 3) throw new Error("A 1D grid requires at least two intervals.");
  nodes.forEach((node, index) => {
    assertFinite(node, `Grid node ${index}`);
    if (index > 0 && node <= nodes[index - 1]) {
      throw new Error("Grid nodes must be strictly increasing with no duplicates.");
    }
  });
}

export function uniformGrid(xMin: number, xMax: number, intervals: number): number[] {
  assertFinite(xMin, "xMin");
  assertFinite(xMax, "xMax");
  if (xMax <= xMin) throw new Error("xMax must be greater than xMin.");
  if (!Number.isInteger(intervals) || intervals < 2) throw new Error("Grid intervals must be an integer of at least 2.");

  const step = (xMax - xMin) / intervals;
  const nodes = Array.from({ length: intervals + 1 }, (_, index) => (index === intervals ? xMax : xMin + index * step));
  validateGrid(nodes);
  return nodes;
}

export interface NonuniformGridOptions {
  focus: number;
  scale?: number;
}

/** Smooth sinh mapping that concentrates nodes near an interior focus. */
export function nonuniformGrid(xMin: number, xMax: number, intervals: number, options: NonuniformGridOptions): number[] {
  assertFinite(options.focus, "Grid focus");
  if (options.focus <= xMin || options.focus >= xMax) throw new Error("Nonuniform-grid focus must be inside the domain.");
  if (!Number.isInteger(intervals) || intervals < 2) throw new Error("Grid intervals must be an integer of at least 2.");

  const scale = options.scale ?? (xMax - xMin) / 20;
  assertFinite(scale, "Grid concentration scale");
  if (scale <= 0) throw new Error("Grid concentration scale must be positive.");

  const left = Math.asinh((xMin - options.focus) / scale);
  const right = Math.asinh((xMax - options.focus) / scale);
  const nodes = Array.from({ length: intervals + 1 }, (_, index) => {
    if (index === 0) return xMin;
    if (index === intervals) return xMax;
    const eta = index / intervals;
    return options.focus + scale * Math.sinh(left + eta * (right - left));
  });
  validateGrid(nodes);
  return nodes;
}

export function gridSpacings(nodes: readonly number[]): { minimum: number; maximum: number } {
  validateGrid(nodes);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const spacing = nodes[index] - nodes[index - 1];
    minimum = Math.min(minimum, spacing);
    maximum = Math.max(maximum, spacing);
  }
  return { minimum, maximum };
}
