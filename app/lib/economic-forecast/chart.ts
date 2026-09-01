import type { EconomicForecastHistogramBin } from "./types.ts";

export const FORECAST_DENSITY_BOUNDS = {
  width: 1_000,
  height: 100,
  left: 10,
  right: 990,
  top: 8,
  bottom: 92,
} as const;

export interface ForecastDensityPoint {
  x: number;
  y: number;
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));
const roundCoordinate = (value: number) => Math.round(value * 1_000) / 1_000;

export function buildForecastDensityPoints(
  histogram: EconomicForecastHistogramBin[],
  lowerPct: number,
  upperPct: number,
): ForecastDensityPoint[] {
  if (histogram.length === 0) return [];

  const domainWidth = Math.max(upperPct - lowerPct, Number.EPSILON);
  const maxCount = Math.max(...histogram.map((bin) => Number.isFinite(bin.count) ? bin.count : 0), 1);
  const innerWidth = FORECAST_DENSITY_BOUNDS.right - FORECAST_DENSITY_BOUNDS.left;
  const innerHeight = FORECAST_DENSITY_BOUNDS.bottom - FORECAST_DENSITY_BOUNDS.top;

  return histogram.map((bin) => {
    const centrePct = (bin.lowerPct + bin.upperPct) / 2;
    const xRatio = clampUnit((centrePct - lowerPct) / domainWidth);
    const countRatio = clampUnit((Number.isFinite(bin.count) ? bin.count : 0) / maxCount);

    return {
      x: roundCoordinate(FORECAST_DENSITY_BOUNDS.left + xRatio * innerWidth),
      y: roundCoordinate(FORECAST_DENSITY_BOUNDS.bottom - countRatio * innerHeight),
    };
  });
}
