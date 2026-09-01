import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  approveCaseConditioning,
  branchCaseWithEconomicScenario,
  completeCaseRun,
  createCase,
  deriveCaseReadiness,
  queueCaseRun,
  restoreCaseRevision,
  reviseCase,
  type CaseInputs,
} from "../app/lib/case-state.ts";

const definedCase = (): CaseInputs => ({
  definition: {
    caseName: "AAPL macro comparison",
    instrument: "AAPL",
    valuationDate: "2026-08-24",
    model: "Black–Scholes",
    contractId: "european",
    contractLabel: "European option",
    side: "Call",
    measure: "Q",
    objective: "Value the contract and compare a reviewed macro branch.",
    confirmedAt: "2026-08-24T00:00:00.000Z",
  },
  marketBase: {
    model: "Black–Scholes",
    source: "manual",
    snapshotId: null,
    applicationId: null,
    instrument: "AAPL",
    currency: "USD",
    asOfDate: "2026-08-24",
    measure: "Q",
    appliedAt: null,
    parameters: { spot: "227.16", rate: "0.041", volatility: "0.24" },
  },
  economicScenario: null,
  solverConfiguration: {
    model: "Black–Scholes",
    contractId: "european",
    scheme: "rannacher-cn",
    gridKind: "nonuniform",
    spaceSteps: 200,
    varianceSteps: null,
    timeSteps: 200,
    parameters: { spot: "227.16", strike: "225", maturity: "0.5", rate: "0.041", dividend: "0.005", volatility: "0.24" },
    monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
    validationIssues: [],
  },
});

test("Define → Condition → Solve → Decide remains one auditable case", () => {
  const defined = createCase(definedCase(), { id: "case-e2e", now: "2026-08-24T08:00:00.000Z" });
  assert.equal(deriveCaseReadiness(defined).definition, "complete");

  const conditioned = reviseCase(defined, {
    marketBase: {
      ...defined.core.marketBase,
      source: "snapshot",
      snapshotId: "market-aapl-2026-08-24",
      applicationId: "application-aapl-1",
      appliedAt: "2026-08-24T08:01:00.000Z",
    },
  }, { reason: "Apply reviewed market snapshot", revisionId: "before-market", now: "2026-08-24T08:01:00.000Z" });
  assert.equal(conditioned.core.marketBase.source, "snapshot");

  const scenario = {
    model: "Black–Scholes" as const,
    source: "forecast" as const,
    scenarioId: "cpi-p90",
    forecastRunId: "forecast-2026-08",
    mappingId: "cpi-policy-to-pde",
    mappingVersion: "1.0.0",
    scenarioMeasure: "P" as const,
    baseMarketSnapshotId: "market-aapl-2026-08-24",
    appliedAt: null,
    parameters: [{ id: "rate", baseValue: "0.041", scenarioValue: "0.052", targetMeasure: "Q" as const }],
  };
  const branched = branchCaseWithEconomicScenario(conditioned, scenario, { rate: "0.052" }, {
    reason: "Create reviewed scenario branch",
    revisionId: "before-scenario",
    now: "2026-08-24T08:02:00.000Z",
  });
  assert.equal(branched.core.marketBase.parameters.rate, "0.041");
  assert.equal(branched.core.solverConfiguration.parameters.rate, "0.052");

  const approved = approveCaseConditioning(branched, {
    reason: "Approve market base",
    revisionId: "condition-approved",
    now: "2026-08-24T08:02:30.000Z",
  });
  assert.equal(deriveCaseReadiness(approved).conditioning, "complete");
  const queued = queueCaseRun(approved, { id: "solver-job-e2e", now: "2026-08-24T08:03:00.000Z" });
  const decided = completeCaseRun(queued, "solver-job-e2e", {
    now: "2026-08-24T08:04:00.000Z",
    execution: "worker",
    summary: { primaryValue: 18.72, benchmarkValue: 18.71, accepted: true, warningCount: 0 },
  });
  assert.equal(deriveCaseReadiness(decided).resultState, "current");
  assert.equal(deriveCaseReadiness(decided).decide, "complete");
  assert.equal(decided.core.latestRun?.summary?.primaryValue, 18.72);

  const restored = restoreCaseRevision(decided, "before-scenario", {
    reason: "Branch from the conditioned base checkpoint",
    revisionId: "before-e2e-branch",
    now: "2026-08-24T08:05:00.000Z",
  });
  assert.equal(restored.core.economicScenario, null);
  assert.ok(restored.revisions.some((revision) => revision.id === "before-e2e-branch"));
});

test("the interface exposes one timeline and no separate Run History dashboard", async () => {
  const [page, timeline, workspaces] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/case-timeline-drawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/market-data/types.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<CaseTimelineDrawer/);
  assert.match(page, /Open case timeline/);
  assert.match(timeline, /Inspect, restore or branch/);
  assert.match(timeline, /Restore revision/);
  assert.match(timeline, /Branch from here/);
  assert.match(timeline, /role="dialog"/);
  assert.doesNotMatch(page + workspaces, /run-history|RunHistoryWorkspace/);
});
