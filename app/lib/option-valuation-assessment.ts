import type { CaseDefinition } from "@/app/lib/case-state";
import type { MarketSnapshot } from "@/app/lib/market-data";

export type OptionQuoteStyle = "synthetic-european" | "unverified-listed";

export interface OptionQuoteEvidence {
  snapshotId: string;
  contractSymbol: string;
  instrument: string;
  currency: string;
  side: "Call" | "Put";
  expiration: string;
  strike: number;
  maturity: number;
  bid: number;
  ask: number;
  mid: number;
  relativeSpread: number;
  openInterest: number;
  quoteTimestamp: string;
  sourceMode: "fixture" | "live";
  freshness: MarketSnapshot["freshness"];
  style: OptionQuoteStyle;
}

export type OptionValuationStance = "positive-edge" | "near-fair-value" | "premium-above-model" | "insufficient-evidence";

export function supportsListedOptionValuation(model: CaseDefinition["model"]): boolean {
  return model === "Black–Scholes" || model === "Heston";
}

export interface OptionValuationAssessment {
  stance: OptionValuationStance;
  label: string;
  summary: string;
  sampleOnly: boolean;
  modelValue: number | null;
  quote: OptionQuoteEvidence | null;
  suggestedQuote: OptionQuoteEvidence | null;
  grossEdge: number | null;
  edgeRange: [number, number] | null;
  requiredBuffer: number | null;
  spread: number | null;
  reasons: string[];
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const closeEnough = (left: number, right: number, tolerance: number) => Math.abs(left - right) <= tolerance;

type QuoteCandidate = OptionQuoteEvidence & { forward: number };

function optionQuotesFromSnapshot(options: {
  snapshot: MarketSnapshot | null;
  definition: CaseDefinition;
}): QuoteCandidate[] {
  const { snapshot, definition } = options;
  if (!snapshot || snapshot.model !== definition.model || snapshot.instrument !== definition.instrument) return [];
  if (definition.side !== "Call" && definition.side !== "Put") return [];
  const side = definition.side.toLowerCase() as "call" | "put";
  const style: OptionQuoteStyle = snapshot.sourceMode === "fixture" ? "synthetic-european" : "unverified-listed";
  if (snapshot.blackScholes) {
    return snapshot.blackScholes.instruments.filter((item) => item.optionType === side).map((item) => ({
      snapshotId: snapshot.id,
      contractSymbol: item.contractSymbol,
      instrument: snapshot.instrument,
      currency: snapshot.currency,
      side: definition.side as "Call" | "Put",
      expiration: item.expiration,
      strike: item.strike,
      maturity: item.maturity,
      bid: item.bid,
      ask: item.ask,
      mid: item.mid,
      relativeSpread: item.relativeSpread,
      openInterest: item.openInterest,
      quoteTimestamp: item.lastTradeTimestamp ?? snapshot.observations.find((observation) => observation.identifier.includes(":option-chain:"))?.observationTimestamp ?? snapshot.createdAt,
      sourceMode: snapshot.sourceMode,
      freshness: snapshot.freshness,
      style,
      forward: snapshot.blackScholes!.forward,
    }));
  }
  if (snapshot.heston) {
    return snapshot.heston.instruments.filter((item) => !item.excluded && item.optionType === side).map((item) => ({
      snapshotId: snapshot.id,
      contractSymbol: item.contractSymbol,
      instrument: snapshot.instrument,
      currency: snapshot.currency,
      side: definition.side as "Call" | "Put",
      expiration: item.expiration,
      strike: item.strike,
      maturity: item.maturity,
      bid: item.bid,
      ask: item.ask,
      mid: item.mid,
      relativeSpread: item.mid > 0 ? (item.ask - item.bid) / item.mid : Number.POSITIVE_INFINITY,
      openInterest: item.openInterest,
      quoteTimestamp: item.lastTradeTimestamp ?? snapshot.observations.find((observation) => observation.identifier === snapshot.heston?.surfaceId)?.observationTimestamp ?? snapshot.createdAt,
      sourceMode: snapshot.sourceMode,
      freshness: snapshot.freshness,
      style,
      forward: item.forward,
    }));
  }
  return [];
}

export function findMatchingOptionQuote(options: {
  snapshot: MarketSnapshot | null;
  definition: CaseDefinition;
  parameters: Record<string, string>;
}): OptionQuoteEvidence | null {
  const { snapshot, definition, parameters } = options;
  const strike = Number(parameters.strike);
  const maturity = Number(parameters.maturity);
  if (!finitePositive(strike) || !finitePositive(maturity)) return null;
  const strikeTolerance = Math.max(0.005, strike * 1e-6);
  const maturityTolerance = 2 / 365;
  const match = optionQuotesFromSnapshot({ snapshot, definition }).find((item) => closeEnough(item.strike, strike, strikeTolerance)
    && closeEnough(item.maturity, maturity, maturityTolerance));
  if (!match) return null;
  return match;
}

export function findRepresentativeOptionQuote(options: {
  snapshot: MarketSnapshot | null;
  definition: CaseDefinition;
  parameters: Record<string, string>;
}): OptionQuoteEvidence | null {
  if (options.definition.contractId !== "european") return null;
  const currentMaturity = Number(options.parameters.maturity);
  const candidates = optionQuotesFromSnapshot(options).filter((item) => finitePositive(item.bid)
    && finitePositive(item.ask) && item.ask >= item.bid && finitePositive(item.forward));
  const candidate = candidates.sort((left, right) => {
    const leftMaturity = finitePositive(currentMaturity) ? Math.abs(left.maturity - currentMaturity) : 0;
    const rightMaturity = finitePositive(currentMaturity) ? Math.abs(right.maturity - currentMaturity) : 0;
    return leftMaturity - rightMaturity
      || Math.abs(Math.log(left.strike / left.forward)) - Math.abs(Math.log(right.strike / right.forward))
      || right.openInterest - left.openInterest;
  })[0];
  if (!candidate) return null;
  return candidate;
}

export function alignParametersToOptionQuote(options: {
  snapshot: MarketSnapshot | null;
  definition: CaseDefinition;
  parameters: Record<string, string>;
}): { parameters: Record<string, string>; quote: OptionQuoteEvidence | null; changed: boolean } {
  const exact = findMatchingOptionQuote(options);
  if (exact) return { parameters: { ...options.parameters }, quote: exact, changed: false };
  const quote = findRepresentativeOptionQuote(options);
  if (!quote) return { parameters: { ...options.parameters }, quote: null, changed: false };
  return {
    parameters: {
      ...options.parameters,
      strike: String(quote.strike),
      maturity: String(quote.maturity),
    },
    quote,
    changed: true,
  };
}

export function assessOptionValuation(options: {
  definition: CaseDefinition;
  resultFreshness: "current" | "stale" | "no-result";
  accepted: boolean;
  modelValue: number | null;
  numericalError?: number | null;
  monteCarloInterval?: [number, number] | null;
  parameterStandardDeviation?: number | null;
  quote: OptionQuoteEvidence | null;
  suggestedQuote?: OptionQuoteEvidence | null;
  numericalAcceptanceIssues?: string[];
}): OptionValuationAssessment {
  const reasons: string[] = [];
  const { definition, quote } = options;
  if (options.resultFreshness !== "current") reasons.push("The completed result is not current.");
  if (!options.accepted) {
    if (options.numericalAcceptanceIssues?.length) {
      reasons.push(...options.numericalAcceptanceIssues.map((issue) => `Numerical acceptance: ${issue}`));
    } else {
      reasons.push("Numerical acceptance has not passed.");
    }
  }
  if (options.modelValue == null || !finitePositive(options.modelValue)) reasons.push("A finite positive option value is unavailable.");
  if (!quote) reasons.push("No exact strike, expiry and side quote matches this case.");
  if (!supportsListedOptionValuation(definition.model)) reasons.push("This product does not use a directly comparable listed equity-option premium.");
  if (definition.contractId !== "european") reasons.push("The active contract has no like-for-like exercise style in the snapshot.");
  if (quote && !["current", "fixture"].includes(quote.freshness)) reasons.push("The matching quote is not current.");
  if (quote && quote.style === "unverified-listed") reasons.push("The provider quote does not certify an exercise style matching the solver contract.");
  if (quote && (!finitePositive(quote.bid) || !finitePositive(quote.ask) || quote.ask < quote.bid)) reasons.push("The matching bid and ask are not executable quote evidence.");

  if (reasons.length > 0 || !quote || options.modelValue == null) {
    return {
      stance: "insufficient-evidence",
      label: "Insufficient evidence",
      summary: reasons[0] ?? "A like-for-like executable premium is unavailable.",
      sampleOnly: (quote ?? options.suggestedQuote)?.sourceMode === "fixture",
      modelValue: options.modelValue,
      quote,
      suggestedQuote: options.suggestedQuote ?? null,
      grossEdge: null,
      edgeRange: null,
      requiredBuffer: null,
      spread: quote ? quote.ask - quote.bid : null,
      reasons,
    };
  }

  const spread = quote.ask - quote.bid;
  const numericalBuffer = Math.abs(options.numericalError ?? 0);
  const monteCarloBuffer = options.monteCarloInterval
    ? Math.abs(options.monteCarloInterval[1] - options.monteCarloInterval[0]) / 2
    : 0;
  const parameterBuffer = Math.abs(options.parameterStandardDeviation ?? 0);
  const materialityBuffer = Math.max(0.01, quote.ask * 0.01);
  const requiredBuffer = Math.max(spread / 2, numericalBuffer, monteCarloBuffer, parameterBuffer, materialityBuffer);
  const grossEdge = options.modelValue - quote.ask;
  const edgeRange: [number, number] = [grossEdge - requiredBuffer, grossEdge + requiredBuffer];
  const sampleOnly = quote.sourceMode === "fixture";
  const prefix = sampleOnly ? "Illustrative · " : "";

  if (edgeRange[0] > 0) {
    return {
      stance: "positive-edge",
      label: `${prefix}Potential positive model edge`,
      summary: "Model value remains above the executable ask after the spread and uncertainty buffer.",
      sampleOnly, modelValue: options.modelValue, quote, suggestedQuote: null, grossEdge, edgeRange, requiredBuffer, spread, reasons,
    };
  }
  if (edgeRange[1] < 0) {
    return {
      stance: "premium-above-model",
      label: `${prefix}Premium above model value`,
      summary: "The executable ask remains above model value after the spread and uncertainty buffer.",
      sampleOnly, modelValue: options.modelValue, quote, suggestedQuote: null, grossEdge, edgeRange, requiredBuffer, spread, reasons,
    };
  }
  return {
    stance: "near-fair-value",
    label: `${prefix}Near model fair value`,
    summary: "The difference between model value and ask falls inside the required materiality buffer.",
    sampleOnly, modelValue: options.modelValue, quote, suggestedQuote: null, grossEdge, edgeRange, requiredBuffer, spread, reasons,
  };
}
