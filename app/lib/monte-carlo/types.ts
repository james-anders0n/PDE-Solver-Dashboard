import type { Measure, ModelKey } from "../pde-spec.ts";

export type MonteCarloDiagnosticValue = number | string | boolean;
export type VarianceReductionMethod = "none" | "antithetic";

export interface BaseMonteCarloConfig<
  TModel extends ModelKey,
  TScheme extends string,
> {
  model: TModel;
  enabled: boolean;
  paths: number;
  timeSteps: number;
  seed: number;
  scheme: TScheme;
  displayPathLimit: number;
  quantileLevels: readonly number[];
  varianceReduction?: VarianceReductionMethod;
}

export type BlackScholesMonteCarloConfig = BaseMonteCarloConfig<
  "Black–Scholes",
  "exact-gbm"
>;

export type HestonMonteCarloConfig = BaseMonteCarloConfig<
  "Heston",
  "full-truncation-euler" | "andersen-qe"
>;

export type ShortRateMonteCarloConfig = BaseMonteCarloConfig<
  "Vasicek" | "Hull–White",
  "exact-gaussian"
>;

export type MertonMonteCarloConfig = BaseMonteCarloConfig<
  "HJB",
  "feedback-policy-euler"
>;

export type MonteCarloConfig =
  | BlackScholesMonteCarloConfig
  | HestonMonteCarloConfig
  | ShortRateMonteCarloConfig
  | MertonMonteCarloConfig;

export interface SampleSummary {
  count: number;
  mean: number;
  variance: number;
  standardDeviation: number;
  minimum: number;
  maximum: number;
  quantiles: Record<string, number>;
}

export interface EstimateSummary {
  mean: number;
  standardError: number;
  confidence95: readonly [number, number];
}

/**
 * A summary of one simulated state variable over time. Full simulations may
 * retain only a deterministic subset of paths while using every path for the
 * means and quantiles.
 */
export interface StatePathSummary {
  time: number[];
  displayedPathIndices: number[];
  displayedPaths: number[][];
  meanPath: number[];
  quantiles: Record<string, number[]>;
}

interface BaseMonteCarloResult<
  TModel extends ModelKey,
  TMeasure extends Measure,
  TConfig extends MonteCarloConfig,
  TStateKind extends string,
> {
  model: TModel;
  measure: TMeasure;
  stateKind: TStateKind;
  config: TConfig;
  simulatedPaths: number;
  runtimeMs: number;
  diagnostics: Record<string, MonteCarloDiagnosticValue>;
}

export interface EquityPayoffSummary {
  terminalStock: SampleSummary;
  undiscountedPayoff: SampleSummary;
  discountedValue: EstimateSummary;
}

export interface BlackScholesMonteCarloResult
  extends BaseMonteCarloResult<
    "Black–Scholes",
    "Q",
    BlackScholesMonteCarloConfig,
    "stock"
  > {
  stock: StatePathSummary;
  payoff: EquityPayoffSummary;
}

export interface HestonMonteCarloResult
  extends BaseMonteCarloResult<
    "Heston",
    "Q",
    HestonMonteCarloConfig,
    "stock-and-variance"
  > {
  stock: StatePathSummary;
  variance: StatePathSummary;
  terminalVariance: SampleSummary;
  varianceDiagnostics: HestonVarianceDiagnostics;
  payoff: EquityPayoffSummary;
}

export interface HestonVarianceDiagnostics {
  treatment: "projected full-truncation Euler" | "Andersen QE conditional moment matching";
  rawNegativeVarianceSteps: number;
  correctionFraction: number;
  correctedPaths: number;
  correctedPathFraction: number;
  zeroVarianceSteps: number;
  zeroVarianceStepFraction: number;
  minimumRawVariance: number;
  minimumReturnedVariance: number;
  maximumReturnedVariance: number;
  fellerRatio: number;
  fellerSatisfied: boolean;
  theoreticalTerminalMean: number;
  theoreticalTerminalVariance: number;
  terminalMeanBias: number;
  qePsiCutoff: number;
  qeQuadraticRegimeSteps: number;
  qeQuadraticRegimeFraction: number;
  qeExponentialRegimeSteps: number;
  qeExponentialRegimeFraction: number;
  martingaleCorrection: boolean;
}

export interface ShortRateMonteCarloResult
  extends BaseMonteCarloResult<
    "Vasicek" | "Hull–White",
    "Q",
    ShortRateMonteCarloConfig,
    "short-rate-and-discount-factor"
  > {
  shortRate: StatePathSummary;
  discountFactorPath: StatePathSummary;
  theoreticalShortRateMeanPath: number[];
  theoreticalDiscountFactorMeanPath: number[];
  discountFactorStandardErrorPath: number[];
  terminalShortRate: SampleSummary;
  integratedShortRate: SampleSummary;
  discountFactor: SampleSummary;
  terminalPayoff: SampleSummary;
  discountedPathValue: SampleSummary;
  terminalUnderlyingBond?: SampleSummary;
  discountedValue: EstimateSummary;
  curveReproduction?: ShortRateCurveReproductionPoint[];
}

export interface ShortRateCurveReproductionPoint {
  time: number;
  inputDiscount: number;
  simulatedDiscountMean: number;
  standardError: number;
  standardizedError: number;
}

export interface MertonMonteCarloResult
  extends BaseMonteCarloResult<
    "HJB",
    "P",
    MertonMonteCarloConfig,
    "controlled-wealth"
  > {
  wealth: StatePathSummary;
  policy: StatePathSummary;
  terminalWealth: SampleSummary;
  terminalUtility: SampleSummary;
  expectedUtility: EstimateSummary;
  hjbValue: number;
  analyticValue: number;
  valueDifference: number;
  analyticDifference: number;
  policyDiagnostics: MertonPolicySimulationDiagnostics;
  theoreticalUnconstrainedWealthMeanPath?: number[];
}

export interface MertonPolicySimulationDiagnostics {
  interpolation: "linear in wealth and time-to-maturity; zero risky exposure below the HJB domain; upper policy held constant above the domain";
  timeConvention: "calendar t uses HJB layer tau=T-t";
  wealthStep: "Euler–Maruyama with non-positive proposals projected to the HJB lower boundary";
  minimumAppliedPolicy: number;
  maximumAppliedPolicy: number;
  lowerBoundObservations: number;
  upperBoundObservations: number;
  lowerBoundActivityFraction: number;
  upperBoundActivityFraction: number;
  belowDomainObservations: number;
  aboveDomainObservations: number;
  nonPositiveWealthCorrections: number;
  minimumReturnedWealth: number;
  maximumReturnedWealth: number;
}

/**
 * Tagged by both `model` and `stateKind` so consumers cannot accidentally
 * treat short-rate or controlled-wealth paths as stock paths.
 */
export type MonteCarloResult =
  | BlackScholesMonteCarloResult
  | HestonMonteCarloResult
  | ShortRateMonteCarloResult
  | MertonMonteCarloResult;

export type PricingMonteCarloResult =
  | BlackScholesMonteCarloResult
  | HestonMonteCarloResult
  | ShortRateMonteCarloResult;

export type EquityMonteCarloResult =
  | BlackScholesMonteCarloResult
  | HestonMonteCarloResult;

export type DashboardMonteCarloResult = PricingMonteCarloResult | MertonMonteCarloResult;
