import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultCaseDefinition, validateCaseDefinition } from "../app/lib/case-definition.ts";
import {
  approveCaseConditioning,
  changeCaseContractRevision,
  completeCaseRun,
  createCase,
  deriveCaseReadiness,
  queueCaseRun,
  type CaseInputs,
} from "../app/lib/case-state.ts";
import { MODEL_KEYS, MODEL_SPECS, defaultParameters, type ModelKey } from "../app/lib/pde-spec.ts";

const CONFIRMED_AT = "2026-08-26T01:00:00.000Z";

function inputs(model: ModelKey): CaseInputs {
  const definition = {
    ...createDefaultCaseDefinition({ model, instrument: model === "Vasicek" || model === "Hull–White" ? "SOFR" : "AAPL", valuationDate: "2026-08-26" }),
    confirmedAt: CONFIRMED_AT,
  };
  const parameters = defaultParameters(model, definition.contractId);
  return {
    definition,
    marketBase: {
      model,
      source: "manual",
      snapshotId: null,
      applicationId: null,
      instrument: definition.instrument,
      currency: "USD",
      asOfDate: definition.valuationDate,
      measure: MODEL_SPECS[model].measure,
      appliedAt: null,
      parameters,
    },
    economicScenario: null,
    solverConfiguration: {
      model,
      contractId: definition.contractId,
      scheme: model === "Heston" ? "mcs-adi" : model === "HJB" ? "howard-implicit" : "rannacher-cn",
      gridKind: "nonuniform",
      spaceSteps: model === "Heston" ? 80 : 200,
      varianceSteps: model === "Heston" ? 40 : null,
      timeSteps: 200,
      parameters,
      monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
      validationIssues: [],
    },
  };
}

test("each supported model creates a metadata-driven valid explicit problem definition", () => {
  for (const model of MODEL_KEYS) {
    const draft = createDefaultCaseDefinition({ model, instrument: "TEST", valuationDate: "2026-08-26" });
    const modelSpec = MODEL_SPECS[model];
    assert.equal(draft.contractId, modelSpec.contracts[0].id);
    assert.equal(draft.measure, modelSpec.measure);
    assert.equal(draft.side, modelSpec.contracts[0].optionSides?.[0] ?? null);
    assert.deepEqual(validateCaseDefinition(draft), ["Save the problem definition before continuing."]);
    assert.deepEqual(validateCaseDefinition({ ...draft, confirmedAt: CONFIRMED_AT }), []);
  }
});

test("contract changes use model metadata, reset incompatible sides, and preserve the old revision", () => {
  const created = createCase(inputs("Black–Scholes"), { id: "case-contract", now: CONFIRMED_AT });
  const approved = approveCaseConditioning(created, { reason: "Approve market base" });
  const completed = completeCaseRun(queueCaseRun(approved, { id: "run-before-contract" }), "run-before-contract", {
    execution: "worker",
    summary: { primaryValue: 8.4, benchmarkValue: 8.4, accepted: true, warningCount: 0 },
  });
  const nextParameters = defaultParameters("Black–Scholes", "american-put");
  const changed = changeCaseContractRevision(completed, "american-put", nextParameters, {
    reason: "Change to American put",
    revisionId: "contract-american-put",
    now: "2026-08-26T01:10:00.000Z",
  });

  assert.equal(changed.core.definition.contractId, "american-put");
  assert.equal(changed.core.definition.side, "Put");
  assert.equal(changed.core.definition.confirmedAt, null);
  assert.equal(changed.core.solverConfiguration.contractId, "american-put");
  assert.equal(changed.core.economicScenario, null);
  assert.equal(changed.revisions.at(-1)?.snapshot.definition.contractId, "european");
  assert.equal(changed.revisions.at(-1)?.snapshot.latestRun?.id, "run-before-contract");
  assert.equal(deriveCaseReadiness(changed).resultState, "stale");
  assert.equal(deriveCaseReadiness(changed).definition, "in-progress");
});

test("rate-model contract changes add only the selected contract's metadata parameters", () => {
  const created = createCase(inputs("Vasicek"), { id: "case-rate-contract" });
  const parameters = defaultParameters("Vasicek", "bond-option");
  const changed = changeCaseContractRevision(created, "bond-option", parameters, { reason: "Select bond option" });
  assert.equal(changed.core.definition.contractLabel, "Bond option");
  assert.equal(changed.core.definition.side, null);
  assert.equal(changed.core.solverConfiguration.parameters.bondMaturity, "10");
  assert.equal(changed.core.solverConfiguration.parameters.strike, "0.75");
});

test("invalid, implicit, and model-incompatible definitions fail the Define gate", () => {
  const valid = inputs("Black–Scholes").definition;
  const invalid = {
    ...valid,
    caseName: "",
    instrument: "",
    valuationDate: "26/08/2026",
    contractId: "bond-option",
    side: "Put" as const,
    measure: "P" as const,
    objective: "",
    confirmedAt: null,
  };
  const issues = validateCaseDefinition(invalid);
  assert.ok(issues.includes("Enter a case name."));
  assert.ok(issues.includes("Select an instrument."));
  assert.ok(issues.includes("Enter a valid valuation date."));
  assert.ok(issues.includes("Select a contract compatible with Black–Scholes."));
  assert.ok(issues.includes("Black–Scholes requires the Q-measure."));
  assert.ok(issues.includes("Define the case objective."));
  assert.ok(issues.includes("Save the problem definition before continuing."));

  const caseState = createCase({ ...inputs("Black–Scholes"), definition: invalid }, { id: "case-invalid-definition" });
  assert.equal(deriveCaseReadiness(caseState).definition, "in-progress");
  assert.equal(deriveCaseReadiness(caseState).conditioning, "not-started");
  assert.throws(() => queueCaseRun(caseState, { id: "invalid-run" }), /invalid or incompatible case state/);
});

test("an incompatible contract cannot create or discard a case revision", () => {
  const created = createCase(inputs("Heston"), { id: "case-incompatible-contract" });
  assert.throws(
    () => changeCaseContractRevision(created, "barrier", defaultParameters("Black–Scholes", "barrier"), { reason: "Invalid contract" }),
    /barrier is not compatible with Heston/,
  );
  assert.equal(created.core.definition.contractId, "european");
  assert.equal(created.revisions.length, 0);
});
