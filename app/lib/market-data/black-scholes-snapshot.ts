import { blackScholesPrice } from "../pde-engine/black-scholes.ts";
import { actual365YearFraction, annualToContinuous, percentToDecimal } from "./normalization.ts";
import type {
  DataClassification,
  MarketDataRequest,
  MarketSnapshot,
  MarketVisualPoint,
  MarketVisualSeries,
  ParameterProposal,
  ProviderObservation,
  TransformationProvenance,
  ValueUnit,
} from "./types.ts";
import type { NormalizedFredObservation } from "./fred-client.ts";
import type { YFinanceHistoryPoint, YFinanceOptionContract, YFinanceQuote } from "./yfinance-client.ts";

const DAY_MS = 86_400_000;
const TRADING_DAYS = 252;
const OPTION_STALE_DAYS = 7;
const FRED_STALE_DAYS = 5;

const FRED_TENORS: Record<string, number> = {
  SOFR: 0, DGS1MO: 1 / 12, DGS3MO: 0.25, DGS6MO: 0.5, DGS1: 1, DGS2: 2,
  DGS3: 3, DGS5: 5, DGS7: 7, DGS10: 10, DGS20: 20, DGS30: 30,
};

const labels: Record<string, [string, string]> = {
  spot: ["Spot", "S₀"], maturity: ["Maturity", "T"], rate: ["Risk-free rate", "r"],
  dividend: ["Dividend yield", "q"], volatility: ["Volatility", "σ"],
};

export interface BlackScholesSnapshotInput {
  request: MarketDataRequest;
  currentParameters: Record<string, string>;
  quote?: YFinanceQuote;
  history?: YFinanceHistoryPoint[];
  expirations?: string[];
  optionChain?: YFinanceOptionContract[];
  optionCurrency?: string;
  fred?: NormalizedFredObservation[];
  providerErrors?: string[];
  createdAt?: string;
}

export interface FilteredOptionContract {
  contract: YFinanceOptionContract;
  mid: number;
  relativeSpread: number;
  impliedVolatility: number | null;
  bidImpliedVolatility: number | null;
  askImpliedVolatility: number | null;
  excluded: boolean;
  rejectionReason?: string;
}

export interface FredRateInterpolation {
  rate: number;
  mode: "treasury-proxy" | "manual-fallback";
  sourceSeries: string[];
  observationDates: string[];
  maximumObservationAgeDays: number;
}

const isoDate = (value: string): string => value.slice(0, 10);

function daysBetween(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
}

function median(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function bracketFredRateSeries(maturity: number): string[] {
  if (!Number.isFinite(maturity) || maturity <= 0) throw new Error("Rate maturity must be positive.");
  const tenors = Object.entries(FRED_TENORS).filter(([series]) => series !== "SOFR").sort((a, b) => a[1] - b[1]);
  if (maturity <= tenors[0][1]) return ["SOFR", tenors[0][0]];
  if (maturity >= tenors.at(-1)![1]) return [tenors.at(-2)![0], tenors.at(-1)![0]];
  const upperIndex = tenors.findIndex(([, tenor]) => tenor >= maturity);
  const lower = tenors[Math.max(0, upperIndex - 1)][0];
  const upper = tenors[upperIndex][0];
  return lower === upper ? [lower] : [lower, upper];
}

export function interpolateFredRate(
  observations: NormalizedFredObservation[],
  maturity: number,
  asOfDate: string,
  fallbackRate: number,
): FredRateInterpolation {
  const latest = new Map<string, NormalizedFredObservation>();
  for (const item of observations) {
    if (!(item.seriesId in FRED_TENORS) || item.date > asOfDate || !Number.isFinite(item.value)) continue;
    const previous = latest.get(item.seriesId);
    if (!previous || previous.date < item.date) latest.set(item.seriesId, item);
  }
  const pillars = [...latest.values()].map((item) => ({
    ...item,
    tenor: FRED_TENORS[item.seriesId],
    continuousRate: annualToContinuous(percentToDecimal(item.value)),
  })).sort((a, b) => a.tenor - b.tenor);
  if (pillars.length === 0) return {
    rate: fallbackRate, mode: "manual-fallback", sourceSeries: [], observationDates: [],
    maximumObservationAgeDays: Number.POSITIVE_INFINITY,
  };
  let lower = pillars[0];
  let upper = pillars.at(-1)!;
  for (const pillar of pillars) {
    if (pillar.tenor <= maturity) lower = pillar;
    if (pillar.tenor >= maturity) { upper = pillar; break; }
  }
  const width = upper.tenor - lower.tenor;
  const weight = width > 0 ? Math.max(0, Math.min(1, (maturity - lower.tenor) / width)) : 0;
  const used = lower.seriesId === upper.seriesId ? [lower] : [lower, upper];
  return {
    rate: lower.continuousRate + weight * (upper.continuousRate - lower.continuousRate),
    mode: "treasury-proxy",
    sourceSeries: used.map((item) => item.seriesId),
    observationDates: used.map((item) => item.date),
    maximumObservationAgeDays: Math.max(...used.map((item) => daysBetween(item.date, asOfDate))),
  };
}

export function impliedVolatilityFromPrice(options: {
  price: number;
  side: "call" | "put";
  spot: number;
  strike: number;
  maturity: number;
  rate: number;
  dividend: number;
  minimum?: number;
  maximum?: number;
  tolerance?: number;
}): number | null {
  const { price, spot, strike, maturity, rate, dividend } = options;
  if (![price, spot, strike, maturity, rate, dividend].every(Number.isFinite)
    || price <= 0 || spot <= 0 || strike <= 0 || maturity <= 0) return null;
  let low = options.minimum ?? 1e-6;
  let high = options.maximum ?? 5;
  const tolerance = options.tolerance ?? 1e-8;
  const value = (volatility: number) => blackScholesPrice({
    spot, strike, maturity, rate, dividend, volatility,
    side: options.side === "call" ? "Call" : "Put",
  });
  const lowPrice = value(low);
  const highPrice = value(high);
  if (price < lowPrice - tolerance || price > highPrice + tolerance) return null;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    const middlePrice = value(middle);
    if (Math.abs(middlePrice - price) <= tolerance) return middle;
    if (middlePrice < price) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function annualizedRealizedVolatility(history: YFinanceHistoryPoint[], window: number): number | null {
  if (!Number.isInteger(window) || window < 2) throw new Error("Realised-volatility window must be an integer of at least two.");
  const prices = history.filter((item) => finitePositive(item.adjustedClose))
    .sort((a, b) => a.date.localeCompare(b.date)).map((item) => item.adjustedClose);
  if (prices.length < window + 1) return null;
  const selected = prices.slice(-(window + 1));
  const returns = selected.slice(1).map((price, index) => Math.log(price / selected[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(Math.max(0, variance) * TRADING_DAYS);
}

export function distributionDividendYield(
  history: YFinanceHistoryPoint[],
  spot: number,
  asOfDate: string,
): number | null {
  if (!finitePositive(spot)) return null;
  const start = Date.parse(`${asOfDate}T00:00:00Z`) - 365 * DAY_MS;
  const total = history.filter((item) => {
    const timestamp = Date.parse(`${item.date}T00:00:00Z`);
    return timestamp >= start && item.date <= asOfDate && Number.isFinite(item.dividends) && item.dividends > 0;
  }).reduce((sum, item) => sum + item.dividends, 0);
  return total > 0 ? Math.log1p(total / spot) : 0;
}

function quoteStructureRejection(
  contract: YFinanceOptionContract,
  asOfDate: string,
  maximumRelativeSpread: number,
  minimumOpenInterest: number,
): string | null {
  if (!finitePositive(contract.strike)) return "Invalid strike";
  if (![contract.bid, contract.ask, contract.lastPrice].every(Number.isFinite)) return "Non-finite quote";
  if (contract.bid <= 0 || contract.ask <= 0) return "Zero bid or ask";
  if (contract.ask < contract.bid) return "Crossed market";
  const mid = (contract.bid + contract.ask) / 2;
  if ((contract.ask - contract.bid) / mid > maximumRelativeSpread) return "Bid/ask spread exceeds filter";
  if (!Number.isFinite(contract.openInterest) || contract.openInterest < minimumOpenInterest) return "Open interest below filter";
  if (!contract.lastTradeTimestamp) return "Missing last-trade timestamp";
  const age = daysBetween(isoDate(contract.lastTradeTimestamp), asOfDate);
  if (age < 0) return "Quote was not available by the as-of date";
  if (age > OPTION_STALE_DAYS) return "Stale option quote";
  return null;
}

function noArbitrageRejection(options: {
  contract: YFinanceOptionContract;
  mid: number;
  spot: number;
  maturity: number;
  rate: number;
  dividend: number;
}): string | null {
  const { contract, mid, spot, maturity, rate, dividend } = options;
  const discountedSpot = spot * Math.exp(-dividend * maturity);
  const discountedStrike = contract.strike * Math.exp(-rate * maturity);
  const lower = contract.optionType === "call"
    ? Math.max(0, discountedSpot - discountedStrike)
    : Math.max(0, discountedStrike - discountedSpot);
  const upper = contract.optionType === "call" ? discountedSpot : discountedStrike;
  const tolerance = 1e-6 * Math.max(1, spot, contract.strike);
  return mid < lower - tolerance || mid > upper + tolerance ? "No-arbitrage price bound violated" : null;
}

export function estimateParityDividendYield(options: {
  contracts: YFinanceOptionContract[];
  spot: number;
  maturity: number;
  rate: number;
  asOfDate: string;
  maximumRelativeSpread: number;
  minimumOpenInterest: number;
  forwardGuess: number;
}): { value: number | null; matchedPairs: number; sourceIdentifiers: string[] } {
  const eligible = options.contracts.filter((contract) =>
    quoteStructureRejection(contract, options.asOfDate, options.maximumRelativeSpread, options.minimumOpenInterest) == null);
  const byStrike = new Map<number, Partial<Record<"call" | "put", YFinanceOptionContract>>>();
  for (const contract of eligible) {
    if (Math.abs(Math.log(contract.strike / options.forwardGuess)) > 0.2) continue;
    const pair = byStrike.get(contract.strike) ?? {};
    pair[contract.optionType] = contract;
    byStrike.set(contract.strike, pair);
  }
  const estimates: Array<{ value: number; identifiers: string[] }> = [];
  for (const [strike, pair] of byStrike) {
    if (!pair.call || !pair.put) continue;
    const callMid = (pair.call.bid + pair.call.ask) / 2;
    const putMid = (pair.put.bid + pair.put.ask) / 2;
    const factor = (callMid - putMid + strike * Math.exp(-options.rate * options.maturity)) / options.spot;
    if (!(factor > 0)) continue;
    const value = -Math.log(factor) / options.maturity;
    if (!Number.isFinite(value) || value < -0.1 || value > 0.5) continue;
    estimates.push({ value, identifiers: [pair.call.contractSymbol, pair.put.contractSymbol] });
  }
  return {
    value: estimates.length >= 2 ? median(estimates.map((item) => item.value)) : null,
    matchedPairs: estimates.length,
    sourceIdentifiers: estimates.flatMap((item) => item.identifiers),
  };
}

export function filterAndInvertOptions(options: {
  contracts: YFinanceOptionContract[];
  optionView: MarketDataRequest["optionView"];
  asOfDate: string;
  maximumRelativeSpread: number;
  minimumOpenInterest: number;
  spot: number;
  maturity: number;
  rate: number;
  dividend: number;
}): FilteredOptionContract[] {
  return options.contracts.filter((contract) => options.optionView === "combined"
    || (options.optionView === "calls" && contract.optionType === "call")
    || (options.optionView === "puts" && contract.optionType === "put"))
    .map((contract) => {
      const mid = (contract.bid + contract.ask) / 2;
      const relativeSpread = mid > 0 ? (contract.ask - contract.bid) / mid : Number.POSITIVE_INFINITY;
      let rejectionReason = quoteStructureRejection(contract, options.asOfDate, options.maximumRelativeSpread, options.minimumOpenInterest);
      if (!rejectionReason) rejectionReason = noArbitrageRejection({ ...options, contract, mid });
      const solverInput = {
        side: contract.optionType, spot: options.spot, strike: contract.strike, maturity: options.maturity,
        rate: options.rate, dividend: options.dividend,
      } as const;
      const impliedVolatility = rejectionReason ? null : impliedVolatilityFromPrice({ ...solverInput, price: mid });
      if (!rejectionReason && impliedVolatility == null) rejectionReason = "Implied-volatility inversion failed";
      return {
        contract, mid, relativeSpread, impliedVolatility,
        bidImpliedVolatility: rejectionReason ? null : impliedVolatilityFromPrice({ ...solverInput, price: contract.bid }),
        askImpliedVolatility: rejectionReason ? null : impliedVolatilityFromPrice({ ...solverInput, price: contract.ask }),
        excluded: Boolean(rejectionReason), rejectionReason: rejectionReason ?? undefined,
      };
    });
}

function proposal(options: {
  request: MarketDataRequest;
  current: Record<string, string>;
  id: string;
  proposedValue: string;
  classification: DataClassification;
  provider: "yfinance" | "FRED" | "manual";
  sourceIdentifiers: string[];
  observationTimestamp: string;
  availableTimestamp: string;
  formula: string;
  interpretation: string;
  unit?: ValueUnit;
  compounding?: TransformationProvenance["compounding"];
  applicable?: boolean;
  selected?: boolean;
  warning?: string;
  vintage?: string;
}): ParameterProposal {
  const [label, symbol] = labels[options.id] ?? [options.id, options.id];
  return {
    id: options.id, label, symbol, currentValue: options.current[options.id] ?? "—",
    proposedValue: options.proposedValue, classification: options.classification,
    selected: options.selected ?? true, applicable: options.applicable ?? true, warning: options.warning,
    provenance: {
      provider: options.provider, sourceIdentifiers: options.sourceIdentifiers,
      observationTimestamp: options.observationTimestamp, availableTimestamp: options.availableTimestamp,
      fetchedTimestamp: `${options.request.asOfDate}T23:59:59Z`, vintage: options.vintage,
      formula: options.formula, financialInterpretation: options.interpretation, measure: "Q",
      unit: options.unit ?? "decimal", compounding: options.compounding ?? "continuous",
      stalenessPolicy: options.provider === "FRED"
        ? "Previous valid business-day observation; stale after five calendar days."
        : "As-of quote required; option trades stale after seven calendar days.",
    },
  };
}

function resolveSpot(
  quote: YFinanceQuote | undefined,
  history: YFinanceHistoryPoint[],
  asOfDate: string,
): { value: number; timestamp: string; timezone: string; identifier: string; usedQuote: boolean } {
  const historical = history.filter((item) => item.date <= asOfDate && finitePositive(item.close))
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (quote && finitePositive(quote.regularMarketPrice) && isoDate(quote.regularMarketTime) <= asOfDate) {
    return { value: quote.regularMarketPrice, timestamp: quote.regularMarketTime, timezone: quote.timezone, identifier: quote.symbol, usedQuote: true };
  }
  if (!historical) throw new Error("No valid yfinance spot was available by the selected as-of date.");
  return {
    value: historical.close, timestamp: `${historical.date}T20:00:00Z`,
    timezone: quote?.timezone ?? "exchange-local", identifier: `${quote?.symbol ?? "instrument"}:history-close`, usedQuote: false,
  };
}

function pointFromOption(item: FilteredOptionContract, selectedSymbol: string | null): MarketVisualPoint | null {
  const y = item.impliedVolatility ?? item.contract.impliedVolatility;
  if (!Number.isFinite(y) || y == null || y <= 0 || y > 5) return null;
  return {
    x: item.contract.strike, y, lower: item.bidImpliedVolatility ?? undefined,
    upper: item.askImpliedVolatility ?? undefined, secondary: item.relativeSpread,
    providerValue: item.contract.impliedVolatility, label: `${item.contract.strike} ${item.contract.optionType}`,
    excluded: item.excluded, selected: item.contract.contractSymbol === selectedSymbol,
    rejectionReason: item.rejectionReason,
  };
}

function latestFredObservations(items: NormalizedFredObservation[]): NormalizedFredObservation[] {
  const latest = new Map<string, NormalizedFredObservation>();
  for (const item of items) {
    const previous = latest.get(item.seriesId);
    if (!previous || previous.date < item.date) latest.set(item.seriesId, item);
  }
  return [...latest.values()].sort((a, b) => (FRED_TENORS[a.seriesId] ?? 0) - (FRED_TENORS[b.seriesId] ?? 0));
}

export function buildBlackScholesSnapshot(input: BlackScholesSnapshotInput): MarketSnapshot {
  const { request, currentParameters } = input;
  if (request.model !== "Black–Scholes") throw new Error("Black–Scholes snapshot builder received the wrong model.");
  if (!Number.isFinite(request.maximumRelativeSpread) || request.maximumRelativeSpread <= 0 || request.maximumRelativeSpread > 1) {
    throw new Error("Maximum relative spread must be greater than zero and no more than one.");
  }
  if (!Number.isInteger(request.minimumOpenInterest) || request.minimumOpenInterest < 0) {
    throw new Error("Minimum open interest must be a non-negative integer.");
  }
  const providerErrors = input.providerErrors ?? [];
  const history = (input.history ?? []).filter((item) => item.date <= request.asOfDate);
  const spot = resolveSpot(input.quote, history, request.asOfDate);
  const expirations = [...new Set(input.expirations ?? [])].filter((item) => item > request.asOfDate).sort();
  const requestedExpiration = request.optionExpiration;
  const expiration = requestedExpiration && expirations.includes(requestedExpiration) ? requestedExpiration : expirations[0] ?? requestedExpiration;
  if (!expiration || expiration <= request.asOfDate) throw new Error("No valid future option expiration was available.");
  const maturity = actual365YearFraction(request.asOfDate, expiration);
  const fallbackRate = Number(currentParameters.rate);
  const rate = interpolateFredRate(input.fred ?? [], maturity, request.asOfDate, fallbackRate);
  const distributionEstimate = distributionDividendYield(history, spot.value, request.asOfDate);
  const forwardGuess = spot.value * Math.exp((rate.rate - (distributionEstimate ?? Number(currentParameters.dividend))) * maturity);
  const parity = estimateParityDividendYield({
    contracts: input.optionChain ?? [], spot: spot.value, maturity, rate: rate.rate, asOfDate: request.asOfDate,
    maximumRelativeSpread: request.maximumRelativeSpread, minimumOpenInterest: request.minimumOpenInterest, forwardGuess,
  });
  let selectedDividendMethod = request.dividendMethod;
  let dividend = Number(currentParameters.dividend);
  const warnings: string[] = [];
  if (request.dividendMethod === "parity") {
    if (parity.value != null) dividend = parity.value;
    else if (distributionEstimate != null) {
      dividend = distributionEstimate; selectedDividendMethod = "distributions";
      warnings.push("Put-call parity lacked at least two reliable matched strikes; the distribution-history estimate is proposed instead.");
    } else {
      selectedDividendMethod = "manual";
      warnings.push("Neither put-call parity nor distribution history produced a reliable dividend estimate; the manual value is retained.");
    }
  } else if (request.dividendMethod === "distributions") {
    if (distributionEstimate != null) dividend = distributionEstimate;
    else { selectedDividendMethod = "manual"; warnings.push("Distribution history was unavailable; the manual dividend value is retained."); }
  }
  const filtered = filterAndInvertOptions({
    contracts: input.optionChain ?? [], optionView: request.optionView, asOfDate: request.asOfDate,
    maximumRelativeSpread: request.maximumRelativeSpread, minimumOpenInterest: request.minimumOpenInterest,
    spot: spot.value, maturity, rate: rate.rate, dividend,
  });
  const retained = filtered.filter((item) => !item.excluded && item.impliedVolatility != null);
  const forward = spot.value * Math.exp((rate.rate - dividend) * maturity);
  const atm = retained.length > 0 ? retained.reduce((best, item) =>
    Math.abs(Math.log(item.contract.strike / forward)) < Math.abs(Math.log(best.contract.strike / forward)) ? item : best) : null;
  const selectedIv = atm?.impliedVolatility ?? null;
  const providerIv = atm?.contract.impliedVolatility ?? null;
  const realised20 = annualizedRealizedVolatility(history, 20);
  const realised60 = annualizedRealizedVolatility(history, 60);
  const realised252 = annualizedRealizedVolatility(history, 252);
  const callPoints = filtered.filter((item) => item.contract.optionType === "call")
    .map((item) => pointFromOption(item, atm?.contract.contractSymbol ?? null)).filter((item): item is MarketVisualPoint => item != null);
  const putPoints = filtered.filter((item) => item.contract.optionType === "put")
    .map((item) => pointFromOption(item, atm?.contract.contractSymbol ?? null)).filter((item): item is MarketVisualPoint => item != null);
  const allPrimarySeries: MarketVisualSeries[] = [
    { id: "calls", label: "Call mid-price IV", classification: "calibrated", points: callPoints },
    { id: "puts", label: "Put mid-price IV", classification: "calibrated", points: putPoints },
  ];
  const primarySeries = allPrimarySeries.filter((series) => request.optionView === "combined"
    || (request.optionView === "calls" && series.id === "calls")
    || (request.optionView === "puts" && series.id === "puts"));
  const secondarySeries: MarketVisualSeries[] = [
    {
      id: "implied", label: "Forward-ATM implied volatility (Q)", classification: "calibrated",
      points: selectedIv == null ? [] : [{ x: 0, y: selectedIv, label: "ATM implied", selected: true }],
    },
    {
      id: "realised", label: "Adjusted-return realised volatility (P)", classification: "derived",
      points: [
        { x: 20, y: realised20, label: "20 sessions" },
        { x: 60, y: realised60, label: "60 sessions" },
        { x: 252, y: realised252, label: "252 sessions" },
      ].filter((item): item is { x: number; y: number; label: string } => item.y != null),
    },
  ];
  const fredLatest = latestFredObservations(input.fred ?? []);
  const optionTimestamp = retained.map((item) => item.contract.lastTradeTimestamp)
    .filter((item): item is string => Boolean(item)).sort().at(-1) ?? `${request.asOfDate}T00:00:00Z`;
  const rateTimestamp = rate.observationDates.length ? `${[...rate.observationDates].sort().at(-1)}T00:00:00Z` : `${request.asOfDate}T00:00:00Z`;
  const dividendIdentifiers = selectedDividendMethod === "parity" ? parity.sourceIdentifiers
    : selectedDividendMethod === "distributions" ? [`${request.instrument}:dividends`] : [`${request.instrument}:manual-dividend`];
  const proposals: ParameterProposal[] = [
    proposal({
      request, current: currentParameters, id: "spot", proposedValue: spot.value.toFixed(4), classification: "observed",
      provider: "yfinance", sourceIdentifiers: [spot.identifier], observationTimestamp: spot.timestamp, availableTimestamp: spot.timestamp,
      formula: spot.usedQuote ? "regularMarketPrice" : "latest unadjusted close available by as-of date",
      interpretation: "Observed underlying level for the Q-measure pricing state.", unit: "price", compounding: "not-applicable",
    }),
    proposal({
      request, current: currentParameters, id: "maturity", proposedValue: maturity.toFixed(8), classification: "derived",
      provider: "yfinance", sourceIdentifiers: [expiration], observationTimestamp: `${request.asOfDate}T00:00:00Z`,
      availableTimestamp: optionTimestamp, formula: "ACT/365F(option expiration − valuation date)",
      interpretation: "Contract time to expiry; not a forecast horizon.", unit: "years", compounding: "not-applicable",
    }),
    proposal({
      request, current: currentParameters, id: "rate", proposedValue: rate.rate.toFixed(8),
      classification: rate.mode === "treasury-proxy" ? "proxy" : "manual",
      provider: rate.mode === "treasury-proxy" ? "FRED" : "manual",
      sourceIdentifiers: rate.sourceSeries.length ? rate.sourceSeries : ["manual rate"],
      observationTimestamp: rateTimestamp, availableTimestamp: rateTimestamp,
      formula: rate.mode === "treasury-proxy" ? "linear maturity interpolation of ln(1 + quoted Treasury yield / 100)" : "manual solver rate retained",
      interpretation: rate.mode === "treasury-proxy" ? "USD Treasury pricing-rate proxy under Q; not an OIS curve." : "Manual Q-measure rate retained because live pillars were unavailable.",
      selected: rate.mode === "treasury-proxy", applicable: rate.mode === "treasury-proxy",
      warning: rate.mode === "manual-fallback" ? "FRED rate pillars were unavailable." : undefined,
      vintage: [...rate.observationDates].sort().at(-1),
    }),
    proposal({
      request, current: currentParameters, id: "dividend", proposedValue: dividend.toFixed(8),
      classification: selectedDividendMethod === "manual" ? "manual" : "derived",
      provider: selectedDividendMethod === "manual" ? "manual" : "yfinance", sourceIdentifiers: dividendIdentifiers,
      observationTimestamp: optionTimestamp, availableTimestamp: optionTimestamp,
      formula: selectedDividendMethod === "parity"
        ? "median[-ln((Cmid − Pmid + K exp(−rT))/S₀)/T] across reliable near-forward pairs"
        : selectedDividendMethod === "distributions" ? "ln(1 + trailing-365-day cash distributions / S₀)" : "manual solver dividend retained",
      interpretation: `Continuous dividend yield for Q pricing; selected method: ${selectedDividendMethod}.`,
      selected: selectedDividendMethod !== "manual", applicable: selectedDividendMethod !== "manual",
      warning: selectedDividendMethod === "manual" ? "No market-derived dividend proposal is available." : undefined,
    }),
    proposal({
      request, current: currentParameters, id: "volatility", proposedValue: selectedIv == null ? currentParameters.volatility : selectedIv.toFixed(8),
      classification: selectedIv == null ? "manual" : "calibrated", provider: selectedIv == null ? "manual" : "yfinance",
      sourceIdentifiers: atm ? [atm.contract.contractSymbol] : ["manual volatility"],
      observationTimestamp: atm?.contract.lastTradeTimestamp ?? optionTimestamp, availableTimestamp: atm?.contract.lastTradeTimestamp ?? optionTimestamp,
      formula: selectedIv == null ? "manual solver volatility retained" : "Black–Scholes inversion of bid/ask midpoint at minimum |ln(K/F)|",
      interpretation: selectedIv == null ? "No reliable Q-measure implied volatility was available." : "Forward-ATM option-implied Q-measure volatility; realised volatility remains diagnostic.",
      selected: selectedIv != null, applicable: selectedIv != null,
      warning: selectedIv == null ? "No retained option quote produced a valid implied volatility." : undefined,
    }),
  ];
  const validationIssues: string[] = [];
  const observedCurrency = input.optionCurrency ?? input.quote?.currency ?? request.currency;
  if (observedCurrency.toUpperCase() !== request.currency.toUpperCase()) {
    validationIssues.push(`Currency mismatch: ${observedCurrency.toUpperCase()} yfinance instrument versus requested ${request.currency.toUpperCase()} rate market.`);
  }
  if (rate.mode === "treasury-proxy" && request.currency.toUpperCase() !== "USD") {
    validationIssues.push(`Currency mismatch: FRED Treasury rate pillars are USD but the request is ${request.currency.toUpperCase()}.`);
  }
  if (requestedExpiration && requestedExpiration !== expiration) warnings.push(`Requested expiration ${requestedExpiration} was unavailable; ${expiration} was selected.`);
  if (!spot.usedQuote) warnings.push("The regular-market quote was after the as-of date or unavailable; the latest eligible unadjusted close was used for spot.");
  if (rate.mode === "treasury-proxy") warnings.push("FRED Treasury yields are a pricing-rate proxy, not an OIS discount curve.");
  if (rate.maximumObservationAgeDays > FRED_STALE_DAYS && Number.isFinite(rate.maximumObservationAgeDays)) {
    warnings.push(`The oldest applied FRED rate pillar is ${rate.maximumObservationAgeDays.toFixed(0)} calendar days old.`);
  }
  if (providerErrors.length) warnings.push(...providerErrors);
  const freshness = request.sourceMode === "fixture" ? "fixture"
    : providerErrors.length > 0 || !selectedIv || rate.mode === "manual-fallback" ? "partial"
      : rate.maximumObservationAgeDays > FRED_STALE_DAYS ? "stale" : "current";
  const fetchedTimestamp = input.createdAt ?? (request.sourceMode === "fixture" ? `${request.asOfDate}T23:00:00Z` : new Date().toISOString());
  const observations: ProviderObservation[] = [
    {
      provider: "yfinance", identifier: spot.identifier, value: spot.value, observationTimestamp: spot.timestamp,
      availableTimestamp: spot.timestamp, fetchedTimestamp, unit: "price", currency: observedCurrency,
    },
    {
      provider: "yfinance", identifier: `${request.instrument}:expiration`, value: expiration,
      observationTimestamp: `${request.asOfDate}T00:00:00Z`, availableTimestamp: optionTimestamp,
      fetchedTimestamp, unit: "identifier", currency: observedCurrency,
    },
    {
      provider: "yfinance", identifier: `${request.instrument}:option-chain:${expiration}`,
      value: `${retained.length} retained / ${filtered.length} displayed`, observationTimestamp: optionTimestamp,
      availableTimestamp: optionTimestamp, fetchedTimestamp, unit: "identifier", currency: observedCurrency,
    },
    {
      provider: "yfinance", identifier: `${request.instrument}:adjusted-history`, value: `${history.length} sessions`,
      observationTimestamp: `${history.at(-1)?.date ?? request.asOfDate}T20:00:00Z`,
      availableTimestamp: `${history.at(-1)?.date ?? request.asOfDate}T20:00:00Z`,
      fetchedTimestamp, unit: "identifier", currency: observedCurrency,
    },
    ...fredLatest.map((item) => ({
      provider: "FRED" as const, identifier: item.seriesId, value: item.value,
      observationTimestamp: `${item.date}T00:00:00Z`, availableTimestamp: `${item.realtimeStart}T00:00:00Z`,
      fetchedTimestamp, vintage: item.realtimeStart, unit: "percent" as const, currency: "USD",
    })),
  ];
  return {
    id: `${request.sourceMode}-black-scholes-${request.instrument.toLowerCase()}-${request.asOfDate}-${expiration}`,
    model: "Black–Scholes", workspaceLabel: "Equity Snapshot", instrument: request.instrument,
    currency: observedCurrency, asOfDate: request.asOfDate, createdAt: fetchedTimestamp, freshness,
    freshnessMessage: request.sourceMode === "fixture"
      ? "Deterministic yfinance option-chain and FRED tenor fixture — no solver input changes until Apply."
      : freshness === "current"
        ? "Quote, option chain, adjusted history, and maturity-matched FRED pillars are current for the selected as-of date."
        : "A reviewable partial snapshot was retained; unsupported or missing proposals remain disabled.",
    sourceMode: request.sourceMode, measure: "Q",
    providerHealth: [
      {
        provider: "yfinance", state: input.optionChain?.length && history.length ? (request.sourceMode === "fixture" ? "fixture" : "current") : "partial",
        message: input.optionChain?.length ? `${retained.length} option quotes retained` : "Option chain unavailable",
      },
      {
        provider: "FRED",
        state: rate.mode === "treasury-proxy" ? (request.sourceMode === "fixture" ? "fixture" : rate.maximumObservationAgeDays > FRED_STALE_DAYS ? "stale" : "current") : "failed",
        message: rate.sourceSeries.length ? `${rate.sourceSeries.join(" / ")} maturity bracket` : "Manual rate fallback",
      },
    ],
    observations, proposals,
    primaryTitle: `${expiration} bid/ask implied-volatility smile`,
    primarySummary: "Midpoint IV is shown with bid/ask IV whiskers. Excluded quotes retain their provider IV only for diagnostic placement; the selected contract minimizes |ln(K/F)|.",
    primarySeries,
    secondaryTitle: "Implied Q volatility versus realised P volatility",
    secondarySummary: "Forward-ATM implied volatility is the pricing proposal. Realised windows use adjusted log returns and remain diagnostics.",
    secondarySeries,
    diagnostics: [
      { label: "Expiration", value: `${expiration} · ACT/365F ${maturity.toFixed(6)}` },
      { label: "Forward ATM", value: atm ? `${atm.contract.contractSymbol} · K ${atm.contract.strike.toFixed(2)}` : "No retained contract" },
      { label: "Quote filter", value: `${retained.length} retained / ${filtered.length - retained.length} excluded` },
      { label: "Spread / OI", value: `≤ ${(request.maximumRelativeSpread * 100).toFixed(1)}% · ≥ ${request.minimumOpenInterest}` },
      { label: "Rate source", value: rate.sourceSeries.length ? `${rate.sourceSeries.join(" → ")} · TREASURY PROXY` : "Manual fallback" },
      { label: "Dividend method", value: `${selectedDividendMethod.toUpperCase()} · parity ${parity.value?.toFixed(4) ?? "n/a"} · distributions ${distributionEstimate?.toFixed(4) ?? "n/a"}` },
      { label: "Matched parity pairs", value: String(parity.matchedPairs) },
      { label: "IV method", value: "Bid/ask midpoint inversion" },
    ],
    validationIssues, warnings,
    blackScholes: {
      expiration, availableExpirations: expirations, spotTimestamp: spot.timestamp, timezone: spot.timezone,
      forward, atmStrike: atm?.contract.strike ?? null, atmContractSymbol: atm?.contract.contractSymbol ?? null,
      atmMethod: "forward-log-moneyness", optionView: request.optionView,
      instruments: retained.map((item) => ({
        contractSymbol: item.contract.contractSymbol,
        optionType: item.contract.optionType,
        expiration: item.contract.expiration,
        strike: item.contract.strike,
        maturity,
        bid: item.contract.bid,
        ask: item.contract.ask,
        mid: item.mid,
        relativeSpread: item.relativeSpread,
        openInterest: item.contract.openInterest,
        lastTradeTimestamp: item.contract.lastTradeTimestamp,
      })),
      quoteFilter: {
        maximumRelativeSpread: request.maximumRelativeSpread, minimumOpenInterest: request.minimumOpenInterest,
        retained: retained.length, excluded: filtered.length - retained.length,
      },
      rate: { value: rate.rate, mode: rate.mode, sourceSeries: rate.sourceSeries, observationDates: rate.observationDates },
      dividend: {
        selectedMethod: selectedDividendMethod, parityEstimate: parity.value,
        distributionEstimate, matchedPairs: parity.matchedPairs,
      },
      volatility: {
        selectedImpliedVolatility: selectedIv, providerImpliedVolatility: providerIv,
        realised20, realised60, realised252, method: "bid-ask-mid inversion",
      },
    },
  };
}

function fixtureTradingDates(asOfDate: string, count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${asOfDate}T00:00:00Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.reverse();
}

export function createBlackScholesFixtureSnapshot(
  request: MarketDataRequest,
  currentParameters: Record<string, string>,
): MarketSnapshot {
  const expiration = request.optionExpiration || "2027-02-19";
  const spot = 226.43;
  const dates = fixtureTradingDates(request.asOfDate, 320);
  const rawPrices: number[] = [];
  let value = 150;
  for (let index = 0; index < dates.length; index += 1) {
    value *= Math.exp(0.0012 + 0.0115 * Math.sin(index * 1.713) + 0.0062 * Math.cos(index * 0.337));
    rawPrices.push(value);
  }
  const scale = spot / rawPrices.at(-1)!;
  const dividendIndices = new Set([dates.length - 63, dates.length - 126, dates.length - 189, dates.length - 252]);
  const history: YFinanceHistoryPoint[] = dates.map((date, index) => ({
    date, close: rawPrices[index] * scale, adjustedClose: rawPrices[index] * scale,
    volume: 1_000_000 + index * 137, dividends: dividendIndices.has(index) ? 0.24 : 0, splits: 0,
  }));
  const maturity = actual365YearFraction(request.asOfDate, expiration);
  const rate = annualToContinuous(0.0442);
  const dividend = 0.0041;
  const forward = spot * Math.exp((rate - dividend) * maturity);
  const strikes = [180, 195, 210, 220, 225, 230, 240, 255, 270];
  const optionChain: YFinanceOptionContract[] = strikes.flatMap((strike) => {
    const logMoneyness = Math.log(strike / forward);
    const volatility = 0.2142 - 0.07 * logMoneyness + 0.32 * logMoneyness ** 2;
    return (["call", "put"] as const).map((optionType) => {
      const theoretical = blackScholesPrice({
        spot, strike, maturity, rate, dividend, volatility, side: optionType === "call" ? "Call" : "Put",
      });
      const halfSpread = Math.max(0.015, theoretical * (0.018 + Math.abs(logMoneyness) * 0.018));
      return {
        contractSymbol: `AAPL${expiration.replaceAll("-", "")}${optionType === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`,
        optionType, expiration, strike, bid: Math.max(0.001, theoretical - halfSpread), ask: theoretical + halfSpread,
        lastPrice: theoretical, impliedVolatility: volatility + 0.0015,
        openInterest: Math.max(25, Math.round(900 - Math.abs(logMoneyness) * 1800)),
        volume: Math.max(5, Math.round(240 - Math.abs(logMoneyness) * 400)),
        lastTradeTimestamp: `${request.asOfDate}T19:45:00Z`,
      };
    });
  });
  optionChain.push({
    contractSymbol: "AAPL-WIDE-SPREAD", optionType: "call", expiration, strike: 285,
    bid: 0.05, ask: 1.5, lastPrice: 0.4, impliedVolatility: 0.32, openInterest: 3, volume: 0,
    lastTradeTimestamp: `${request.asOfDate}T19:40:00Z`,
  });
  optionChain.push({
    contractSymbol: "AAPL-CROSSED", optionType: "put", expiration, strike: 170,
    bid: 1.2, ask: 0.8, lastPrice: 1, impliedVolatility: 0.29, openInterest: 200, volume: 20,
    lastTradeTimestamp: `${request.asOfDate}T19:40:00Z`,
  });
  const fred: NormalizedFredObservation[] = [
    { seriesId: "DGS3MO", date: request.asOfDate, value: 4.31, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate },
    { seriesId: "DGS6MO", date: request.asOfDate, value: 4.42, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate },
    { seriesId: "DGS1", date: request.asOfDate, value: 4.5, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate },
  ];
  return buildBlackScholesSnapshot({
    request: { ...request, optionExpiration: expiration }, currentParameters,
    quote: {
      symbol: request.instrument, currency: request.currency, timezone: "America/New_York",
      regularMarketPrice: spot, regularMarketTime: `${request.asOfDate}T20:00:00Z`,
    },
    history, expirations: [expiration, "2027-05-21", "2027-08-20"], optionChain,
    optionCurrency: request.currency, fred, createdAt: `${request.asOfDate}T23:00:00Z`,
  });
}
