import assert from "node:assert/strict";
import test from "node:test";

import {
  approveCaseConditioning,
  branchCaseToMarketBase,
  branchCaseWithEconomicScenario,
  completeCaseRun,
  createCase,
  deriveCaseReadiness,
  isCaseConditioningApproved,
  queueCaseRun,
  restoreCaseRevision,
  reviseCase,
  type CaseInputs,
} from "../app/lib/case-state.ts";

const approve = (caseState: ReturnType<typeof createCase>, suffix: string) => approveCaseConditioning(caseState, {
  reason: "Approve market base",
  revisionId: `condition-approved-${suffix}`,
  now: "2026-08-24T08:00:30.000Z",
});

const baseInputs = (): CaseInputs => ({
  definition: {
    caseName: "AAPL European call",
    instrument: "AAPL",
    valuationDate: "2026-08-21",
    model: "Black–Scholes",
    contractId: "european",
    contractLabel: "European option",
    side: "Call",
    measure: "Q",
    objective: "Value the contract and validate the numerical result.",
    confirmedAt: "2026-08-24T00:00:00.000Z",
  },
  marketBase: {
    model: "Black–Scholes",
    source: "snapshot",
    snapshotId: "market-aapl-2026-08-21",
    applicationId: "application-1",
    instrument: "AAPL",
    currency: "USD",
    asOfDate: "2026-08-21",
    measure: "Q",
    appliedAt: "2026-08-24T08:00:00.000Z",
    parameters: { spot: "226.43", rate: "0.041", volatility: "0.24" },
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
    parameters: { spot: "226.43", strike: "220", maturity: "0.5", rate: "0.041", dividend: "0.005", volatility: "0.24" },
    monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
    validationIssues: [],
  },
});

test("an upstream change preserves the completed run and marks it stale", () => {
  const created = createCase(baseInputs(), { id: "case-1", now: "2026-08-24T08:00:00.000Z" });
  const queued = queueCaseRun(approve(created, "upstream"), { id: "solver-job-1", now: "2026-08-24T08:01:00.000Z" });
  const completed = completeCaseRun(queued, "solver-job-1", {
    now: "2026-08-24T08:02:00.000Z",
    execution: "worker",
    summary: { primaryValue: 19.42, benchmarkValue: 19.41, accepted: true, warningCount: 0 },
  });
  assert.equal(deriveCaseReadiness(completed).resultState, "current");

  const changed = reviseCase(completed, {
    solverConfiguration: { ...completed.core.solverConfiguration, spaceSteps: 400 },
  }, { reason: "Refine the spatial grid", revisionId: "before-grid-change", now: "2026-08-24T08:03:00.000Z" });

  assert.equal(changed.core.latestRun?.id, "solver-job-1");
  assert.equal(changed.core.latestRun?.summary?.primaryValue, 19.42);
  assert.equal(deriveCaseReadiness(changed).resultState, "stale");
  assert.deepEqual(deriveCaseReadiness(changed).staleReasons, ["The solver configuration changed after the run."]);
});

test("Solve-stage changes preserve approved market conditioning", () => {
  const created = createCase(baseInputs(), { id: "case-solve-settings", now: "2026-08-24T08:00:00.000Z" });
  const approved = approve(created, "solve-settings");
  const executionChanged = reviseCase(approved, {
    solverConfiguration: {
      ...approved.core.solverConfiguration,
      scheme: "backward-euler",
      gridKind: "uniform",
      spaceSteps: 320,
      timeSteps: 252,
      monteCarlo: { enabled: true, paths: 10_000, timeSteps: 252, seed: 20_250_308 },
    },
  }, { reason: "Configure Solve execution", revisionId: "before-solve-settings", now: "2026-08-24T08:01:00.000Z" });

  assert.equal(isCaseConditioningApproved(executionChanged.core), true);
  assert.equal(deriveCaseReadiness(executionChanged).conditioning, "complete");
  assert.equal(queueCaseRun(executionChanged, { id: "solver-job-with-mc" }).core.latestRun?.status, "queued");

  const conditionedParameterChanged = reviseCase(executionChanged, {
    solverConfiguration: {
      ...executionChanged.core.solverConfiguration,
      parameters: { ...executionChanged.core.solverConfiguration.parameters, volatility: "0.30" },
    },
  }, { reason: "Change conditioned volatility", revisionId: "before-volatility", now: "2026-08-24T08:02:00.000Z" });
  assert.equal(isCaseConditioningApproved(conditionedParameterChanged.core), true);
  assert.equal(deriveCaseReadiness(conditionedParameterChanged).conditioning, "complete");
});

test("an economic scenario stays separate from the calibrated market base", () => {
  const inputs = baseInputs();
  const created = createCase(inputs, { id: "case-2", now: "2026-08-24T08:00:00.000Z" });
  const scenario = {
    model: "Black–Scholes" as const,
    source: "forecast" as const,
    scenarioId: "cpi-p90",
    forecastRunId: "cpi-2026-08",
    mappingId: "cpi-policy-to-pde",
    mappingVersion: "1.0.0",
    scenarioMeasure: "P" as const,
    baseMarketSnapshotId: "market-aapl-2026-08-21",
    appliedAt: "2026-08-24T08:05:00.000Z",
    parameters: [{ id: "rate", baseValue: "0.041", scenarioValue: "0.052", targetMeasure: "Q" as const }],
  };
  const conditioned = reviseCase(created, {
    economicScenario: scenario,
    solverConfiguration: {
      ...created.core.solverConfiguration,
      parameters: { ...created.core.solverConfiguration.parameters, rate: "0.052" },
    },
  }, { reason: "Apply reviewed CPI scenario", revisionId: "before-scenario", now: "2026-08-24T08:05:00.000Z" });

  assert.equal(conditioned.core.marketBase.parameters.rate, "0.041");
  assert.equal(inputs.marketBase.parameters.rate, "0.041", "case updates must not mutate their source objects");
  assert.equal(conditioned.core.economicScenario?.parameters[0].scenarioValue, "0.052");
  assert.equal(conditioned.core.solverConfiguration.parameters.rate, "0.052");
});

test("a previous case revision can be restored without losing the audit trail", () => {
  const created = createCase(baseInputs(), { id: "case-3", now: "2026-08-24T08:00:00.000Z" });
  const changed = reviseCase(created, {
    solverConfiguration: {
      ...created.core.solverConfiguration,
      parameters: { ...created.core.solverConfiguration.parameters, volatility: "0.30" },
    },
  }, { reason: "Test a higher-volatility input", revisionId: "before-volatility-change", now: "2026-08-24T08:10:00.000Z" });
  const restored = restoreCaseRevision(changed, "before-volatility-change", {
    reason: "Restore the calibrated case",
    revisionId: "before-restoration",
    now: "2026-08-24T08:11:00.000Z",
  });

  assert.equal(restored.core.solverConfiguration.parameters.volatility, "0.24");
  assert.equal(restored.revisions.length, 2);
  assert.ok(restored.revisions.some((revision) => revision.id === "before-volatility-change"));
  assert.equal(restored.revisions.find((revision) => revision.id === "before-restoration")?.snapshot.solverConfiguration.parameters.volatility, "0.30");
});

test("applying a P-measure scenario creates a revision without overwriting the Q base or running the solver", () => {
  const created = createCase(baseInputs(), { id: "case-4", now: "2026-08-24T08:00:00.000Z" });
  const queued = queueCaseRun(approve(created, "scenario"), { id: "solver-job-base", now: "2026-08-24T08:01:00.000Z" });
  const completed = completeCaseRun(queued, "solver-job-base", {
    now: "2026-08-24T08:02:00.000Z",
    execution: "worker",
    summary: { primaryValue: 19.42, benchmarkValue: 19.41, accepted: true, warningCount: 0 },
  });
  const scenario = {
    model: "Black–Scholes" as const,
    source: "forecast" as const,
    scenarioId: "cpi-p90",
    forecastRunId: "cpi-2026-08",
    mappingId: "cpi-policy-to-pde",
    mappingVersion: "1.0.0",
    scenarioMeasure: "P" as const,
    baseMarketSnapshotId: "market-aapl-2026-08-21",
    appliedAt: null,
    parameters: [{ id: "rate", baseValue: "0.041", scenarioValue: "0.052", targetMeasure: "Q" as const }],
  };

  const branched = branchCaseWithEconomicScenario(completed, scenario, { rate: "0.052" }, {
    reason: "Create reviewed CPI branch",
    revisionId: "before-cpi-branch",
    now: "2026-08-24T08:05:00.000Z",
  });

  assert.equal(branched.core.marketBase.parameters.rate, "0.041");
  assert.equal(branched.core.marketBase.measure, "Q");
  assert.equal(branched.core.economicScenario?.scenarioMeasure, "P");
  assert.equal(branched.core.economicScenario?.appliedAt, "2026-08-24T08:05:00.000Z");
  assert.equal(branched.core.solverConfiguration.parameters.rate, "0.052");
  assert.equal(branched.core.latestRun?.id, "solver-job-base", "branching must not queue a solver run");
  assert.equal(deriveCaseReadiness(branched).resultState, "stale");
  assert.equal(branched.revisions.length, completed.revisions.length + 1);

  const baseOnly = branchCaseToMarketBase(branched, {
    reason: "Return to base",
    revisionId: "before-base-branch",
    now: "2026-08-24T08:06:00.000Z",
  });
  assert.equal(baseOnly.core.economicScenario, null);
  assert.equal(baseOnly.core.solverConfiguration.parameters.rate, "0.041");
  assert.equal(baseOnly.revisions.length, branched.revisions.length + 1);
});

test("a scenario cannot branch from a different market snapshot", () => {
  const created = createCase(baseInputs(), { id: "case-5", now: "2026-08-24T08:00:00.000Z" });
  assert.throws(() => branchCaseWithEconomicScenario(created, {
    model: "Black–Scholes",
    source: "forecast",
    scenarioId: "wrong-base",
    forecastRunId: "forecast-1",
    mappingId: "mapping-1",
    mappingVersion: "1",
    scenarioMeasure: "P",
    baseMarketSnapshotId: "some-other-snapshot",
    appliedAt: null,
    parameters: [],
  }, {}, { reason: "Invalid branch" }), /current market base/);
});

test("starting a subsequent solver run preserves the prior run as a case revision", () => {
  const created = createCase(baseInputs(), { id: "case-runs", now: "2026-08-24T08:00:00.000Z" });
  const first = completeCaseRun(queueCaseRun(approve(created, "runs"), { id: "solver-job-first", now: "2026-08-24T08:01:00.000Z" }), "solver-job-first", {
    now: "2026-08-24T08:02:00.000Z",
    execution: "worker",
    summary: { primaryValue: 19.42, benchmarkValue: 19.41, accepted: true, warningCount: 0 },
  });
  const second = queueCaseRun(first, { id: "solver-job-second", now: "2026-08-24T08:03:00.000Z" });

  assert.equal(second.core.latestRun?.id, "solver-job-second");
  assert.equal(second.revisions.at(-1)?.snapshot.latestRun?.id, "solver-job-first");
  assert.match(second.revisions.at(-1)?.reason ?? "", /Queue solver run solver-job-second/);
});
