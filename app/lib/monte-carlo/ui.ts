export const MONTE_CARLO_PATH_MINIMUM = 100;
export const MONTE_CARLO_PATH_MAXIMUM = 100_000;
export const MONTE_CARLO_STEP_MAXIMUM = 2_000;
export const MONTE_CARLO_DISPLAY_PATH_LIMIT = 100;
export const MONTE_CARLO_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95] as const;

export interface MonteCarloControlValues {
  enabled: boolean;
  eligible: boolean;
  paths: string;
  timeSteps: string;
  seed: string;
  requiresEvenPaths?: boolean;
}

export function validateMonteCarloControls(values: MonteCarloControlValues): string[] {
  if (!values.enabled) return [];
  const issues: string[] = [];
  const requestedPaths = Number(values.paths);
  const requestedSteps = Number(values.timeSteps);
  const requestedSeed = Number(values.seed);
  if (!values.eligible) issues.push("Monte Carlo is available for supported equity and short-rate contracts and for the Merton HJB feedback-policy evaluation.");
  if (!Number.isInteger(requestedPaths) || requestedPaths < MONTE_CARLO_PATH_MINIMUM || requestedPaths > MONTE_CARLO_PATH_MAXIMUM) {
    issues.push(`Monte Carlo paths must be an integer from ${MONTE_CARLO_PATH_MINIMUM.toLocaleString()} to ${MONTE_CARLO_PATH_MAXIMUM.toLocaleString()}.`);
  } else if (values.requiresEvenPaths && requestedPaths % 2 !== 0) {
    issues.push("Heston antithetic variance reduction requires an even Monte Carlo path count.");
  }
  if (!Number.isInteger(requestedSteps) || requestedSteps < 1 || requestedSteps > MONTE_CARLO_STEP_MAXIMUM) {
    issues.push(`Monte Carlo simulation steps must be an integer from 1 to ${MONTE_CARLO_STEP_MAXIMUM.toLocaleString()}.`);
  }
  if (!Number.isInteger(requestedSeed) || requestedSeed < 0 || requestedSeed > 0xffff_ffff) {
    issues.push("Monte Carlo seed must be an integer from 0 to 4,294,967,295.");
  }
  return issues;
}

export function isMonteCarloResultTabAvailable(eligible: boolean, hasCompletedResult: boolean): boolean {
  return eligible && hasCompletedResult;
}
