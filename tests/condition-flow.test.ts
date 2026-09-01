import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ConditionPrimaryAction } from "../app/components/condition-primary-action.ts";
import { approveCaseConditioning, createCase, deriveCaseReadiness, queueCaseRun, reviseCase, type CaseInputs } from "../app/lib/case-state.ts";
import { deriveConditionPrimaryAction, isPendingBaseApplication } from "../app/lib/condition-flow.ts";
import { defaultParameters, validateParameterFields } from "../app/lib/pde-spec.ts";

const renderAction = (action: ReturnType<typeof deriveConditionPrimaryAction>) => renderToStaticMarkup(
  createElement(ConditionPrimaryAction, { action, onAction() {} }),
);

const baseAction = {
  hasUnappliedSnapshot: false,
  canApplyMarket: false,
  selectedChangeCount: 0,
  requiredMeasure: "Q" as const,
  conditioningApproved: false,
};

function barrierInputs(): CaseInputs {
  const parameters = { ...defaultParameters("Black–Scholes", "barrier"), spot: "100", barrier: "120" };
  return {
    definition: {
      caseName: "Barrier approval",
      instrument: "AAPL",
      valuationDate: "2026-08-27",
      model: "Black–Scholes",
      contractId: "barrier",
      contractLabel: "Barrier",
      side: "Call",
      measure: "Q",
      objective: "Value an up-and-out option.",
      confirmedAt: "2026-08-27T01:00:00.000Z",
    },
    marketBase: {
      model: "Black–Scholes",
      source: "manual",
      snapshotId: null,
      applicationId: null,
      instrument: "AAPL",
      currency: "USD",
      asOfDate: "2026-08-27",
      measure: "Q",
      appliedAt: null,
      parameters,
    },
    economicScenario: null,
    conditionApproval: null,
    solverConfiguration: {
      model: "Black–Scholes",
      contractId: "barrier",
      scheme: "rannacher-cn",
      gridKind: "nonuniform",
      spaceSteps: 200,
      varianceSteps: null,
      timeSteps: 200,
      parameters,
      monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
      validationIssues: [],
    },
  };
}

test("manual inputs end with one explicit market-base approval action", () => {
  const action = deriveConditionPrimaryAction(baseAction);
  const html = renderAction(action);
  assert.equal(action.kind, "approve-inputs");
  assert.match(html, /data-condition-action="approve-inputs"/);
  assert.match(html, /Approve market base/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);

  const created = createCase(barrierInputs(), { id: "manual-case" });
  assert.throws(() => queueCaseRun(created, { id: "premature-run" }), /Approve the market base/);
  const approved = approveCaseConditioning(created, { reason: "Approve market base" });
  assert.equal(deriveCaseReadiness(approved).conditioning, "complete");
  assert.equal(queueCaseRun(approved, { id: "approved-run" }).core.latestRun?.status, "queued");
});

test("fixture evidence exposes the quantified base-application consequence", () => {
  const action = deriveConditionPrimaryAction({
    ...baseAction,
    hasUnappliedSnapshot: true,
    canApplyMarket: true,
    selectedChangeCount: 5,
  });
  assert.equal(action.kind, "apply-market");
  assert.match(renderAction(action), /Apply 5 changes to Q base/);
});

test("Vasicek historical P evidence does not block approval of the separate Q pricing base", () => {
  const pendingBase = isPendingBaseApplication({
    hasSnapshot: true,
    appliedMarketSnapshot: false,
    compatibilityIssueCount: 1,
  });
  assert.equal(pendingBase, false);
  const action = deriveConditionPrimaryAction({
    ...baseAction,
    hasUnappliedSnapshot: pendingBase,
  });
  assert.equal(action.kind, "approve-inputs");
  assert.match(renderAction(action), /Approve market base/);
});

test("a spot update that crosses an up-and-out barrier invalidates approval and locates one field error", () => {
  const created = createCase(barrierInputs(), { id: "barrier-case" });
  const approved = approveCaseConditioning(created, { reason: "Approve market base" });
  const updatedParameters = { ...approved.core.solverConfiguration.parameters, spot: "125" };
  const issues = validateParameterFields("Black–Scholes", "barrier", updatedParameters as Record<string, string>, { barrierType: "Up & out" });
  assert.deepEqual(issues, [{ fieldId: "barrier", message: "An up-and-out barrier H must be above spot S₀ for a live contract." }]);

  const changed = reviseCase(approved, {
    marketBase: { ...approved.core.marketBase, parameters: { ...approved.core.marketBase.parameters, spot: "125" } },
    solverConfiguration: { ...approved.core.solverConfiguration, parameters: updatedParameters, validationIssues: issues.map((issue) => issue.message) },
  }, { reason: "Apply spot update" });
  assert.equal(deriveCaseReadiness(changed).conditioning, "in-progress");
  const action = deriveConditionPrimaryAction(baseAction);
  assert.equal(action.kind, "approve-inputs");
  assert.match(renderAction(action), /Approve market base/);
});
