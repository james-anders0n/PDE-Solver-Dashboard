import { hestonSemiAnalyticPrice } from "../pde-engine/heston.ts";
import {
  annualizedRealizedVolatility,
  distributionDividendYield,
  estimateParityDividendYield,
  filterAndInvertOptions,
  impliedVolatilityFromPrice,
  interpolateFredRate,
} from "./black-scholes-snapshot.ts";
import { deriveHestonSeeds, HESTON_CALIBRATION_BOUNDS, spreadAwareWeights } from "./heston-calibration.ts";
import { actual365YearFraction } from "./normalization.ts";
import type { NormalizedFredObservation } from "./fred-client.ts";
import type {
  HestonCalibrationParameters,
  HestonSnapshotDetails,
  HestonSurfaceInstrument,
  MarketDataRequest,
  MarketSnapshot,
  MarketVisualSeries,
  ParameterProposal,
  ProviderObservation,
} from "./types.ts";
import type { YFinanceHistoryPoint, YFinanceOptionContract, YFinanceQuote } from "./yfinance-client.ts";

export interface HestonOptionChainInput {
  expiration: string;
  currency: string;
  contracts: YFinanceOptionContract[];
}

export interface HestonSurfaceSnapshotInput {
  request: MarketDataRequest;
  currentParameters: Record<string, string>;
  quote?: YFinanceQuote;
  history?: YFinanceHistoryPoint[];
  expirations?: string[];
  chains?: HestonOptionChainInput[];
  fred?: NormalizedFredObservation[];
  vix?: NormalizedFredObservation[];
  providerErrors?: string[];
  createdAt?: string;
}

const isoDate = (value: string) => value.slice(0, 10);
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

function median(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function stableId(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveSpot(quote: YFinanceQuote | undefined, history: YFinanceHistoryPoint[], asOfDate: string) {
  const historical = history.filter((item) => item.date <= asOfDate && finitePositive(item.close))
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (quote && finitePositive(quote.regularMarketPrice) && isoDate(quote.regularMarketTime) <= asOfDate) {
    return { value: quote.regularMarketPrice, timestamp: quote.regularMarketTime, timezone: quote.timezone, identifier: quote.symbol };
  }
  if (!historical) throw new Error("No valid yfinance spot was available by the selected as-of date.");
  return {
    value: historical.close, timestamp: `${historical.date}T20:00:00Z`, timezone: quote?.timezone ?? "exchange-local",
    identifier: `${quote?.symbol ?? "instrument"}:history-close`,
  };
}

function dependencyProposal(options: {
  request: MarketDataRequest;
  current: Record<string, string>;
  id: "spot" | "rate" | "dividend";
  value: number;
  provider: "yfinance" | "FRED" | "manual";
  identifiers: string[];
  timestamp: string;
  formula: string;
  classification: "observed" | "proxy" | "derived" | "manual";
  applicable?: boolean;
  warning?: string;
}): ParameterProposal {
  const labels = { spot: ["Spot", "S₀"], rate: ["Risk-free rate", "r"], dividend: ["Dividend yield", "q"] } as const;
  return {
    id: options.id, label: labels[options.id][0], symbol: labels[options.id][1],
    currentValue: options.current[options.id] ?? "—", proposedValue: options.value.toFixed(8),
    classification: options.classification, selected: options.applicable ?? true, applicable: options.applicable ?? true,
    warning: options.warning, calibrationRole: "dependency",
    provenance: {
      provider: options.provider, sourceIdentifiers: options.identifiers, observationTimestamp: options.timestamp,
      availableTimestamp: options.timestamp, fetchedTimestamp: `${options.request.asOfDate}T23:59:59Z`,
      formula: options.formula, financialInterpretation: "Q-measure dependency used consistently by the retained Heston surface.",
      measure: "Q", unit: options.id === "spot" ? "price" : "decimal",
      compounding: options.id === "spot" ? "not-applicable" : "continuous",
      stalenessPolicy: options.provider === "FRED" ? "Previous valid business-day observation; stale after five calendar days." : "As-of market observation required.",
    },
  };
}

function seedProposal(
  request: MarketDataRequest,
  current: Record<string, string>,
  id: keyof HestonCalibrationParameters,
  value: number,
  rationale: string,
): ParameterProposal {
  const labels: Record<keyof HestonCalibrationParameters, [string, string]> = {
    v0: ["Initial variance", "v₀"], kappa: ["Mean reversion", "κ"], theta: ["Long-run variance", "θ"],
    xi: ["Volatility of variance", "ξ"], rho: ["Correlation", "ρ"],
  };
  return {
    id, label: labels[id][0], symbol: labels[id][1], currentValue: current[id] ?? "—", proposedValue: value.toFixed(8),
    classification: "derived", selected: false, applicable: false, calibrationRole: "seed", bounds: HESTON_CALIBRATION_BOUNDS[id],
    warning: "Initialization seed only — run calibration before this parameter can be applied.",
    provenance: {
      provider: "yfinance", sourceIdentifiers: [`${request.instrument}:prepared-surface`],
      observationTimestamp: `${request.asOfDate}T20:00:00Z`, availableTimestamp: `${request.asOfDate}T20:00:00Z`,
      fetchedTimestamp: `${request.asOfDate}T23:59:59Z`, formula: rationale,
      financialInterpretation: "Q-calibration initialization only; not a direct Heston parameter proposal.",
      measure: "Q", unit: "decimal", compounding: "not-applicable", stalenessPolicy: "Recomputed for every immutable surface snapshot.",
    },
  };
}

export const relevantVixInstrument = (instrument: string) => ["SPY", "^GSPC", "^SPX", "SPX"].includes(instrument.toUpperCase());

export function buildHestonSurfaceSnapshot(input: HestonSurfaceSnapshotInput): MarketSnapshot {
  const { request, currentParameters } = input;
  if (request.model !== "Heston") throw new Error("Heston surface builder received the wrong model.");
  if (!(request.hestonExpirationStart > request.asOfDate && request.hestonExpirationEnd >= request.hestonExpirationStart)) {
    throw new Error("Heston expiration range must contain future dates in ascending order.");
  }
  if (!(request.hestonMoneynessMinimum < request.hestonMoneynessMaximum)) throw new Error("Heston moneyness bounds must be ordered.");
  if (!Number.isInteger(request.hestonMinimumStrikes) || request.hestonMinimumStrikes < 3) throw new Error("Heston minimum strike coverage must be at least three.");
  if (!Number.isInteger(request.hestonMinimumExpiries) || request.hestonMinimumExpiries < 2) throw new Error("Heston minimum expiry coverage must be at least two.");
  if (!Number.isFinite(request.maximumRelativeSpread) || request.maximumRelativeSpread <= 0 || request.maximumRelativeSpread > 1) throw new Error("Maximum relative spread must be greater than zero and no more than one.");
  if (!Number.isInteger(request.minimumOpenInterest) || request.minimumOpenInterest < 0) throw new Error("Minimum open interest must be a non-negative integer.");
  if (!Number.isInteger(request.hestonMultiStarts) || request.hestonMultiStarts < 1 || request.hestonMultiStarts > 12) throw new Error("Heston multi-start count must be between one and twelve.");
  if (!Number.isInteger(request.hestonMaximumEvaluations) || request.hestonMaximumEvaluations < Math.max(50, request.hestonMultiStarts)) throw new Error("Heston maximum evaluations must be an integer of at least fifty.");
  if (!Number.isInteger(request.hestonCalibrationSeed) || request.hestonCalibrationSeed < 0) throw new Error("Heston calibration seed must be a non-negative integer.");
  const providerErrors = input.providerErrors ?? [];
  const history = (input.history ?? []).filter((item) => item.date <= request.asOfDate).sort((a, b) => a.date.localeCompare(b.date));
  const spot = resolveSpot(input.quote, history, request.asOfDate);
  const availableExpirations = [...new Set(input.expirations ?? input.chains?.map((item) => item.expiration) ?? [])]
    .filter((item) => item > request.asOfDate).sort();
  const loadedExpirations = [...new Set((input.chains ?? []).map((item) => item.expiration))].sort();
  const selectedExpirations = (loadedExpirations.length ? loadedExpirations : availableExpirations)
    .filter((item) => item >= request.hestonExpirationStart && item <= request.hestonExpirationEnd);
  const fallbackRate = Number(currentParameters.rate);
  const distributionEstimate = distributionDividendYield(history, spot.value, request.asOfDate);
  const chainByExpiration = new Map((input.chains ?? []).map((item) => [item.expiration, item]));
  const parityEstimates: number[] = [];
  for (const expiration of selectedExpirations) {
    const maturity = actual365YearFraction(request.asOfDate, expiration);
    const rate = interpolateFredRate(input.fred ?? [], maturity, request.asOfDate, fallbackRate);
    const dividendGuess = distributionEstimate ?? Number(currentParameters.dividend);
    const parity = estimateParityDividendYield({
      contracts: chainByExpiration.get(expiration)?.contracts ?? [], spot: spot.value, maturity, rate: rate.rate,
      asOfDate: request.asOfDate, maximumRelativeSpread: request.maximumRelativeSpread,
      minimumOpenInterest: request.minimumOpenInterest,
      forwardGuess: spot.value * Math.exp((rate.rate - dividendGuess) * maturity),
    });
    if (parity.value != null) parityEstimates.push(parity.value);
  }
  const parityDividend = median(parityEstimates);
  const dividendMethod: HestonSnapshotDetails["dividend"]["method"] = parityDividend != null ? "parity"
    : distributionEstimate != null ? "distributions" : "manual";
  const dividend = parityDividend ?? distributionEstimate ?? Number(currentParameters.dividend);
  const rateDetails: HestonSnapshotDetails["rates"] = [];
  let surfaceInstruments: HestonSurfaceInstrument[] = [];
  for (const expiration of selectedExpirations) {
    const maturity = actual365YearFraction(request.asOfDate, expiration);
    const rate = interpolateFredRate(input.fred ?? [], maturity, request.asOfDate, fallbackRate);
    const forward = spot.value * Math.exp((rate.rate - dividend) * maturity);
    rateDetails.push({ expiration, maturity, value: rate.rate, mode: rate.mode, sourceSeries: rate.sourceSeries, observationDates: rate.observationDates });
    const filtered = filterAndInvertOptions({
      contracts: chainByExpiration.get(expiration)?.contracts ?? [], optionView: "combined", asOfDate: request.asOfDate,
      maximumRelativeSpread: request.maximumRelativeSpread, minimumOpenInterest: request.minimumOpenInterest,
      spot: spot.value, maturity, rate: rate.rate, dividend,
    });
    surfaceInstruments.push(...filtered.map((item) => {
      const logMoneyness = Math.log(item.contract.strike / forward);
      const moneynessRejected = logMoneyness < request.hestonMoneynessMinimum || logMoneyness > request.hestonMoneynessMaximum;
      return {
        contractSymbol: item.contract.contractSymbol, optionType: item.contract.optionType, expiration,
        strike: item.contract.strike, maturity, forward, logMoneyness, rate: rate.rate, dividend,
        bid: item.contract.bid, ask: item.contract.ask, mid: item.mid,
        marketImpliedVolatility: item.impliedVolatility, bidImpliedVolatility: item.bidImpliedVolatility,
        askImpliedVolatility: item.askImpliedVolatility, providerImpliedVolatility: item.contract.impliedVolatility,
        openInterest: item.contract.openInterest, lastTradeTimestamp: item.contract.lastTradeTimestamp, weight: 0,
        excluded: item.excluded || moneynessRejected,
        rejectionReason: item.rejectionReason ?? (moneynessRejected ? "Outside forward log-moneyness bounds" : undefined),
      } satisfies HestonSurfaceInstrument;
    }));
  }
  const preliminaryRetained = surfaceInstruments.filter((item) => !item.excluded && item.marketImpliedVolatility != null);
  const strikesByExpiry: Record<string, number> = Object.fromEntries(selectedExpirations.map((expiration) => [
    expiration, new Set(preliminaryRetained.filter((item) => item.expiration === expiration).map((item) => item.strike)).size,
  ]));
  const retainedExpirations = selectedExpirations.filter((expiration) => strikesByExpiry[expiration] >= request.hestonMinimumStrikes);
  surfaceInstruments = surfaceInstruments.map((item) => retainedExpirations.includes(item.expiration) ? item : {
    ...item, excluded: true, rejectionReason: item.rejectionReason ?? "Expiry failed minimum strike coverage",
  });
  const retained = surfaceInstruments.filter((item) => !item.excluded && item.marketImpliedVolatility != null);
  const weights = spreadAwareWeights(retained, request.hestonObjective, request.hestonUseOpenInterest);
  const weightBySymbol = new Map(retained.map((item, index) => [item.contractSymbol, weights[index]]));
  surfaceInstruments = surfaceInstruments.map((item) => ({ ...item, weight: weightBySymbol.get(item.contractSymbol) ?? 0 }));
  const fallbackSeeds: HestonCalibrationParameters = {
    v0: Number(currentParameters.v0), kappa: Number(currentParameters.kappa), theta: Number(currentParameters.theta),
    xi: Number(currentParameters.xi), rho: Number(currentParameters.rho),
  };
  const derivedSeeds = retained.length ? deriveHestonSeeds(surfaceInstruments) : {
    parameters: fallbackSeeds,
    rationale: Object.fromEntries(Object.keys(fallbackSeeds).map((key) => [key, "Current solver value retained because surface coverage is unavailable."])) as HestonSnapshotDetails["seedRationale"],
  };
  const surfaceId = `surface-${stableId(surfaceInstruments.map((item) => `${item.contractSymbol}:${item.bid}:${item.ask}:${item.excluded}`).join("|"))}`;
  const primarySeries: MarketVisualSeries[] = selectedExpirations.map((expiration) => ({
    id: `surface-${expiration}`, label: expiration, classification: "observed",
    points: surfaceInstruments.filter((item) => item.expiration === expiration).flatMap((item) => {
      const y = item.marketImpliedVolatility ?? item.providerImpliedVolatility;
      return y == null || !Number.isFinite(y) ? [] : [{
        x: item.logMoneyness, y, secondary: item.maturity, lower: item.bidImpliedVolatility ?? undefined,
        upper: item.askImpliedVolatility ?? undefined, providerValue: item.providerImpliedVolatility,
        label: item.contractSymbol, excluded: item.excluded, rejectionReason: item.rejectionReason,
      }];
    }),
  }));
  const solverMaturity = Math.max(1e-6, Number(currentParameters.maturity));
  const solverRate = interpolateFredRate(input.fred ?? [], solverMaturity, request.asOfDate, fallbackRate);
  const latestVix = request.hestonIncludeVix && relevantVixInstrument(request.instrument)
    ? [...(input.vix ?? [])].sort((a, b) => a.date.localeCompare(b.date)).at(-1) : undefined;
  const vix = latestVix ? { value: latestVix.value, date: latestVix.date, classification: "regime-prior" as const } : undefined;
  const proposals: ParameterProposal[] = [
    dependencyProposal({ request, current: currentParameters, id: "spot", value: spot.value, provider: "yfinance", identifiers: [spot.identifier], timestamp: spot.timestamp, formula: "regularMarketPrice or latest eligible unadjusted close", classification: "observed" }),
    dependencyProposal({
      request, current: currentParameters, id: "rate", value: solverRate.rate,
      provider: solverRate.mode === "treasury-proxy" ? "FRED" : "manual", identifiers: solverRate.sourceSeries.length ? solverRate.sourceSeries : ["manual rate"],
      timestamp: `${solverRate.observationDates.sort().at(-1) ?? request.asOfDate}T00:00:00Z`,
      formula: "solver-maturity interpolation of continuously compounded FRED Treasury proxy yields", classification: solverRate.mode === "treasury-proxy" ? "proxy" : "manual",
      applicable: solverRate.mode === "treasury-proxy", warning: solverRate.mode === "manual-fallback" ? "FRED rate pillars unavailable." : undefined,
    }),
    dependencyProposal({
      request, current: currentParameters, id: "dividend", value: dividend,
      provider: dividendMethod === "manual" ? "manual" : "yfinance",
      identifiers: dividendMethod === "parity" ? [`${surfaceId}:matched-parity-pairs`] : [`${request.instrument}:distributions`],
      timestamp: `${request.asOfDate}T20:00:00Z`, formula: dividendMethod === "parity" ? "median reliable put-call-parity q across retained expirations" : dividendMethod === "distributions" ? "trailing cash distributions converted to continuous yield" : "manual solver dividend retained",
      classification: dividendMethod === "manual" ? "manual" : "derived", applicable: dividendMethod !== "manual",
      warning: dividendMethod === "manual" ? "No market-derived dividend estimate was available." : undefined,
    }),
    ...(["v0", "kappa", "theta", "xi", "rho"] as const).map((id) => seedProposal(request, currentParameters, id, derivedSeeds.parameters[id], derivedSeeds.rationale[id])),
  ];
  const validationIssues: string[] = [];
  const observedCurrencies = [...new Set((input.chains ?? []).map((item) => item.currency.toUpperCase()))];
  if (input.quote?.currency && input.quote.currency.toUpperCase() !== request.currency.toUpperCase()) validationIssues.push(`Currency mismatch: ${input.quote.currency.toUpperCase()} yfinance quote versus requested ${request.currency.toUpperCase()}.`);
  if (observedCurrencies.some((currency) => currency !== request.currency.toUpperCase())) validationIssues.push(`Currency mismatch in option chains: ${observedCurrencies.join(", ")} versus requested ${request.currency.toUpperCase()}.`);
  if (rateDetails.some((item) => item.mode === "treasury-proxy") && request.currency.toUpperCase() !== "USD") validationIssues.push(`Currency mismatch: FRED Treasury rate pillars are USD but the request is ${request.currency.toUpperCase()}.`);
  if (retainedExpirations.length < request.hestonMinimumExpiries) validationIssues.push(`Surface coverage requires at least ${request.hestonMinimumExpiries} expirations; ${retainedExpirations.length} passed strike coverage.`);
  const warnings = [...providerErrors];
  if (rateDetails.some((item) => item.mode === "treasury-proxy")) warnings.push("FRED Treasury yields are expiry-specific pricing-rate proxies, not an OIS curve.");
  if (request.hestonIncludeVix && !relevantVixInstrument(request.instrument)) warnings.push("VIXCLS was not loaded because the selected instrument is not a relevant US broad-market index proxy.");
  const latestHistoryDate = history.at(-1)?.date ?? request.asOfDate;
  if (latestHistoryDate !== request.asOfDate) warnings.push(`Adjusted history ends ${latestHistoryDate}; holiday/non-trading-day difference versus as-of ${request.asOfDate} is recorded.`);
  const createdAt = input.createdAt ?? (request.sourceMode === "fixture" ? `${request.asOfDate}T23:00:00Z` : new Date().toISOString());
  const observations: ProviderObservation[] = [
    { provider: "yfinance", identifier: spot.identifier, value: spot.value, observationTimestamp: spot.timestamp, availableTimestamp: spot.timestamp, fetchedTimestamp: createdAt, unit: "price", currency: request.currency },
    { provider: "yfinance", identifier: surfaceId, value: `${retained.length} retained / ${surfaceInstruments.length} prepared`, observationTimestamp: `${request.asOfDate}T20:00:00Z`, availableTimestamp: `${request.asOfDate}T20:00:00Z`, fetchedTimestamp: createdAt, unit: "identifier", currency: request.currency },
    { provider: "yfinance", identifier: `${request.instrument}:adjusted-history-actions`, value: `${history.length} sessions`, observationTimestamp: `${latestHistoryDate}T20:00:00Z`, availableTimestamp: `${latestHistoryDate}T20:00:00Z`, fetchedTimestamp: createdAt, unit: "identifier", currency: request.currency },
    ...(input.fred ?? []).map((item) => ({ provider: "FRED" as const, identifier: item.seriesId, value: item.value, observationTimestamp: `${item.date}T00:00:00Z`, availableTimestamp: `${item.realtimeStart}T00:00:00Z`, fetchedTimestamp: createdAt, vintage: item.realtimeStart, unit: "percent" as const, currency: "USD" })),
    ...(vix ? [{ provider: "FRED" as const, identifier: "VIXCLS", value: vix.value, observationTimestamp: `${vix.date}T00:00:00Z`, availableTimestamp: `${vix.date}T00:00:00Z`, fetchedTimestamp: createdAt, vintage: vix.date, unit: "percent" as const, currency: "USD" }] : []),
  ];
  const freshness = request.sourceMode === "fixture" ? "fixture"
    : providerErrors.length || validationIssues.length || rateDetails.some((item) => item.mode === "manual-fallback") ? "partial" : "current";
  return {
    id: `${request.sourceMode}-heston-${request.instrument.toLowerCase()}-${request.asOfDate}-${surfaceId}`,
    model: "Heston", workspaceLabel: "Volatility Surface", instrument: request.instrument, currency: request.currency,
    asOfDate: request.asOfDate, createdAt, freshness,
    freshnessMessage: request.sourceMode === "fixture" ? "Deterministic multi-expiry yfinance and FRED surface fixture — run calibration before applying Heston parameters." : "Multi-expiry surface aligned to expiry-specific rate proxies; calibration remains a separate action.",
    sourceMode: request.sourceMode, measure: "Q",
    providerHealth: [
      { provider: "yfinance", state: request.sourceMode === "fixture" ? "fixture" : input.chains?.length ? "current" : "failed", message: `${retained.length} retained instruments across ${retainedExpirations.length} expirations` },
      { provider: "FRED", state: request.sourceMode === "fixture" ? "fixture" : rateDetails.every((item) => item.mode === "treasury-proxy") ? "current" : "partial", message: `${new Set(rateDetails.flatMap((item) => item.sourceSeries)).size} expiry-rate pillars used` },
    ],
    observations, proposals,
    primaryTitle: "Expiry-by-forward-log-moneyness IV surface",
    primarySummary: "Each row is an expiration. Midpoint IV is bounded by bid/ask IV; excluded instruments retain their rejection reasons and never enter calibration.",
    primarySeries,
    secondaryTitle: "Market-minus-Heston residual surface",
    secondarySummary: "Run calibration to produce residual heatmap and expiry summaries. No seed or result is applied automatically.",
    secondarySeries: [],
    diagnostics: [
      { label: "Surface ID", value: surfaceId },
      { label: "Coverage", value: `${retainedExpirations.length} expiries · ${retained.length} instruments` },
      { label: "Filter", value: `${surfaceInstruments.length - retained.length} excluded · x ${request.hestonMoneynessMinimum.toFixed(2)} to ${request.hestonMoneynessMaximum.toFixed(2)}` },
      { label: "Objective", value: `${request.hestonObjective.toUpperCase()} · spread-aware${request.hestonUseOpenInterest ? " + open interest" : ""}` },
      { label: "Calibration", value: "Not run — seeds only" },
      { label: "Realised variance prior", value: `${annualizedRealizedVolatility(history, 20)?.toFixed(4) ?? "n/a"} σ20 · diagnostic only` },
      ...(vix ? [{ label: "VIXCLS regime prior", value: `${vix.value.toFixed(2)} · ${vix.date}` }] : []),
    ],
    validationIssues, warnings,
    heston: {
      surfaceId, spotTimestamp: spot.timestamp, timezone: spot.timezone, availableExpirations, retainedExpirations,
      expirationRange: [request.hestonExpirationStart, request.hestonExpirationEnd],
      moneynessBounds: [request.hestonMoneynessMinimum, request.hestonMoneynessMaximum],
      coverage: { minimumExpiries: request.hestonMinimumExpiries, minimumStrikes: request.hestonMinimumStrikes, expiries: retainedExpirations.length, strikesByExpiry },
      rates: rateDetails, dividend: { method: dividendMethod, value: dividend, parityEstimates, distributionEstimate }, vix,
      seeds: derivedSeeds.parameters, seedRationale: derivedSeeds.rationale, instruments: surfaceInstruments,
      calibrationSettings: { objective: request.hestonObjective, useOpenInterest: request.hestonUseOpenInterest, seed: request.hestonCalibrationSeed, multiStarts: request.hestonMultiStarts, maximumEvaluations: request.hestonMaximumEvaluations },
    },
  };
}

function tradingDates(asOfDate: string, count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${asOfDate}T00:00:00Z`);
  while (dates.length < count) {
    if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.reverse();
}

export function createHestonFixtureSnapshot(request: MarketDataRequest, currentParameters: Record<string, string>): MarketSnapshot {
  const spot = 226.43;
  const expirations = ["2026-11-20", "2027-02-19", "2027-08-20"]
    .filter((item) => item >= request.hestonExpirationStart && item <= request.hestonExpirationEnd);
  const parameters: HestonCalibrationParameters = { v0: 0.0458, kappa: 1.72, theta: 0.0385, xi: 0.41, rho: -0.68 };
  const rates = [0.0418, 0.0427, 0.0436];
  const dividend = 0.0041;
  const logMoneyness = [-0.22, -0.14, -0.07, 0, 0.07, 0.14, 0.22];
  const chains: HestonOptionChainInput[] = expirations.map((expiration, expiryIndex) => {
    const maturity = actual365YearFraction(request.asOfDate, expiration);
    const rate = rates[expiryIndex] ?? rates.at(-1)!;
    const forward = spot * Math.exp((rate - dividend) * maturity);
    const contracts = logMoneyness.flatMap((x) => (["call", "put"] as const).map((optionType) => {
      const strike = Math.round(forward * Math.exp(x));
      const price = hestonSemiAnalyticPrice({
        spot, strike, maturity, rate, dividend, ...parameters, side: optionType === "call" ? "Call" : "Put",
      }, 48, 110);
      const marketIv = impliedVolatilityFromPrice({ price, side: optionType, spot, strike, maturity, rate, dividend }) ?? Math.sqrt(parameters.theta);
      const halfSpread = Math.max(0.015, price * (0.012 + Math.abs(x) * 0.012));
      return {
        contractSymbol: `AAPL${expiration.replaceAll("-", "")}${optionType === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`,
        optionType, expiration, strike, bid: Math.max(0.001, price - halfSpread), ask: price + halfSpread,
        lastPrice: price, impliedVolatility: marketIv + 0.0012, openInterest: Math.round(850 - Math.abs(x) * 1_800),
        volume: Math.round(220 - Math.abs(x) * 300), lastTradeTimestamp: `${request.asOfDate}T19:45:00Z`,
      } satisfies YFinanceOptionContract;
    }));
    if (expiryIndex === 0) contracts.push({
      contractSymbol: "AAPL-HESTON-WIDE", optionType: "call", expiration, strike: Math.round(forward * 1.32),
      bid: 0.02, ask: 1.4, lastPrice: 0.2, impliedVolatility: 0.4, openInterest: 2, volume: 0,
      lastTradeTimestamp: `${request.asOfDate}T19:30:00Z`,
    });
    return { expiration, currency: request.currency, contracts };
  });
  const dates = tradingDates(request.asOfDate, 320);
  const raw: number[] = [];
  let historyValue = 155;
  dates.forEach((_, index) => { historyValue *= Math.exp(0.0007 + 0.012 * Math.sin(index * 1.41) + 0.005 * Math.cos(index * 0.29)); raw.push(historyValue); });
  const scale = spot / raw.at(-1)!;
  const dividendDates = new Set([dates.length - 63, dates.length - 126, dates.length - 189, dates.length - 252]);
  const history: YFinanceHistoryPoint[] = dates.map((date, index) => ({
    date, close: raw[index] * scale, adjustedClose: raw[index] * scale, volume: 1_000_000 + index * 101,
    dividends: dividendDates.has(index) ? 0.24 : 0, splits: 0,
  }));
  const fred: NormalizedFredObservation[] = [
    { seriesId: "DGS1MO", date: request.asOfDate, value: 4.12, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate },
    { seriesId: "DGS3MO", date: request.asOfDate, value: 4.18, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate },
    { seriesId: "DGS6MO", date: request.asOfDate, value: 4.27, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate },
    { seriesId: "DGS1", date: request.asOfDate, value: 4.36, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate },
  ];
  return buildHestonSurfaceSnapshot({
    request, currentParameters,
    quote: { symbol: request.instrument, currency: request.currency, timezone: "America/New_York", regularMarketPrice: spot, regularMarketTime: `${request.asOfDate}T20:00:00Z` },
    history, expirations, chains, fred,
    vix: request.hestonIncludeVix ? [{ seriesId: "VIXCLS", date: request.asOfDate, value: 18.4, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate }] : undefined,
    createdAt: `${request.asOfDate}T23:00:00Z`,
  });
}
