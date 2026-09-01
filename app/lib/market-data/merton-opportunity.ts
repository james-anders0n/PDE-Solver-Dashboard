import { buildEconomicBridge, type EconomicBridgeInput, type EconomicRegime } from "../economic-bridge.ts";
import { mertonAnalyticPolicy } from "../pde-engine/merton-hjb.ts";
import type { NormalizedFredObservation } from "./fred-client.ts";
import type { YFinanceHistoryPoint, YFinanceQuote } from "./yfinance-client.ts";
import type {
  MarketDataRequest,
  MarketSnapshot,
  MertonAllocationPreview,
  MertonOpportunitySnapshotDetails,
  MertonReturnEstimate,
  ParameterProposal,
  TransformationProvenance,
} from "./types.ts";

export const MERTON_OPPORTUNITY_ESTIMATOR_VERSION = "merton-opportunity-set-1.0.0";
export const MERTON_ECONOMIC_BRIDGE_MAPPING_VERSION = "hjb-opportunity-regime-1.0.0";
const TRADING_SESSIONS = 252;
const DAY_MS = 86_400_000;

export interface MertonOpportunityInput {
  request: MarketDataRequest;
  currentParameters: Record<string, string>;
  quote?: YFinanceQuote;
  history: YFinanceHistoryPoint[];
  historyCurrency?: string;
  fred: NormalizedFredObservation[];
  providerErrors?: string[];
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const dateShift = (value: string, days: number) => new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const addTwelveMonths = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
};
const timestamp = (date: string) => `${date}T23:00:00Z`;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function sampleStandardDeviation(values: number[]): number {
  if (values.length < 2) return Number.NaN;
  const centre = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (values.length - 1));
}

function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] + weight * (sorted[upper] - sorted[lower]);
}

function higherMoments(values: number[]): { skewness: number; excessKurtosis: number } {
  const centre = mean(values);
  const standardDeviation = sampleStandardDeviation(values);
  if (!(standardDeviation > 0)) return { skewness: 0, excessKurtosis: 0 };
  const z = values.map((value) => (value - centre) / standardDeviation);
  return {
    skewness: mean(z.map((value) => value ** 3)),
    excessKurtosis: mean(z.map((value) => value ** 4)) - 3,
  };
}

function weekdayDatesBetween(start: string, end: string): string[] {
  const values: string[] = [];
  for (let time = Date.parse(`${start}T00:00:00Z`) + DAY_MS; time < Date.parse(`${end}T00:00:00Z`); time += DAY_MS) {
    const date = new Date(time);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) values.push(date.toISOString().slice(0, 10));
  }
  return values;
}

function estimateAnnualMean(dailySimpleReturns: number[], halfLife: number): { arithmetic: number; ewma: number; standardError: number } {
  const arithmetic = mean(dailySimpleReturns) * TRADING_SESSIONS;
  const decay = Math.exp(-Math.log(2) / halfLife);
  let weightedSum = 0;
  let weightTotal = 0;
  dailySimpleReturns.forEach((value, index) => {
    const age = dailySimpleReturns.length - 1 - index;
    const weight = decay ** age;
    weightedSum += weight * value;
    weightTotal += weight;
  });
  const ewma = weightedSum / weightTotal * TRADING_SESSIONS;
  const standardError = sampleStandardDeviation(dailySimpleReturns) / Math.sqrt(dailySimpleReturns.length) * TRADING_SESSIONS;
  return { arithmetic, ewma, standardError };
}

function returnEstimate(estimator: MertonReturnEstimate["estimator"], value: number, standardError: number, extras: Partial<MertonReturnEstimate> = {}): MertonReturnEstimate {
  const halfWidth = 1.959963984540054 * standardError;
  return { estimator, value, standardError, lower: value - halfWidth, upper: value + halfWidth, ...extras };
}

function previousAvailableObservation(
  observations: NormalizedFredObservation[],
  seriesId: string,
  asOfDate: string,
): (NormalizedFredObservation & { availableDate: string }) | undefined {
  return observations
    .filter((item) => item.seriesId === seriesId)
    .map((item) => ({ ...item, availableDate: item.availableDate ?? dateShift(item.date, 1) }))
    .filter((item) => item.date <= asOfDate && item.availableDate <= asOfDate)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
}

function softmax(scores: number[]): number[] {
  const maximum = Math.max(...scores);
  const exponentials = scores.map((score) => Math.exp(score - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

function regimeDefinitions(
  asOfDate: string,
  latest: Map<string, NormalizedFredObservation & { availableDate: string }>,
): EconomicRegime[] {
  const vix = latest.get("VIXCLS")?.value ?? 20;
  const spread = latest.get("T10Y2Y")?.value ?? 0;
  const lowVolatility = clamp((22 - vix) / 12, 0, 1);
  const highVolatility = clamp((vix - 16) / 20, 0, 1);
  const positiveSlope = clamp(spread / 2, 0, 1);
  const inversion = clamp(-spread / 2, 0, 1);
  const probabilities = softmax([
    1.15 - 0.35 * Math.abs(vix - 20) / 10 - 0.2 * Math.abs(spread),
    0.35 + 1.25 * lowVolatility + 0.9 * positiveSlope,
    0.3 + 0.9 * highVolatility + 0.95 * inversion,
    -0.1 + 1.7 * highVolatility + 1.45 * inversion,
  ]);
  const observed = [...latest.values()].map((item) => item.date).sort().at(-1) ?? asOfDate;
  const available = [...latest.values()].map((item) => item.availableDate).sort().at(-1) ?? asOfDate;
  const vintage = [...latest.values()].map((item) => item.realtimeStart).sort().at(-1) ?? asOfDate;
  const specifications = [
    ["baseline", "Baseline", 0, 1, 0],
    ["expansion", "Expansion", 0.02, 0.85, 0.0025],
    ["defensive", "Defensive", -0.025, 1.2, -0.005],
    ["stress", "Stress", -0.08, 1.55, -0.015],
  ] as const;
  return specifications.map(([id, label, expectedReturnAdjustment, volatilityMultiplier, rateShift], index) => {
    const probability = probabilities[index];
    const uncertaintyWidth = id === "stress" ? 0.1 : 0.08;
    return {
      id,
      label,
      probability,
      uncertainty: {
        lower: Math.max(0, probability - uncertaintyWidth),
        upper: Math.min(1, probability + uncertaintyWidth),
        confidenceLevel: 0.8,
        method: "VIXCLS and T10Y2Y softmax-score interval",
      },
      expectedReturnAdjustment,
      volatilityMultiplier,
      rateShift,
      observationTimestamp: timestamp(observed),
      availableTimestamp: timestamp(available),
      dataVintage: vintage,
      sourceModel: "Opportunity Regime Bridge",
      sourceModelVersion: MERTON_ECONOMIC_BRIDGE_MAPPING_VERSION,
    };
  });
}

function previewAllocation(options: {
  id: MertonAllocationPreview["id"];
  label: string;
  probability: number | null;
  probabilityInterval: [number, number] | null;
  expectedReturn: number;
  expectedReturnInterval: [number, number];
  volatility: number;
  volatilityInterval: [number, number];
  rate: number;
  wealth: number;
  riskAversion: number;
  controlMin: number;
  controlMax: number;
}): MertonAllocationPreview {
  const policy = (expectedReturn: number, volatility: number) => mertonAnalyticPolicy(options.wealth, {
    expectedReturn,
    volatility: Math.max(volatility, 1e-8),
    rate: options.rate,
    riskAversion: options.riskAversion,
  });
  const unconstrainedAllocation = policy(options.expectedReturn, options.volatility);
  const candidates = [
    policy(options.expectedReturnInterval[0], options.volatilityInterval[0]),
    policy(options.expectedReturnInterval[0], options.volatilityInterval[1]),
    policy(options.expectedReturnInterval[1], options.volatilityInterval[0]),
    policy(options.expectedReturnInterval[1], options.volatilityInterval[1]),
  ];
  const appliedAllocation = clamp(unconstrainedAllocation, options.controlMin, options.controlMax);
  return {
    id: options.id,
    label: options.label,
    probability: options.probability,
    probabilityInterval: options.probabilityInterval,
    expectedReturn: options.expectedReturn,
    volatility: options.volatility,
    rate: options.rate,
    excessReturn: options.expectedReturn - options.rate,
    unconstrainedAllocation,
    appliedAllocation,
    allocationInterval: [
      clamp(Math.min(...candidates), options.controlMin, options.controlMax),
      clamp(Math.max(...candidates), options.controlMin, options.controlMax),
    ],
    binding: unconstrainedAllocation < options.controlMin ? "lower" : unconstrainedAllocation > options.controlMax ? "upper" : "none",
  };
}

function provenance(options: {
  provider: "yfinance" | "FRED" | "fixture";
  sources: string[];
  observed: string;
  available: string;
  fetched: string;
  vintage?: string;
  formula: string;
  interpretation: string;
}): TransformationProvenance {
  return {
    provider: options.provider,
    sourceIdentifiers: options.sources,
    observationTimestamp: options.observed,
    availableTimestamp: options.available,
    fetchedTimestamp: options.fetched,
    vintage: options.vintage,
    formula: options.formula,
    financialInterpretation: options.interpretation,
    measure: "P",
    unit: "decimal",
    compounding: "annual",
    stalenessPolicy: options.provider === "FRED" ? "Latest observation available by the common as-of date; point-in-time vintage requested." : "Adjusted history is truncated at the common as-of date.",
  };
}

export function buildMertonOpportunitySnapshot(input: MertonOpportunityInput): MarketSnapshot {
  const { request, currentParameters } = input;
  if (request.model !== "HJB") throw new Error("Merton opportunity-set adapter received the wrong model.");
  if (!request.instrument.trim()) throw new Error("An equity symbol is required.");
  if (!(request.hjbShrinkageWeight >= 0 && request.hjbShrinkageWeight <= 1)) throw new Error("Shrinkage history weight must lie in [0, 1].");
  if (!(request.hjbEwmaHalfLifeSessions > 0)) throw new Error("EWMA half-life must be positive.");
  const instrumentCurrency = (input.quote?.currency ?? input.historyCurrency ?? request.currency).toUpperCase();
  if (instrumentCurrency !== request.currency.toUpperCase()) throw new Error(`Currency mismatch: ${instrumentCurrency} provider instrument versus ${request.currency.toUpperCase()} request.`);
  if (instrumentCurrency !== "USD" && !request.hjbUsdRateProxyMode) throw new Error("Currency mismatch: USD SOFR/DFF cannot be used for a non-USD asset unless explicit proxy mode is selected.");

  const history = input.history
    .filter((item) => item.date <= request.asOfDate && item.adjustedClose > 0 && Number.isFinite(item.adjustedClose))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-(request.hjbHistorySessions + 1));
  if (history.length < 21) throw new Error("At least 20 adjusted return observations are required.");
  const returns = history.slice(1).map((item, index) => {
    const previous = history[index];
    const logReturn = Math.log(item.adjustedClose / previous.adjustedClose);
    return { date: item.date, adjustedClose: item.adjustedClose, logReturn, simpleReturn: Math.expm1(logReturn) };
  });
  const simpleReturns = returns.map((item) => item.simpleReturn);
  const logReturns = returns.map((item) => item.logReturn);
  const meanEstimates = estimateAnnualMean(simpleReturns, request.hjbEwmaHalfLifeSessions);

  const rateObservation = previousAvailableObservation(input.fred, request.hjbOpportunityRateSeries, request.asOfDate);
  if (!rateObservation) throw new Error(`${request.hjbOpportunityRateSeries} has no observation available by the selected as-of date.`);
  const opportunityRate = rateObservation.value / 100;
  const prior = opportunityRate + request.hjbEquityRiskPremiumPrior;
  const arithmeticEstimate = returnEstimate("arithmetic", meanEstimates.arithmetic, meanEstimates.standardError);
  const ewmaEstimate = returnEstimate("ewma", meanEstimates.ewma, meanEstimates.standardError * 1.15);
  const shrinkageStandardError = Math.hypot(request.hjbShrinkageWeight * meanEstimates.standardError, (1 - request.hjbShrinkageWeight) * 0.03);
  const shrinkageEstimate = returnEstimate("shrinkage",
    request.hjbShrinkageWeight * meanEstimates.arithmetic + (1 - request.hjbShrinkageWeight) * prior,
    shrinkageStandardError,
    { historicalWeight: request.hjbShrinkageWeight, prior });
  const estimates = { arithmetic: arithmeticEstimate, ewma: ewmaEstimate, shrinkage: shrinkageEstimate };
  const selectedEstimate = estimates[request.hjbEstimator];

  const volatilityWindows = [20, 60, 126, 252] as const;
  const realisedVolatility = Object.fromEntries(volatilityWindows.map((window) => [String(window), logReturns.length >= window
    ? sampleStandardDeviation(logReturns.slice(-window)) * Math.sqrt(TRADING_SESSIONS)
    : null])) as MertonOpportunitySnapshotDetails["realisedVolatility"];
  const selectedVolatility = realisedVolatility[String(request.hjbVolatilityWindow) as keyof typeof realisedVolatility]
    ?? [...volatilityWindows].reverse().map((window) => realisedVolatility[String(window) as keyof typeof realisedVolatility]).find((value) => value != null)
    ?? sampleStandardDeviation(logReturns) * Math.sqrt(TRADING_SESSIONS);
  if (!(selectedVolatility > 0) || !Number.isFinite(selectedVolatility)) throw new Error("Adjusted history did not produce a finite positive realised volatility.");
  const volatilityStandardError = selectedVolatility / Math.sqrt(2 * Math.max(1, Math.min(logReturns.length, request.hjbVolatilityWindow) - 1));
  const volatilityInterval: [number, number] = [Math.max(1e-6, selectedVolatility - 1.96 * volatilityStandardError), selectedVolatility + 1.96 * volatilityStandardError];

  let peak = history[0].adjustedClose;
  let peakDate = history[0].date;
  let maximumDrawdown = 0;
  let drawdownPeakDate = peakDate;
  let troughDate = peakDate;
  history.forEach((item) => {
    if (item.adjustedClose > peak) {
      peak = item.adjustedClose;
      peakDate = item.date;
    }
    const drawdown = item.adjustedClose / peak - 1;
    if (drawdown < maximumDrawdown) {
      maximumDrawdown = drawdown;
      drawdownPeakDate = peakDate;
      troughDate = item.date;
    }
  });
  const var95 = quantile(simpleReturns, 0.05);
  const tail = simpleReturns.filter((value) => value <= var95);
  const moments = higherMoments(simpleReturns);

  const retainedDates = new Set(history.map((item) => item.date));
  const missingWeekdaySessions = history.slice(1).flatMap((item, index) => weekdayDatesBetween(history[index].date, item.date).filter((date) => !retainedDates.has(date)));
  const latestRegimes = new Map<string, NormalizedFredObservation & { availableDate: string }>();
  request.hjbRegimeSeries.forEach((seriesId) => {
    const observation = previousAvailableObservation(input.fred, seriesId, request.asOfDate);
    if (observation) latestRegimes.set(seriesId, observation);
  });
  const regimes = regimeDefinitions(request.asOfDate, latestRegimes);
  const bridgeInput: EconomicBridgeInput = {
    runAsOfTimestamp: timestamp(request.asOfDate),
    mappingId: "hjb-opportunity-regime",
    mappingVersion: MERTON_ECONOMIC_BRIDGE_MAPPING_VERSION,
    forecasts: [
      {
        id: "opportunity-expected-return", label: `${request.instrument} expected total return`, variable: "equity-return", value: selectedEstimate.value, unit: "decimal",
        uncertainty: { lower: selectedEstimate.lower, upper: selectedEstimate.upper, confidenceLevel: 0.95, method: `${request.hjbEstimator} estimator interval` },
        observationTimestamp: timestamp(history.at(-1)!.date), availableTimestamp: timestamp(history.at(-1)!.date), targetTimestamp: timestamp(addTwelveMonths(history.at(-1)!.date)), forecastHorizonMonths: 12,
        dataVintage: request.asOfDate, sourceModel: "Merton Opportunity Estimator", sourceModelVersion: MERTON_OPPORTUNITY_ESTIMATOR_VERSION,
      },
      {
        id: "opportunity-realised-volatility", label: `${request.instrument} realised volatility`, variable: "realised-volatility", value: selectedVolatility, unit: "decimal",
        uncertainty: { lower: volatilityInterval[0], upper: volatilityInterval[1], confidenceLevel: 0.95, method: "normal approximation to volatility standard error" },
        observationTimestamp: timestamp(history.at(-1)!.date), availableTimestamp: timestamp(history.at(-1)!.date), targetTimestamp: timestamp(addTwelveMonths(history.at(-1)!.date)), forecastHorizonMonths: 12,
        dataVintage: request.asOfDate, sourceModel: "Merton Opportunity Estimator", sourceModelVersion: MERTON_OPPORTUNITY_ESTIMATOR_VERSION,
      },
      {
        id: "opportunity-rate", label: `${request.hjbOpportunityRateSeries} opportunity rate`, variable: "policy-rate", value: opportunityRate, unit: "decimal",
        uncertainty: { lower: opportunityRate - 0.005, upper: opportunityRate + 0.005, confidenceLevel: 0.8, method: "five-basis-point scenario band" },
        observationTimestamp: timestamp(rateObservation.date), availableTimestamp: timestamp(rateObservation.availableDate), targetTimestamp: timestamp(addTwelveMonths(rateObservation.date)), forecastHorizonMonths: 12,
        dataVintage: rateObservation.realtimeStart, sourceModel: "FRED point-in-time observation", sourceModelVersion: "fred-vintage-1.0.0",
      },
    ],
    regimes,
  };
  const bridge = buildEconomicBridge(bridgeInput, "HJB", currentParameters);
  const wealth = Number(currentParameters.wealth);
  const riskAversion = Number(currentParameters.riskAversion);
  const controlMin = Number(currentParameters.controlMin);
  const controlMax = Number(currentParameters.controlMax);
  if (![wealth, riskAversion, controlMin, controlMax].every(Number.isFinite) || wealth <= 0 || riskAversion <= 0 || controlMin >= controlMax) throw new Error("Current HJB wealth, risk aversion, and control bounds must be valid for allocation previews.");
  const basePreview = previewAllocation({
    id: "base", label: "Base", probability: null, probabilityInterval: null,
    expectedReturn: selectedEstimate.value, expectedReturnInterval: [selectedEstimate.lower, selectedEstimate.upper],
    volatility: selectedVolatility, volatilityInterval, rate: opportunityRate, wealth, riskAversion, controlMin, controlMax,
  });
  const allocationPreviews = [basePreview, ...bridge.scenarios.map((scenario) => {
    const expectedTransformation = scenario.transformations.find((item) => item.targetParameter === "expectedReturn")!;
    const volatilityTransformation = scenario.transformations.find((item) => item.targetParameter === "volatility")!;
    return previewAllocation({
      id: scenario.id as MertonAllocationPreview["id"], label: scenario.label, probability: scenario.probability, probabilityInterval: scenario.probabilityInterval,
      expectedReturn: Number(scenario.parameters.expectedReturn), expectedReturnInterval: expectedTransformation.mappedInterval!,
      volatility: Number(scenario.parameters.volatility), volatilityInterval: volatilityTransformation.mappedInterval!, rate: Number(scenario.parameters.rate),
      wealth, riskAversion, controlMin, controlMax,
    });
  })];

  const instabilityWarnings = [
    returns.length < 126 ? `Short sample: only ${returns.length} adjusted return observations are available.` : null,
    selectedEstimate.standardError > 0.1 ? `Expected-return uncertainty is wide (annualized standard error ${(selectedEstimate.standardError * 100).toFixed(1)}%).` : null,
    missingWeekdaySessions.length ? `${missingWeekdaySessions.length} weekday gaps are retained as calendar diagnostics; returns span the available adjusted sessions.` : null,
    latestRegimes.size < request.hjbRegimeSeries.length ? `Unavailable regime inputs were excluded point-in-time; neutral values were used for ${request.hjbRegimeSeries.filter((id) => !latestRegimes.has(id)).join(", ")}.` : null,
  ].filter((item): item is string => Boolean(item));
  const fetched = timestamp(request.asOfDate);
  const historyObserved = timestamp(history.at(-1)!.date);
  const returnProvenance = provenance({ provider: input.quote ? "yfinance" : "fixture", sources: [`${request.instrument}:adjusted-history`, `${request.instrument}:dividends`, `${request.instrument}:actions`], observed: historyObserved, available: historyObserved, fetched, formula: `${request.hjbEstimator} annualized total-return estimator; ${request.hjbShrinkageWeight.toFixed(3)} history weight`, interpretation: "P-measure expected total return with explicit sampling uncertainty; never used as a risk-neutral pricing drift." });
  const volatilityProvenance = provenance({ provider: input.quote ? "yfinance" : "fixture", sources: [`${request.instrument}:adjusted-history`], observed: historyObserved, available: historyObserved, fetched, formula: `${request.hjbVolatilityWindow}-session sample standard deviation of adjusted log returns × √252`, interpretation: "Instrument-specific P-measure realised volatility. VIX remains a separate regime signal." });
  const rateProvenance = provenance({ provider: "FRED", sources: [request.hjbOpportunityRateSeries], observed: timestamp(rateObservation.date), available: timestamp(rateObservation.availableDate), fetched, vintage: rateObservation.realtimeStart, formula: "FRED percent observation ÷ 100", interpretation: request.hjbUsdRateProxyMode ? "Explicit USD opportunity-rate proxy for a non-USD asset." : "USD cash opportunity rate for the P-measure investment problem." });
  const diagnosticProvenance = (formula: string, interpretation: string): TransformationProvenance => ({ ...returnProvenance, formula, financialInterpretation: interpretation });
  const proposals: ParameterProposal[] = [
    { id: "expectedReturn", label: "Expected return", symbol: "μ", currentValue: currentParameters.expectedReturn, proposedValue: selectedEstimate.value.toFixed(8), classification: "derived", selected: true, applicable: true, provenance: returnProvenance },
    { id: "volatility", label: "Realised volatility", symbol: "σ", currentValue: currentParameters.volatility, proposedValue: selectedVolatility.toFixed(8), classification: "derived", selected: true, applicable: true, provenance: volatilityProvenance },
    { id: "rate", label: "Opportunity rate", symbol: "r", currentValue: currentParameters.rate, proposedValue: opportunityRate.toFixed(8), classification: request.hjbUsdRateProxyMode ? "proxy" : "observed", selected: true, applicable: true, warning: request.hjbUsdRateProxyMode ? "Explicit USD rate proxy mode is active." : undefined, provenance: rateProvenance },
    { id: "excessReturn", label: "Excess return", symbol: "μ−r", currentValue: (Number(currentParameters.expectedReturn) - Number(currentParameters.rate)).toFixed(8), proposedValue: (selectedEstimate.value - opportunityRate).toFixed(8), classification: "derived", selected: false, applicable: false, warning: "Derived diagnostic; not a separate HJB control.", provenance: diagnosticProvenance("μ − r", "P-measure risky-asset premium implied by the selected opportunity set.") },
    { id: "analyticAllocation", label: "Initial analytic allocation", symbol: "π*", currentValue: "—", proposedValue: basePreview.appliedAllocation.toFixed(6), classification: "derived", selected: false, applicable: false, warning: `Preview only${basePreview.binding === "none" ? "" : `; ${basePreview.binding} control bound binds`}.`, provenance: diagnosticProvenance("π*=clamp(W(μ−r)/(γσ²), πmin, πmax)", "Initial analytic Merton dollar allocation preview; it does not run the HJB PDE or Monte Carlo.") },
  ];
  const regimeHistory = input.fred
    .filter((item) => request.hjbRegimeSeries.includes(item.seriesId as "VIXCLS" | "T10Y2Y") && item.date <= request.asOfDate && (item.availableDate ?? dateShift(item.date, 1)) <= request.asOfDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  const vixSeries = regimeHistory.filter((item) => item.seriesId === "VIXCLS");
  const selectedVolSeries = returns.map((_, index) => {
    const window = Math.min(request.hjbVolatilityWindow, index + 1);
    const values = logReturns.slice(index + 1 - window, index + 1);
    return { x: index, y: values.length > 1 ? sampleStandardDeviation(values) * Math.sqrt(TRADING_SESSIONS) : 0, label: returns[index].date };
  });
  const rollingMeanSeries = returns.map((_, index) => {
    const window = Math.min(60, index + 1);
    return { x: index, y: mean(simpleReturns.slice(index + 1 - window, index + 1)) * TRADING_SESSIONS, label: returns[index].date };
  });
  const details: MertonOpportunitySnapshotDetails = {
    snapshotId: `${request.sourceMode}-merton-opportunity-${request.instrument}-${request.asOfDate}`,
    estimatorVersion: MERTON_OPPORTUNITY_ESTIMATOR_VERSION,
    mappingVersion: MERTON_ECONOMIC_BRIDGE_MAPPING_VERSION,
    historyInterval: [history[0].date, history.at(-1)!.date],
    historySessionsRequested: request.hjbHistorySessions,
    historySessionsRetained: returns.length,
    calendar: { timezone: input.quote?.timezone ?? "Exchange-local dates from yfinance", convention: "Returned exchange sessions; weekday gaps reported without inventing holiday observations.", missingWeekdaySessions },
    adjustments: { method: "yfinance adjusted close total-return series", dividendEvents: history.filter((item) => item.dividends !== 0).length, splitEvents: history.filter((item) => item.splits !== 0).length },
    returns,
    returnEstimates: { ...estimates, selected: request.hjbEstimator },
    realisedVolatility,
    selectedVolatilityWindow: request.hjbVolatilityWindow,
    opportunityRate: { seriesId: request.hjbOpportunityRateSeries, value: opportunityRate, date: rateObservation.date, availableDate: rateObservation.availableDate, realtimeStart: rateObservation.realtimeStart, realtimeEnd: rateObservation.realtimeEnd, proxy: request.hjbUsdRateProxyMode },
    regimeObservations: [...latestRegimes.entries()].map(([seriesId, item]) => ({ seriesId: seriesId as "VIXCLS" | "T10Y2Y", value: item.value, date: item.date, availableDate: item.availableDate, realtimeStart: item.realtimeStart, realtimeEnd: item.realtimeEnd })),
    drawdown: { maximum: maximumDrawdown, peakDate: drawdownPeakDate, troughDate },
    tails: { dailyVar95: var95, dailyExpectedShortfall95: mean(tail), ...moments },
    bridgeInput,
    previewControls: { wealth, riskAversion, controlMin, controlMax },
    allocationPreviews,
    instabilityWarnings,
  };
  const providerState = request.sourceMode === "fixture" ? "fixture" as const : input.providerErrors?.length ? "partial" as const : "current" as const;
  return {
    id: details.snapshotId,
    model: "HJB",
    workspaceLabel: "Opportunity set",
    instrument: request.instrument,
    currency: instrumentCurrency,
    asOfDate: request.asOfDate,
    createdAt: fetched,
    freshness: providerState,
    freshnessMessage: `Adjusted history, ${request.hjbOpportunityRateSeries}, and ${latestRegimes.size} regime inputs aligned point-in-time to ${request.asOfDate}.`,
    sourceMode: request.sourceMode,
    measure: "P",
    providerHealth: [
      { provider: "yfinance", state: providerState, message: `${returns.length} adjusted returns · ${details.adjustments.dividendEvents} dividends · ${details.adjustments.splitEvents} splits` },
      { provider: "FRED", state: providerState, message: `${request.hjbOpportunityRateSeries} + ${[...latestRegimes.keys()].join(" + ") || "neutral regime fallback"}` },
    ],
    observations: [
      { provider: input.quote ? "yfinance" : "fixture", identifier: `${request.instrument}:adjusted-history`, value: `${history[0].date}/${history.at(-1)!.date}`, observationTimestamp: historyObserved, availableTimestamp: historyObserved, fetchedTimestamp: fetched, unit: "identifier", currency: instrumentCurrency },
      { provider: "FRED", identifier: rateObservation.seriesId, value: rateObservation.value, observationTimestamp: timestamp(rateObservation.date), availableTimestamp: timestamp(rateObservation.availableDate), fetchedTimestamp: fetched, vintage: rateObservation.realtimeStart, unit: "percent", currency: "USD" },
      ...details.regimeObservations.map((item) => ({ provider: "FRED" as const, identifier: item.seriesId, value: item.value, observationTimestamp: timestamp(item.date), availableTimestamp: timestamp(item.availableDate), fetchedTimestamp: fetched, vintage: item.realtimeStart, unit: item.seriesId === "VIXCLS" ? "percent" as const : "percent" as const, currency: "USD" })),
    ],
    proposals,
    primaryTitle: "Adjusted history, rolling opportunity estimates and regimes",
    primarySummary: "Select adjusted price, rolling μ, rolling σ, or the point-in-time regime timeline. VIX is never substituted for instrument volatility.",
    primarySeries: [
      { id: "adjusted-history", label: "Adjusted total-return history", classification: "observed", points: history.map((item, index) => ({ x: index, y: item.adjustedClose, label: item.date })) },
      { id: "rolling-mean", label: "Rolling 60-session annualized μ", classification: "derived", points: rollingMeanSeries },
      { id: "rolling-volatility", label: `Rolling ${request.hjbVolatilityWindow}-session annualized σ`, classification: "derived", points: selectedVolSeries },
      { id: "regime-timeline", label: "VIXCLS regime signal", classification: "scenario", points: vixSeries.map((item, index) => ({ x: index, y: item.value / 100, label: item.date })) },
    ],
    secondaryTitle: "Analytic allocation across opportunity regimes",
    secondarySummary: "Base and regime allocations preserve probability and estimator uncertainty; local sensitivity controls update only this preview.",
    secondarySeries: [{ id: "allocation", label: "Bounded initial π*", classification: "scenario", points: allocationPreviews.map((item, index) => ({ x: index, y: item.appliedAllocation, lower: item.allocationInterval[0], upper: item.allocationInterval[1], label: item.label, selected: item.binding !== "none" })) }],
    diagnostics: [
      { label: "Estimator", value: `${request.hjbEstimator} · ${MERTON_OPPORTUNITY_ESTIMATOR_VERSION}` },
      { label: "Mean uncertainty", value: `95% [${(selectedEstimate.lower * 100).toFixed(2)}%, ${(selectedEstimate.upper * 100).toFixed(2)}%]` },
      { label: "Realised σ windows", value: volatilityWindows.map((window) => `${window}: ${realisedVolatility[String(window) as keyof typeof realisedVolatility] == null ? "n/a" : `${(realisedVolatility[String(window) as keyof typeof realisedVolatility]! * 100).toFixed(2)}%`}`).join(" · ") },
      { label: "Maximum drawdown", value: `${(maximumDrawdown * 100).toFixed(2)}% · ${drawdownPeakDate} to ${troughDate}` },
      { label: "Daily 95% tail", value: `VaR ${(var95 * 100).toFixed(2)}% · ES ${(mean(tail) * 100).toFixed(2)}%` },
      { label: "Economic Bridge", value: `${bridgeInput.mappingId} ${bridgeInput.mappingVersion} · probability ${regimes.reduce((sum, item) => sum + item.probability, 0).toFixed(6)}` },
    ],
    validationIssues: [],
    warnings: [
      ...instabilityWarnings,
      "The sample mean is uncertain; shrinkage is the default estimator and its historical weight is explicit.",
      "VIXCLS is a macro regime signal/prior and is not the selected asset's realised volatility.",
      ...(request.hjbUsdRateProxyMode ? ["Explicit USD rate proxy mode is active for a non-USD asset."] : []),
    ],
    mertonOpportunity: details,
  };
}

function fixtureBusinessDates(asOfDate: string, count: number): string[] {
  const dates: string[] = [];
  let time = Date.parse(`${asOfDate}T00:00:00Z`);
  while (dates.length < count) {
    const date = new Date(time);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    time -= DAY_MS;
  }
  return dates.reverse();
}

export function createMertonOpportunityFixtureSnapshot(request: MarketDataRequest, currentParameters: Record<string, string>): MarketSnapshot {
  const dates = fixtureBusinessDates(request.asOfDate, request.hjbHistorySessions + 1);
  let adjustedClose = 92;
  const history = dates.map((date, index): YFinanceHistoryPoint => {
    const shock = 0.00028 + 0.0085 * Math.sin(index * 1.71) + 0.0042 * Math.cos(index * 0.37);
    adjustedClose *= Math.exp(shock);
    return { date, close: adjustedClose * (index === 180 ? 0.5 : 1), adjustedClose, volume: 1_000_000 + index * 1700, dividends: index > 0 && index % 63 === 0 ? 0.24 : 0, splits: index === 180 ? 2 : 0 };
  });
  const fred: NormalizedFredObservation[] = [
    { seriesId: request.hjbOpportunityRateSeries, date: dateShift(request.asOfDate, -2), value: 4.31, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate, availableDate: dateShift(request.asOfDate, -1) },
    { seriesId: "VIXCLS", date: dateShift(request.asOfDate, -2), value: 18.7, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate, availableDate: dateShift(request.asOfDate, -1) },
    { seriesId: "T10Y2Y", date: dateShift(request.asOfDate, -2), value: 0.42, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate, availableDate: dateShift(request.asOfDate, -1) },
    ...dates.filter((_, index) => index % 21 === 0).flatMap((date, index) => [
      { seriesId: "VIXCLS", date, value: 17 + 5 * Math.sin(index / 3), realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate, availableDate: dateShift(date, 1) },
      { seriesId: "T10Y2Y", date, value: 0.35 + 0.65 * Math.cos(index / 4), realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate, availableDate: dateShift(date, 1) },
    ]),
  ];
  return buildMertonOpportunitySnapshot({
    request,
    currentParameters,
    quote: { symbol: request.instrument, currency: request.currency, timezone: "America/New_York", regularMarketPrice: adjustedClose, regularMarketTime: `${request.asOfDate}T20:00:00Z` },
    history,
    historyCurrency: request.currency,
    fred,
  });
}
