import { validateGrid } from "./grids.ts";

export interface InterpolationResult {
  value: number;
  lowerIndex: number;
  upperIndex: number;
  lowerWeight: number;
  upperWeight: number;
  exactNode: boolean;
}

export function interpolateLinear(nodes: readonly number[], values: readonly number[], query: number): InterpolationResult {
  validateGrid(nodes);
  if (values.length !== nodes.length) throw new Error("Interpolation nodes and values must have equal length.");
  if (!Number.isFinite(query)) throw new Error("Interpolation query must be finite.");
  if (query < nodes[0] || query > nodes[nodes.length - 1]) throw new Error("Interpolation query lies outside the grid; extrapolation is disabled.");

  let low = 0;
  let high = nodes.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (nodes[middle] === query) {
      return { value: values[middle], lowerIndex: middle, upperIndex: middle, lowerWeight: 1, upperWeight: 0, exactNode: true };
    }
    if (nodes[middle] < query) low = middle + 1;
    else high = middle - 1;
  }

  const lowerIndex = high;
  const upperIndex = low;
  const upperWeight = (query - nodes[lowerIndex]) / (nodes[upperIndex] - nodes[lowerIndex]);
  const lowerWeight = 1 - upperWeight;
  return {
    value: lowerWeight * values[lowerIndex] + upperWeight * values[upperIndex],
    lowerIndex,
    upperIndex,
    lowerWeight,
    upperWeight,
    exactNode: false,
  };
}
