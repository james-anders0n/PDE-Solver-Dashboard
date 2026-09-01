import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { CaseStatusSummary } from "../app/components/case-status-summary.ts";
import {
  approveCaseConditioning,
  completeCaseRun,
  createCase,
  deriveCaseReadiness,
  finishCaseRun,
  queueCaseRun,
  reviseCase,
  type Case,
  type CaseInputs,
  type CaseRunOrigin,
} from "../app/lib/case-state.ts";

function inputs(): CaseInputs {
  return {
    definition: {
      caseName: "AAPL European call",
      instrument: "AAPL",
      valuationDate: "2026-08-21",
      model: "Black–Scholes",
      contractId: "european",
      contractLabel: "European",
      side: "Call",
      measure: "Q",
      objective: "Price a European call.",
      confirmedAt: "2026-08-24T00:00:00.000Z",
    },
    marketBase: {
      model: "Black–Scholes",
      source: "manual",
      snapshotId: null,
      applicationId: null,
      instrument: "AAPL",
      currency: "USD",
      asOfDate: "2026-08-21",
      measure: "Q",
      appliedAt: null,
      parameters: { spot: 100, volatility: 0.2, rate: 0.05 },
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
      parameters: { spot: 100, strike: 100, maturity: 1, volatility: 0.2, rate: 0.05 },
      monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
      validationIssues: [],
    },
  };
}

function completed(accepted: boolean, origin: CaseRunOrigin = "user"): Case {
  const created = createCase(inputs(), { id: `case-${origin}-${accepted}` , now: "2026-08-26T00:00:00.000Z" });
  const ready = origin === "sample" ? created : approveCaseConditioning(created, { reason: "Approve market base", now: "2026-08-26T00:00:30.000Z" });
  const queued = queueCaseRun(ready, { id: "run-1", origin, execution: origin === "sample" ? "fixture" : "worker", now: "2026-08-26T00:01:00.000Z" });
  return completeCaseRun(queued, "run-1", {
    execution: origin === "sample" ? "fixture" : "worker",
    now: "2026-08-26T00:02:00.000Z",
    summary: { primaryValue: 10.45, benchmarkValue: 10.45, accepted, warningCount: accepted ? 0 : 1 },
  });
}

function render(caseState: Case) {
  const status = deriveCaseReadiness(caseState).status;
  return { status, html: renderToStaticMarkup(createElement(CaseStatusSummary, { status })) };
}

test("the bundled initial state is explicitly labelled as a sample rather than a new user result", () => {
  const { status, html } = render(completed(true, "sample"));
  assert.equal(status.sampleResultLoaded, true);
  assert.equal(status.resultFreshness, "current");
  assert.equal(status.workflowProgress, "in-progress");
  assert.equal(status.stages.decide, "not-started");
  assert.match(html, /Sample result loaded/);
  assert.match(html, /not a result created in this session/);
  assert.match(html, /Result freshness[\s\S]*Current/);
});

test("changed sample inputs make the old sample stale without completing Decide", () => {
  const sample = completed(true, "sample");
  const changed = reviseCase(sample, {
    solverConfiguration: { ...sample.core.solverConfiguration, timeSteps: 240 },
  }, { reason: "Change inputs", now: "2026-08-26T00:03:00.000Z" });
  const { status, html } = render(changed);
  assert.equal(status.resultFreshness, "stale");
  assert.equal(status.workflowProgress, "in-progress");
  assert.equal(status.stages.decide, "not-started");
  assert.match(html, /Result freshness[\s\S]*Stale/);
  assert.doesNotMatch(html, /Current · validated/);
});

test("a running case separates in-progress workflow from result and acceptance state", () => {
  const created = createCase(inputs(), { id: "case-running" });
  const running = queueCaseRun(approveCaseConditioning(created, { reason: "Approve market base" }), { id: "run-running" });
  const { status, html } = render(running);
  assert.equal(status.runActivity, "running");
  assert.equal(status.resultFreshness, "no-result");
  assert.equal(status.workflowProgress, "in-progress");
  assert.equal(status.numericalAcceptance, "not-evaluated");
  assert.match(html, /Workflow progress[\s\S]*In progress/);
  assert.match(html, /Numerical acceptance[\s\S]*Not evaluated/);
});

test("accepted and review results remain current while reporting distinct numerical acceptance", () => {
  const accepted = render(completed(true));
  assert.equal(accepted.status.resultFreshness, "current");
  assert.equal(accepted.status.workflowProgress, "complete");
  assert.equal(accepted.status.numericalAcceptance, "passed");
  assert.match(accepted.html, /Numerical acceptance[\s\S]*Passed/);

  const review = render(completed(false));
  assert.equal(review.status.resultFreshness, "current");
  assert.equal(review.status.workflowProgress, "complete");
  assert.equal(review.status.numericalAcceptance, "review");
  assert.match(review.html, /Result freshness[\s\S]*Current/);
  assert.match(review.html, /Numerical acceptance[\s\S]*Review/);
  assert.doesNotMatch(review.html, /validated/i);
});

test("failed and stale outcomes preserve independent status meanings", () => {
  const created = createCase(inputs(), { id: "case-failed" });
  const queued = queueCaseRun(approveCaseConditioning(created, { reason: "Approve market base" }), { id: "run-failed" });
  const failed = render(finishCaseRun(queued, "run-failed", "failed", { error: "Worker failure" }));
  assert.equal(failed.status.resultFreshness, "no-result");
  assert.equal(failed.status.workflowProgress, "in-progress");
  assert.equal(failed.status.numericalAcceptance, "failed");
  assert.match(failed.html, /Numerical acceptance[\s\S]*Failed/);

  const current = completed(true);
  const stale = render(reviseCase(current, {
    marketBase: { ...current.core.marketBase, parameters: { ...current.core.marketBase.parameters, spot: 101 } },
  }, { reason: "Refresh spot", now: "2026-08-26T00:04:00.000Z" }));
  assert.equal(stale.status.resultFreshness, "stale");
  assert.equal(stale.status.numericalAcceptance, "passed");
  assert.match(stale.html, /Result freshness[\s\S]*Stale/);
  assert.match(stale.html, /Numerical acceptance[\s\S]*Passed/);
});

test("the rendered status guide explains all three status dimensions accessibly", () => {
  const { html } = render(completed(true));
  assert.match(html, /aria-label="Workflow and result status"/);
  assert.match(html, /<summary>Status guide<\/summary>/);
  assert.match(html, /Result freshness/);
  assert.match(html, /Workflow progress/);
  assert.match(html, /Numerical acceptance/);
});
