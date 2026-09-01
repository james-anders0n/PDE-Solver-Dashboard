import type { Measure, ModelKey } from "@/app/lib/pde-spec";
import type { EconomicBridgeInput } from "@/app/lib/economic-bridge";

export type AppWorkspace = "market-data" | "economic-forecast" | "solver-studio" | "results";
export type MarketProvider = "yfinance" | "FRED" | "manual" | "fixture";
export type DataClassification = "observed" | "derived" | "calibrated" | "scenario" | "proxy" | "manual";
export type FreshnessState = "current" | "stale" | "partial" | "failed" | "fixture";
export type ValueUnit = "decimal" | "percent" | "price" | "variance" | "years" | "identifier";
export type CompoundingConvention = "continuous" | "simple" | "annual" | "not-applicable";

export interface ProviderObservation {
  provider: MarketProvider;
  identifier: string;
  value: number | string | null;
  observationTimestamp: string;
  availableTimestamp: string;
  fetchedTimestamp: string;
  vintage?: string;
  unit: ValueUnit;
  currency?: string;
}

export interface TransformationProvenance {
  provider: MarketProvider;
  sourceIdentifiers: string[];
  observationTimestamp: string;
  availableTimestamp: string;
  fetchedTimestamp: string;
  vintage?: string;
  formula: string;
  financialInterpretation: string;
  measure: Measure;
  unit: ValueUnit;
  compounding: CompoundingConvention;
  stalenessPolicy: string;
}

export interface ParameterProposal {
  id: string;
  label: string;
  symbol: string;
  currentValue: string;
  proposedValue: string;
  classification: DataClassification;
  selected: boolean;
  applicable: boolean;
  warning?: string;
  bounds?: [number, number];
  calibrationRole?: "dependency" | "seed" | "calibrated";
  provenance: TransformationProvenance;
}

export interface MarketVisualPoint {
  x: number;
  y: number;
  lower?: number;
  upper?: number;
  secondary?: number;
  label?: string;
  excluded?: boolean;
  selected?: boolean;
  providerValue?: number;
  rejectionReason?: string;
}

export interface MarketVisualSeries {
  id: string;
  label: string;
  classification: DataClassification;
  points: MarketVisualPoint[];
}

export interface ProviderHealth {
  provider: MarketProvider;
  state: FreshnessState;
  message: string;
}

export interface MarketDataRequest {
  model: ModelKey;
  instrument: string;
  asOfDate: string;
  currency: string;
  fredSeries: string;
  historyWindow: string;
  measureMode: Measure;
  sourceMode: "fixture" | "live";
  optionExpiration: string;
  optionView: "combined" | "calls" | "puts";
  atmMethod: "forward-log-moneyness";
  maximumRelativeSpread: number;
  minimumOpenInterest: number;
  dividendMethod: "parity" | "distributions" | "manual";
  hestonExpirationStart: string;
  hestonExpirationEnd: string;
  hestonMoneynessMinimum: number;
  hestonMoneynessMaximum: number;
  hestonMinimumStrikes: number;
  hestonMinimumExpiries: number;
  hestonObjective: "price" | "iv";
  hestonUseOpenInterest: boolean;
  hestonCalibrationSeed: number;
  hestonMultiStarts: number;
  hestonMaximumEvaluations: number;
  hestonIncludeVix: boolean;
  vasicekWindowStart: string;
  vasicekWindowEnd: string;
  vasicekSampling: "daily" | "weekly";
  vasicekMissingPolicy: "previous-valid" | "drop-gaps";
  vasicekOutlierPolicy: "none" | "remove-3sigma" | "winsorize-3sigma";
  vasicekMinimumObservations: number;
  vasicekMeasureMode: "historical-p" | "q-curve";
  vasicekIncludeEtfs: boolean;
  hullWhiteCurveMode: "treasury-proxy" | "bootstrap";
  hullWhiteCurveFamily: "treasury" | "sofr-treasury";
  hullWhiteSelectedSeries: string[];
  hullWhiteInterpolation: "natural-cubic-log-discount";
  hullWhiteIncludeEtfOptions: boolean;
  hullWhiteMaximumQuoteAgeDays: number;
  hjbHistorySessions: 252 | 504 | 756 | 1260;
  hjbEstimator: "shrinkage" | "arithmetic" | "ewma";
  hjbShrinkageWeight: number;
  hjbEquityRiskPremiumPrior: number;
  hjbEwmaHalfLifeSessions: number;
  hjbVolatilityWindow: 20 | 60 | 126 | 252;
  hjbOpportunityRateSeries: "SOFR" | "DFF";
  hjbRegimeSeries: Array<"VIXCLS" | "T10Y2Y">;
  hjbUsdRateProxyMode: boolean;
}

export interface MertonReturnEstimate {
  estimator: "arithmetic" | "ewma" | "shrinkage";
  value: number;
  lower: number;
  upper: number;
  standardError: number;
  historicalWeight?: number;
  prior?: number;
}

export interface MertonAllocationPreview {
  id: "base" | "baseline" | "expansion" | "defensive" | "stress";
  label: string;
  probability: number | null;
  probabilityInterval: [number, number] | null;
  expectedReturn: number;
  volatility: number;
  rate: number;
  excessReturn: number;
  unconstrainedAllocation: number;
  appliedAllocation: number;
  allocationInterval: [number, number];
  binding: "lower" | "upper" | "none";
}

export interface MertonOpportunitySnapshotDetails {
  snapshotId: string;
  estimatorVersion: string;
  mappingVersion: string;
  historyInterval: [string, string];
  historySessionsRequested: number;
  historySessionsRetained: number;
  calendar: { timezone: string; convention: string; missingWeekdaySessions: string[] };
  adjustments: { method: string; dividendEvents: number; splitEvents: number };
  returns: Array<{ date: string; adjustedClose: number; logReturn: number; simpleReturn: number }>;
  returnEstimates: {
    arithmetic: MertonReturnEstimate;
    ewma: MertonReturnEstimate;
    shrinkage: MertonReturnEstimate;
    selected: "arithmetic" | "ewma" | "shrinkage";
  };
  realisedVolatility: Record<"20" | "60" | "126" | "252", number | null>;
  selectedVolatilityWindow: 20 | 60 | 126 | 252;
  opportunityRate: { seriesId: "SOFR" | "DFF"; value: number; date: string; availableDate: string; realtimeStart: string; realtimeEnd: string; proxy: boolean };
  regimeObservations: Array<{ seriesId: "VIXCLS" | "T10Y2Y"; value: number; date: string; availableDate: string; realtimeStart: string; realtimeEnd: string }>;
  drawdown: { maximum: number; peakDate: string; troughDate: string };
  tails: { dailyVar95: number; dailyExpectedShortfall95: number; skewness: number; excessKurtosis: number };
  bridgeInput: EconomicBridgeInput;
  previewControls: { wealth: number; riskAversion: number; controlMin: number; controlMax: number };
  allocationPreviews: MertonAllocationPreview[];
  instabilityWarnings: string[];
}

export interface HullWhiteCurvePillar {
  seriesId: string;
  tenorLabel: string;
  time: number;
  rawQuote: number;
  rawUnit: "percent";
  quoteDate: string;
  realtimeStart: string;
  realtimeEnd: string;
  availableTimestamp: string;
  normalizedRate: number;
  discount: number;
  reproductionError: number;
  constructionInstrument: "overnight-deposit" | "treasury-bill-proxy" | "treasury-par-yield-proxy";
  dayCount: "ACT/360" | "ACT/365F";
  compounding: "simple" | "semiannual" | "continuous-approximation";
  adjustment?: string;
}

export interface HullWhiteEtfOptionProxy {
  symbol: "SHY" | "IEF" | "TLT";
  expiration: string;
  contractSymbol: string;
  optionType: "call" | "put";
  strike: number;
  impliedVolatility: number;
  openInterest: number;
  classification: "rate-volatility-scenario-proxy";
  warning: string;
}

export interface HullWhiteCurveSnapshotDetails {
  snapshotId: string;
  curve: { id: string; pillars: Array<{ time: number; discount: number }> };
  mode: "treasury-proxy" | "bootstrap";
  family: "treasury" | "sofr-treasury";
  currency: "USD";
  asOfDate: string;
  interpolation: "natural-cubic-log-discount";
  proxyStatus: "PROXY";
  sourceSeries: string[];
  missingSeries: string[];
  frontSeries: string;
  frontRate: number;
  maximumFitErrorBasisPoints: number;
  maximumQuoteAgeDays: number;
  pillars: HullWhiteCurvePillar[];
  theta: Array<{ time: number; value: number }>;
  etfOptionProxies: HullWhiteEtfOptionProxy[];
  constructionNotes: string[];
}

export interface VasicekPreparedPoint {
  date: string;
  value: number;
  source: "observed" | "carried" | "winsorized";
  excluded: boolean;
  exclusionReason?: string;
}

export interface VasicekParameterInterval {
  estimate: number;
  lower: number;
  upper: number;
  standardError: number;
}

export interface VasicekHistoricalEstimate {
  measure: "P";
  estimatorVersion: string;
  window: [string, string];
  sampling: "daily" | "weekly";
  missingPolicy: "previous-valid" | "drop-gaps";
  outlierPolicy: "none" | "remove-3sigma" | "winsorize-3sigma";
  sampleIntervalYears: number;
  observations: number;
  transitions: number;
  parameters: { meanReversion: number; longRunRate: number; rateVolatility: number };
  intervals: {
    meanReversion: VasicekParameterInterval;
    longRunRate: VasicekParameterInterval;
    rateVolatility: VasicekParameterInterval;
  };
  residuals: number[];
  residualDiagnostics: {
    mean: number;
    standardDeviation: number;
    skewness: number;
    excessKurtosis: number;
    lag1Autocorrelation: number;
    jarqueBera: number;
  };
}

export interface VasicekQCalibrationResult {
  measure: "Q";
  method: "cross-sectional-zero-coupon-calibration";
  parameters: { meanReversion: number; longRunRate: number; rateVolatility: number };
  bounds: {
    meanReversion: [number, number];
    longRunRate: [number, number];
    rateVolatility: [number, number];
  };
  objective: number;
  maximumError: number;
  evaluations: number;
  instruments: Array<{ id: string; maturity: number; marketPrice: number; modelPrice: number; error: number }>;
  completedAt: string;
}

export interface VasicekEtfOverlay {
  symbol: "SHY" | "IEF" | "TLT";
  proxyLabel: "PROXY";
  durationBand: "short" | "intermediate" | "long";
  points: Array<{ date: string; normalizedValue: number }>;
}

export interface VasicekSnapshotDetails {
  series: "SOFR" | "DFF";
  snapshotId: string;
  vintage: string;
  availabilityTimestamp: string;
  latestObservation: { date: string; value: number };
  preparedPoints: VasicekPreparedPoint[];
  removedObservations: Array<{ date: string; value: number; reason: string }>;
  pEstimate: VasicekHistoricalEstimate;
  qCalibration?: VasicekQCalibrationResult;
  etfOverlays: VasicekEtfOverlay[];
  requestedMeasureMode: "historical-p" | "q-curve";
}

export interface HestonSurfaceInstrument {
  contractSymbol: string;
  optionType: "call" | "put";
  expiration: string;
  strike: number;
  maturity: number;
  forward: number;
  logMoneyness: number;
  rate: number;
  dividend: number;
  bid: number;
  ask: number;
  mid: number;
  marketImpliedVolatility: number | null;
  bidImpliedVolatility: number | null;
  askImpliedVolatility: number | null;
  providerImpliedVolatility?: number;
  openInterest: number;
  lastTradeTimestamp?: string;
  weight: number;
  excluded: boolean;
  rejectionReason?: string;
}

export interface EquityOptionQuoteInstrument {
  contractSymbol: string;
  optionType: "call" | "put";
  expiration: string;
  strike: number;
  maturity: number;
  bid: number;
  ask: number;
  mid: number;
  relativeSpread: number;
  openInterest: number;
  lastTradeTimestamp?: string;
}

export interface HestonCalibrationParameters {
  v0: number;
  kappa: number;
  theta: number;
  xi: number;
  rho: number;
}

export interface HestonCalibrationResult {
  parameters: HestonCalibrationParameters;
  objective: "price" | "iv";
  objectiveValue: number;
  weightedRmse: number;
  maximumError: number;
  evaluations: number;
  converged: boolean;
  bounds: Record<keyof HestonCalibrationParameters, [number, number]>;
  fellerRatio: number;
  startedAt: string;
  completedAt: string;
  residuals: Array<{
    contractSymbol: string;
    expiration: string;
    logMoneyness: number;
    marketValue: number;
    modelValue: number;
    error: number;
  }>;
  expirySummaries: Array<{ expiration: string; instruments: number; weightedRmse: number; maximumError: number }>;
}

export interface HestonSnapshotDetails {
  surfaceId: string;
  spotTimestamp: string;
  timezone: string;
  availableExpirations: string[];
  retainedExpirations: string[];
  expirationRange: [string, string];
  moneynessBounds: [number, number];
  coverage: { minimumExpiries: number; minimumStrikes: number; expiries: number; strikesByExpiry: Record<string, number> };
  rates: Array<{ expiration: string; maturity: number; value: number; mode: "treasury-proxy" | "manual-fallback"; sourceSeries: string[]; observationDates: string[] }>;
  dividend: { method: "parity" | "distributions" | "manual"; value: number; parityEstimates: number[]; distributionEstimate: number | null };
  vix?: { value: number; date: string; classification: "regime-prior" | "diagnostic" };
  seeds: HestonCalibrationParameters;
  seedRationale: Record<keyof HestonCalibrationParameters, string>;
  instruments: HestonSurfaceInstrument[];
  calibrationSettings: {
    objective: "price" | "iv";
    useOpenInterest: boolean;
    seed: number;
    multiStarts: number;
    maximumEvaluations: number;
  };
  calibration?: HestonCalibrationResult;
}

export interface BlackScholesSnapshotDetails {
  expiration: string;
  availableExpirations: string[];
  spotTimestamp: string;
  timezone: string;
  forward: number;
  atmStrike: number | null;
  atmContractSymbol: string | null;
  atmMethod: "forward-log-moneyness";
  optionView: "combined" | "calls" | "puts";
  instruments: EquityOptionQuoteInstrument[];
  quoteFilter: {
    maximumRelativeSpread: number;
    minimumOpenInterest: number;
    retained: number;
    excluded: number;
  };
  rate: {
    value: number;
    mode: "treasury-proxy" | "manual-fallback";
    sourceSeries: string[];
    observationDates: string[];
  };
  dividend: {
    selectedMethod: "parity" | "distributions" | "manual";
    parityEstimate: number | null;
    distributionEstimate: number | null;
    matchedPairs: number;
  };
  volatility: {
    selectedImpliedVolatility: number | null;
    providerImpliedVolatility: number | null;
    realised20: number | null;
    realised60: number | null;
    realised252: number | null;
    method: "bid-ask-mid inversion";
  };
}

export interface MarketSnapshot {
  id: string;
  model: ModelKey;
  workspaceLabel: string;
  instrument: string;
  currency: string;
  asOfDate: string;
  createdAt: string;
  freshness: FreshnessState;
  freshnessMessage: string;
  sourceMode: "fixture" | "live";
  measure: Measure;
  providerHealth: ProviderHealth[];
  observations: ProviderObservation[];
  proposals: ParameterProposal[];
  primaryTitle: string;
  primarySummary: string;
  primarySeries: MarketVisualSeries[];
  secondaryTitle: string;
  secondarySummary: string;
  secondarySeries: MarketVisualSeries[];
  diagnostics: Array<{ label: string; value: string; status?: FreshnessState }>;
  validationIssues: string[];
  warnings: string[];
  blackScholes?: BlackScholesSnapshotDetails;
  heston?: HestonSnapshotDetails;
  vasicek?: VasicekSnapshotDetails;
  hullWhite?: HullWhiteCurveSnapshotDetails;
  mertonOpportunity?: MertonOpportunitySnapshotDetails;
}

export interface VasicekHistoricalScenario {
  id: string;
  snapshotId: string;
  createdAt: string;
  measure: "P";
  series: "SOFR" | "DFF";
  vintage: string;
  estimatorVersion: string;
  window: [string, string];
  sampling: "daily" | "weekly";
  parameters: { meanReversion: number; longRunRate: number; rateVolatility: number };
  intervals: VasicekHistoricalEstimate["intervals"];
}

export interface MarketDataAdapter {
  model: ModelKey;
  workspaceLabel: string;
  preview(request: MarketDataRequest, currentParameters: Record<string, string>): Promise<MarketSnapshot>;
}

export interface AppliedSnapshotHistory {
  id: string;
  snapshot: MarketSnapshot;
  appliedAt: string;
  previousParameters: Record<string, string>;
  appliedParameters: Record<string, string>;
  selectedParameterIds: string[];
  excludedParameterIds: string[];
  associatedSolverRunIds: string[];
  restoredAt?: string;
}

export interface ApplySnapshotResult {
  parameters: Record<string, string>;
  history: AppliedSnapshotHistory;
}
