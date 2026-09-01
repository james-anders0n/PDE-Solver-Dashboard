import type { ModelKey } from "@/app/lib/pde-spec";
import { createFixtureSnapshot } from "./fixtures.ts";
import { annualToContinuous, percentToDecimal } from "./normalization.ts";
import type { MarketDataRequest, MarketSnapshot } from "./types.ts";
import type { NormalizedFredObservation } from "./fred-client.ts";
import type { YFinanceQuote } from "./yfinance-client.ts";

export function createPartialLiveSnapshot(options: {
  request: MarketDataRequest;
  currentParameters: Record<string, string>;
  quote?: YFinanceQuote;
  fred?: NormalizedFredObservation[];
  providerErrors: string[];
}): MarketSnapshot {
  const base = createFixtureSnapshot({ ...options.request, sourceMode: "fixture" }, options.currentParameters);
  const lastFred = options.fred?.at(-1);
  const rate = lastFred ? annualToContinuous(percentToDecimal(lastFred.value)) : null;
  const observedIds = new Set<string>();
  const proposals = base.proposals.map((item) => {
    if (item.id === "spot" && options.quote) {
      observedIds.add(item.id);
      return {
        ...item,
        proposedValue: String(options.quote.regularMarketPrice),
        currentValue: options.currentParameters[item.id] ?? "—",
        selected: true,
        applicable: true,
        warning: undefined,
        classification: "observed" as const,
        provenance: {
          ...item.provenance,
          provider: "yfinance" as const,
          sourceIdentifiers: [options.quote.symbol],
          observationTimestamp: options.quote.regularMarketTime,
          formula: "regularMarketPrice",
        },
      };
    }
    const rateId = options.request.model === "Vasicek" || options.request.model === "Hull–White" ? "shortRate" : "rate";
    if (item.id === rateId && lastFred && rate != null) {
      observedIds.add(item.id);
      return {
        ...item,
        proposedValue: rate.toFixed(8),
        currentValue: options.currentParameters[item.id] ?? "—",
        selected: true,
        applicable: true,
        warning: undefined,
        classification: options.request.model === "Hull–White" ? "proxy" as const : "observed" as const,
        provenance: {
          ...item.provenance,
          provider: "FRED" as const,
          sourceIdentifiers: [lastFred.seriesId],
          observationTimestamp: `${lastFred.date}T00:00:00Z`,
          availableTimestamp: `${lastFred.realtimeStart}T00:00:00Z`,
          vintage: lastFred.realtimeStart,
          formula: "ln(1 + quoted percent / 100)",
        },
      };
    }
    return {
      ...item,
      selected: false,
      applicable: false,
      warning: "This transformation requires a model-specific live calibration or history payload and was not inferred from incomplete data.",
    };
  });
  const quoteCurrencyIssue = options.quote && options.quote.currency.toUpperCase() !== options.request.currency.toUpperCase()
    ? `Currency mismatch: ${options.quote.currency} quote versus requested ${options.request.currency}.`
    : null;
  const validationIssues = quoteCurrencyIssue ? [quoteCurrencyIssue] : [];
  const liveCount = observedIds.size;
  return {
    ...base,
    id: `live-${options.request.model.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${options.request.instrument.toLowerCase()}-${options.request.asOfDate}`,
    sourceMode: "live",
    freshness: options.providerErrors.length > 0 || liveCount < 2 ? "partial" : "current",
    freshnessMessage: options.providerErrors.length > 0
      ? `Live snapshot retained with provider limitations: ${options.providerErrors.join(" ")}`
      : "Live provider observations loaded. Unsupported transformations remain disabled until their calibration inputs are available.",
    currency: options.quote?.currency ?? options.request.currency,
    proposals,
    observations: [
      ...(options.quote ? [{
        provider: "yfinance" as const,
        identifier: options.quote.symbol,
        value: options.quote.regularMarketPrice,
        observationTimestamp: options.quote.regularMarketTime,
        availableTimestamp: options.quote.regularMarketTime,
        fetchedTimestamp: new Date().toISOString(),
        unit: "price" as const,
        currency: options.quote.currency,
      }] : []),
      ...(lastFred ? [{
        provider: "FRED" as const,
        identifier: lastFred.seriesId,
        value: lastFred.value,
        observationTimestamp: `${lastFred.date}T00:00:00Z`,
        availableTimestamp: `${lastFred.realtimeStart}T00:00:00Z`,
        fetchedTimestamp: new Date().toISOString(),
        vintage: lastFred.realtimeStart,
        unit: "percent" as const,
        currency: "USD",
      }] : []),
    ],
    providerHealth: [
      { provider: "yfinance", state: options.quote ? "current" : "failed", message: options.quote ? "Live quote loaded" : "Quote unavailable" },
      { provider: "FRED", state: lastFred ? "current" : "failed", message: lastFred ? `Live ${lastFred.seriesId} vintage loaded` : "Series unavailable" },
    ],
    validationIssues,
    warnings: [...base.warnings, ...options.providerErrors],
  };
}

export function needsEquityProvider(model: ModelKey): boolean {
  return model === "Black–Scholes" || model === "Heston" || model === "HJB";
}
