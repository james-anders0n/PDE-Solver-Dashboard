import type { AppliedSnapshotHistory, ApplySnapshotResult, MarketSnapshot } from "./types.ts";

const DAY_MS = 86_400_000;

export function parseFredValue(value: string | number | null | undefined): number | null {
  if (value == null || value === "." || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function percentToDecimal(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Percentage must be finite.");
  return value / 100;
}

export function annualToContinuous(rate: number): number {
  if (!Number.isFinite(rate) || rate <= -1) throw new Error("Annual rate must be finite and greater than -100%.");
  return Math.log1p(rate);
}

export function actual365YearFraction(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new Error("Maturity must be after the valuation date.");
  }
  return (endTime - startTime) / (365 * DAY_MS);
}

export function freshnessFromDates(asOfDate: string, observationDate: string, maximumAgeDays: number): "current" | "stale" {
  const age = (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${observationDate}T00:00:00Z`)) / DAY_MS;
  if (!Number.isFinite(age)) throw new Error("Freshness dates must be valid ISO dates.");
  return age <= maximumAgeDays ? "current" : "stale";
}

export function currencyIssue(instrumentCurrency: string, marketCurrency: string, proxyConfirmed = false): string | null {
  if (instrumentCurrency.toUpperCase() === marketCurrency.toUpperCase()) return null;
  if (proxyConfirmed) return null;
  return `Currency mismatch: ${instrumentCurrency.toUpperCase()} instrument versus ${marketCurrency.toUpperCase()} market data.`;
}

export function selectedChangedProposalIds(snapshot: MarketSnapshot): string[] {
  return snapshot.proposals
    .filter((proposal) => proposal.selected && proposal.applicable && proposal.currentValue !== proposal.proposedValue)
    .map((proposal) => proposal.id);
}

export function applySnapshot(
  currentParameters: Record<string, string>,
  snapshot: MarketSnapshot,
  selectedIds: ReadonlySet<string>,
  appliedAt = new Date().toISOString(),
): ApplySnapshotResult {
  if (snapshot.validationIssues.length > 0) throw new Error("A snapshot with validation errors cannot be applied.");
  const next = { ...currentParameters };
  const selectedParameterIds: string[] = [];
  const excludedParameterIds: string[] = [];
  for (const proposal of snapshot.proposals) {
    if (selectedIds.has(proposal.id) && proposal.applicable) {
      next[proposal.id] = proposal.proposedValue;
      selectedParameterIds.push(proposal.id);
    } else {
      excludedParameterIds.push(proposal.id);
    }
  }
  const history: AppliedSnapshotHistory = {
    id: `apply-${snapshot.id}-${appliedAt}`,
    snapshot,
    appliedAt,
    previousParameters: { ...currentParameters },
    appliedParameters: { ...next },
    selectedParameterIds,
    excludedParameterIds,
    associatedSolverRunIds: [],
  };
  return { parameters: next, history };
}

export function restoreSnapshotInputs(history: AppliedSnapshotHistory): Record<string, string> {
  return { ...history.previousParameters };
}
