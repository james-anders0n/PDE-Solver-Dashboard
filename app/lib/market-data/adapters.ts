import type { ModelKey } from "@/app/lib/pde-spec";
import { createFixtureSnapshot, marketWorkspaceLabel } from "./fixtures.ts";
import type { MarketDataAdapter, MarketDataRequest, MarketSnapshot } from "./types.ts";

class FixtureBackedAdapter implements MarketDataAdapter {
  readonly model: ModelKey;
  readonly workspaceLabel: string;

  constructor(model: ModelKey, workspaceLabel: string) {
    this.model = model;
    this.workspaceLabel = workspaceLabel;
  }

  async preview(request: MarketDataRequest, currentParameters: Record<string, string>): Promise<MarketSnapshot> {
    if (request.model !== this.model) throw new Error(`The ${this.workspaceLabel} adapter cannot serve ${request.model}.`);
    if (request.sourceMode === "live") {
      const response = await fetch("/api/market-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, currentParameters }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "Live providers are unavailable." })) as { error?: string };
        throw new Error(body.error ?? "Live providers are unavailable.");
      }
      return await response.json() as MarketSnapshot;
    }
    return createFixtureSnapshot(request, currentParameters);
  }
}

const adapters = new Map<ModelKey, MarketDataAdapter>([
  "Black–Scholes",
  "Heston",
  "Vasicek",
  "Hull–White",
  "HJB",
].map((model) => [model as ModelKey, new FixtureBackedAdapter(model as ModelKey, marketWorkspaceLabel(model as ModelKey))]));

export function getMarketAdapter(model: ModelKey): MarketDataAdapter {
  const adapter = adapters.get(model);
  if (!adapter) throw new Error(`No market-data adapter exists for ${model}.`);
  return adapter;
}

export const defaultMarketRequest = (model: ModelKey): MarketDataRequest => ({
  model,
  instrument: model === "Vasicek" ? "SOFR" : model === "Hull–White" ? "USD" : "AAPL",
  asOfDate: "2026-08-21",
  currency: "USD",
  fredSeries: model === "Vasicek" ? "SOFR" : model === "HJB" ? "DFF" : "DGS1",
  historyWindow: model === "HJB" ? "252 sessions" : "5 years",
  measureMode: model === "HJB" ? "P" : "Q",
  sourceMode: "fixture",
  optionExpiration: model === "Black–Scholes" ? "2027-02-19" : "",
  optionView: "combined",
  atmMethod: "forward-log-moneyness",
  maximumRelativeSpread: 0.15,
  minimumOpenInterest: 25,
  dividendMethod: "parity",
  hestonExpirationStart: model === "Heston" ? "2026-10-16" : "",
  hestonExpirationEnd: model === "Heston" ? "2027-08-20" : "",
  hestonMoneynessMinimum: -0.25,
  hestonMoneynessMaximum: 0.25,
  hestonMinimumStrikes: 5,
  hestonMinimumExpiries: 3,
  hestonObjective: "iv",
  hestonUseOpenInterest: true,
  hestonCalibrationSeed: 1729,
  hestonMultiStarts: 4,
  hestonMaximumEvaluations: 360,
  hestonIncludeVix: false,
  vasicekWindowStart: "2023-08-21",
  vasicekWindowEnd: "2026-08-21",
  vasicekSampling: "daily",
  vasicekMissingPolicy: "previous-valid",
  vasicekOutlierPolicy: "remove-3sigma",
  vasicekMinimumObservations: 120,
  vasicekMeasureMode: "historical-p",
  vasicekIncludeEtfs: false,
  hullWhiteCurveMode: "treasury-proxy",
  hullWhiteCurveFamily: "sofr-treasury",
  hullWhiteSelectedSeries: ["SOFR", "DGS1MO", "DGS3MO", "DGS6MO", "DGS1", "DGS2", "DGS3", "DGS5", "DGS7", "DGS10", "DGS20", "DGS30"],
  hullWhiteInterpolation: "natural-cubic-log-discount",
  hullWhiteIncludeEtfOptions: false,
  hullWhiteMaximumQuoteAgeDays: 7,
  hjbHistorySessions: 504,
  hjbEstimator: "shrinkage",
  hjbShrinkageWeight: 0.35,
  hjbEquityRiskPremiumPrior: 0.045,
  hjbEwmaHalfLifeSessions: 60,
  hjbVolatilityWindow: 252,
  hjbOpportunityRateSeries: "SOFR",
  hjbRegimeSeries: ["VIXCLS", "T10Y2Y"],
  hjbUsdRateProxyMode: false,
});
