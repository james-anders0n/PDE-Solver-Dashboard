import type {
  HestonMonteCarloResult,
  DashboardMonteCarloResult,
  ShortRateMonteCarloResult,
  MertonMonteCarloResult,
  StatePathSummary,
} from "./types.ts";

export type MonteCarloCsvCell = string | number;

export const MONTE_CARLO_CSV_COLUMNS = [
  "record_type",
  "model",
  "state",
  "secondary_state",
  "finite_difference",
  "benchmark",
  "time",
  "path_index",
  "statistic",
  "monte_carlo_value",
] as const;

export function createMonteCarloManifest(result?: DashboardMonteCarloResult | null) {
  if (!result) return null;
  if (result.stateKind === "controlled-wealth") {
    return {
      enabled: true,
      model: result.model,
      measure: result.measure,
      stateKind: result.stateKind,
      config: result.config,
      simulatedPaths: result.simulatedPaths,
      runtimeMs: result.runtimeMs,
      expectedUtility: result.expectedUtility,
      terminalWealth: result.terminalWealth,
      terminalUtility: result.terminalUtility,
      hjbValue: result.hjbValue,
      analyticValue: result.analyticValue,
      valueDifference: result.valueDifference,
      analyticDifference: result.analyticDifference,
      policyDiagnostics: result.policyDiagnostics,
      diagnostics: result.diagnostics,
    };
  }
  if (result.stateKind === "short-rate-and-discount-factor") {
    return {
      enabled: true,
      model: result.model,
      measure: result.measure,
      stateKind: result.stateKind,
      config: result.config,
      simulatedPaths: result.simulatedPaths,
      runtimeMs: result.runtimeMs,
      discountedValue: result.discountedValue,
      terminalShortRate: result.terminalShortRate,
      integratedShortRate: result.integratedShortRate,
      discountFactor: result.discountFactor,
      terminalPayoff: result.terminalPayoff,
      discountedPathValue: result.discountedPathValue,
      terminalUnderlyingBond: result.terminalUnderlyingBond,
      curveReproduction: result.curveReproduction,
      diagnostics: result.diagnostics,
    };
  }
  return {
    enabled: true,
    model: result.model,
    measure: result.measure,
    stateKind: result.stateKind,
    config: result.config,
    simulatedPaths: result.simulatedPaths,
    runtimeMs: result.runtimeMs,
    discountedValue: result.payoff.discountedValue,
    terminalStock: result.payoff.terminalStock,
    undiscountedPayoff: result.payoff.undiscountedPayoff,
    diagnostics: result.diagnostics,
    ...(result.stateKind === "stock-and-variance"
      ? {
          terminalVariance: result.terminalVariance,
          varianceDiagnostics: result.varianceDiagnostics,
        }
      : {}),
  };
}

function row(
  result: DashboardMonteCarloResult,
  recordType: string,
  state: string,
  time: string | number,
  pathIndex: string | number,
  statistic: string,
  value: MonteCarloCsvCell,
): MonteCarloCsvCell[] {
  return [recordType, result.model, state, "", "", "", time, pathIndex, statistic, value];
}

function stateRows(
  result: DashboardMonteCarloResult,
  state: string,
  summary: StatePathSummary,
): MonteCarloCsvCell[][] {
  const rows: MonteCarloCsvCell[][] = [];
  summary.time.forEach((time, index) => {
    rows.push(row(result, "monte-carlo-series", state, time, "", "mean", summary.meanPath[index]));
    Object.entries(summary.quantiles).forEach(([level, values]) => {
      rows.push(row(result, "monte-carlo-series", state, time, "", `quantile-${level}`, values[index]));
    });
  });
  summary.displayedPaths.forEach((path, displayIndex) => {
    path.forEach((value, timeIndex) => {
      rows.push(row(
        result,
        "monte-carlo-path",
        state,
        summary.time[timeIndex],
        summary.displayedPathIndices[displayIndex],
        "displayed-path",
        value,
      ));
    });
  });
  return rows;
}

function configRows(result: DashboardMonteCarloResult): MonteCarloCsvCell[][] {
  return [
    row(result, "monte-carlo-config", "", "", "", "paths", result.config.paths),
    row(result, "monte-carlo-config", "", "", "", "time-steps", result.config.timeSteps),
    row(result, "monte-carlo-config", "", "", "", "seed", result.config.seed),
    row(result, "monte-carlo-config", "", "", "", "scheme", result.config.scheme),
    row(result, "monte-carlo-config", "", "", "", "variance-reduction", result.config.varianceReduction ?? "none"),
    row(result, "monte-carlo-config", "", "", "", "display-path-limit", result.config.displayPathLimit),
    row(result, "monte-carlo-config", "", "", "", "quantile-levels", result.config.quantileLevels.join("|")),
  ];
}

function summaryRows(result: DashboardMonteCarloResult): MonteCarloCsvCell[][] {
  if (result.stateKind === "controlled-wealth") return mertonSummaryRows(result);
  if (result.stateKind === "short-rate-and-discount-factor") return shortRateSummaryRows(result);
  const discounted = result.payoff.discountedValue;
  return [
    row(result, "monte-carlo-summary", "payoff", "", "", "discounted-value", discounted.mean),
    row(result, "monte-carlo-summary", "payoff", "", "", "standard-error", discounted.standardError),
    row(result, "monte-carlo-summary", "payoff", "", "", "confidence-95-lower", discounted.confidence95[0]),
    row(result, "monte-carlo-summary", "payoff", "", "", "confidence-95-upper", discounted.confidence95[1]),
    row(result, "monte-carlo-summary", "stock", "", "", "terminal-mean", result.payoff.terminalStock.mean),
    row(result, "monte-carlo-summary", "payoff", "", "", "undiscounted-mean", result.payoff.undiscountedPayoff.mean),
  ];
}

function mertonSummaryRows(result: MertonMonteCarloResult): MonteCarloCsvCell[][] {
  return [
    row(result, "monte-carlo-summary", "utility", "", "", "expected-utility", result.expectedUtility.mean),
    row(result, "monte-carlo-summary", "utility", "", "", "standard-error", result.expectedUtility.standardError),
    row(result, "monte-carlo-summary", "utility", "", "", "confidence-95-lower", result.expectedUtility.confidence95[0]),
    row(result, "monte-carlo-summary", "utility", "", "", "confidence-95-upper", result.expectedUtility.confidence95[1]),
    row(result, "monte-carlo-summary", "wealth", "", "", "terminal-mean", result.terminalWealth.mean),
    row(result, "monte-carlo-summary", "utility", "", "", "terminal-mean", result.terminalUtility.mean),
    row(result, "monte-carlo-summary", "value", "", "", "hjb-value", result.hjbValue),
    row(result, "monte-carlo-summary", "value", "", "", "analytic-value", result.analyticValue),
    row(result, "monte-carlo-summary", "value", "", "", "monte-carlo-minus-hjb", result.valueDifference),
  ];
}

function shortRateSummaryRows(result: ShortRateMonteCarloResult): MonteCarloCsvCell[][] {
  return [
    row(result, "monte-carlo-summary", "payoff", "", "", "discounted-value", result.discountedValue.mean),
    row(result, "monte-carlo-summary", "payoff", "", "", "standard-error", result.discountedValue.standardError),
    row(result, "monte-carlo-summary", "payoff", "", "", "confidence-95-lower", result.discountedValue.confidence95[0]),
    row(result, "monte-carlo-summary", "payoff", "", "", "confidence-95-upper", result.discountedValue.confidence95[1]),
    row(result, "monte-carlo-summary", "short-rate", "", "", "terminal-mean", result.terminalShortRate.mean),
    row(result, "monte-carlo-summary", "integrated-short-rate", "", "", "terminal-mean", result.integratedShortRate.mean),
    row(result, "monte-carlo-summary", "discount-factor", "", "", "terminal-mean", result.discountFactor.mean),
    row(result, "monte-carlo-summary", "terminal-payoff", "", "", "mean", result.terminalPayoff.mean),
    row(result, "monte-carlo-summary", "discounted-path-value", "", "", "mean", result.discountedPathValue.mean),
    ...(result.terminalUnderlyingBond
      ? [row(result, "monte-carlo-summary", "underlying-bond", "", "", "terminal-mean", result.terminalUnderlyingBond.mean)]
      : []),
  ];
}

function hestonDiagnosticRows(result: HestonMonteCarloResult): MonteCarloCsvCell[][] {
  return Object.entries(result.varianceDiagnostics).map(([statistic, value]) =>
    row(result, "monte-carlo-diagnostic", "variance", "", "", statistic, String(value)));
}

function diagnosticRows(result: DashboardMonteCarloResult): MonteCarloCsvCell[][] {
  return Object.entries(result.diagnostics).map(([statistic, value]) =>
    row(result, "monte-carlo-diagnostic", "simulation", "", "", statistic, String(value)));
}

export function createMonteCarloCsvRows(result?: DashboardMonteCarloResult | null): MonteCarloCsvCell[][] {
  if (!result) return [];
  const rows = [
    ...configRows(result),
    ...summaryRows(result),
    ...diagnosticRows(result),
  ];
  if (result.stateKind === "controlled-wealth") {
    rows.push(
      ...stateRows(result, "wealth", result.wealth),
      ...stateRows(result, "policy", result.policy),
      ...Object.entries(result.policyDiagnostics).map(([statistic, value]) =>
        row(result, "monte-carlo-diagnostic", "policy", "", "", statistic, String(value))),
      ...(result.theoreticalUnconstrainedWealthMeanPath ?? []).map((value, index) => row(
        result,
        "monte-carlo-series",
        "wealth",
        result.wealth.time[index],
        "",
        "theoretical-unconstrained-mean",
        value,
      )),
    );
    return rows;
  }
  if (result.stateKind === "short-rate-and-discount-factor") {
    rows.push(
      ...stateRows(result, "short-rate", result.shortRate),
      ...stateRows(result, "discount-factor", result.discountFactorPath),
      ...result.shortRate.time.map((time, index) => row(
        result,
        "monte-carlo-series",
        "short-rate",
        time,
        "",
        "theoretical-mean",
        result.theoreticalShortRateMeanPath[index],
      )),
      ...result.discountFactorPath.time.map((time, index) => row(
        result,
        "monte-carlo-series",
        "discount-factor",
        time,
        "",
        "theoretical-mean",
        result.theoreticalDiscountFactorMeanPath[index],
      )),
      ...(result.curveReproduction ?? []).flatMap((point) => [
        row(result, "monte-carlo-curve-fit", "discount-factor", point.time, "", "input-discount", point.inputDiscount),
        row(result, "monte-carlo-curve-fit", "discount-factor", point.time, "", "simulated-mean", point.simulatedDiscountMean),
        row(result, "monte-carlo-curve-fit", "discount-factor", point.time, "", "standard-error", point.standardError),
        row(result, "monte-carlo-curve-fit", "discount-factor", point.time, "", "standardized-error", point.standardizedError),
      ]),
    );
    return rows;
  }
  rows.push(...stateRows(result, "stock", result.stock));
  if (result.stateKind === "stock-and-variance") {
    rows.push(
      ...stateRows(result, "variance", result.variance),
      ...hestonDiagnosticRows(result),
    );
  }
  return rows;
}
