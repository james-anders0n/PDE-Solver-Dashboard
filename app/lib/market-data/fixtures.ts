import type { ModelKey } from "@/app/lib/pde-spec";
import { createBlackScholesFixtureSnapshot } from "./black-scholes-snapshot.ts";
import { createHestonFixtureSnapshot } from "./heston-snapshot.ts";
import { createHullWhiteFixtureSnapshot } from "./hull-white-curve.ts";
import { createMertonOpportunityFixtureSnapshot } from "./merton-opportunity.ts";
import { createVasicekFixtureSnapshot } from "./vasicek-snapshot.ts";
import type { MarketDataRequest, MarketSnapshot } from "./types.ts";

const workspaceLabels: Record<ModelKey, string> = {
  "Black–Scholes": "Equity Snapshot",
  Heston: "Volatility Surface",
  Vasicek: "Rate-history fit",
  "Hull–White": "Curve snapshot",
  HJB: "Opportunity set",
};

export function createFixtureSnapshot(request: MarketDataRequest, current: Record<string, string>): MarketSnapshot {
  if (request.model === "Black–Scholes") return createBlackScholesFixtureSnapshot(request, current);
  if (request.model === "Heston") return createHestonFixtureSnapshot(request, current);
  if (request.model === "Vasicek") return createVasicekFixtureSnapshot(request, current);
  if (request.model === "Hull–White") return createHullWhiteFixtureSnapshot(request, current);
  return createMertonOpportunityFixtureSnapshot(request, current);
}

export const marketWorkspaceLabel = (model: ModelKey): string => workspaceLabels[model];
