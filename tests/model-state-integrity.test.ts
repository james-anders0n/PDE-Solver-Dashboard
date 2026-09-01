import assert from "node:assert/strict";
import test from "node:test";

import {
  approveCaseConditioning,
  checkModelSnapshotCompatibility,
  completeCaseRun,
  createCase,
  deriveCaseReadiness,
  getCaseModelCompatibilityIssues,
  queueCaseRun,
  reviseCase,
  switchCaseModelRevision,
  type Case,
  type CaseInputs,
} from "../app/lib/case-state.ts";
import { applySnapshot, defaultMarketRequest, getMarketAdapter, type MarketSnapshot } from "../app/lib/market-data/index.ts";
import { MODEL_SPECS, defaultParameters, getContractSpec, type ModelKey } from "../app/lib/pde-spec.ts";

const MODELS: ModelKey[] = ["Black–Scholes", "Heston", "Vasicek", "Hull–White", "HJB"];

function manualInputs(model: ModelKey): CaseInputs {
  const contract = MODEL_SPECS[model].contracts[0];
  const request = defaultMarketRequest(model);
  const parameters = defaultParameters(model, contract.id);
  return {
    definition: {
      caseName: `${request.instrument} ${model}`,
      instrument: request.instrument,
      valuationDate: request.asOfDate,
      model,
      contractId: contract.id,
      contractLabel: contract.label,
      side: contract.optionSides?.[0] ?? null,
      measure: MODEL_SPECS[model].measure,
      objective: contract.summary,
      confirmedAt: "2026-08-24T00:00:00.000Z",
    },
    marketBase: {
      model,
      source: "manual",
      snapshotId: null,
      applicationId: null,
      instrument: request.instrument,
      currency: request.currency,
      asOfDate: request.asOfDate,
      measure: MODEL_SPECS[model].measure,
      appliedAt: null,
      parameters,
    },
    economicScenario: null,
    solverConfiguration: {
      model,
      contractId: contract.id,
      scheme: model === "Heston" ? "mcs-adi" : model === "HJB" ? "howard-implicit" : "rannacher-cn",
      gridKind: "nonuniform",
      spaceSteps: model === "Heston" ? 80 : 200,
      varianceSteps: model === "Heston" ? 40 : null,
      timeSteps: model === "Heston" ? 160 : 200,
      parameters,
      monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
      validationIssues: [],
    },
  };
}

async function fixtureSnapshot(model: ModelKey): Promise<MarketSnapshot> {
  const request = {
    ...defaultMarketRequest(model),
    ...(model === "Vasicek" ? { vasicekMeasureMode: "q-curve" as const } : {}),
  };
  const contractId = MODEL_SPECS[model].contracts[0].id;
  return getMarketAdapter(model).preview(request, defaultParameters(model, contractId));
}

function inputsFromAppliedSnapshot(model: ModelKey, snapshot: MarketSnapshot): CaseInputs {
  const base = manualInputs(model);
  const selected = new Set(snapshot.proposals.filter((proposal) => proposal.applicable).map((proposal) => proposal.id));
  const application = applySnapshot(base.solverConfiguration.parameters as Record<string, string>, snapshot, selected);
  const scenarioParameterId = Object.keys(application.parameters)[0];
  const scenarioValue = application.parameters[scenarioParameterId];
  return {
    ...base,
    definition: {
      ...base.definition,
      instrument: snapshot.instrument,
      valuationDate: snapshot.asOfDate,
      measure: snapshot.measure,
    },
    marketBase: {
      model,
      source: "snapshot",
      snapshotId: snapshot.id,
      applicationId: application.history.id,
      instrument: snapshot.instrument,
      currency: snapshot.currency,
      asOfDate: snapshot.asOfDate,
      measure: snapshot.measure,
      appliedAt: application.history.appliedAt,
      parameters: { ...application.parameters },
    },
    economicScenario: {
      model,
      source: "economic-bridge",
      scenarioId: `fixture-scenario-${model}`,
      forecastRunId: null,
      mappingId: `fixture-mapping-${model}`,
      mappingVersion: "1.0.0",
      scenarioMeasure: "P",
      baseMarketSnapshotId: snapshot.id,
      appliedAt: application.history.appliedAt,
      parameters: [{
        id: scenarioParameterId,
        baseValue: scenarioValue,
        scenarioValue,
        targetMeasure: snapshot.measure,
      }],
    },
    solverConfiguration: {
      ...base.solverConfiguration,
      parameters: { ...application.parameters },
    },
  };
}

function assertVisibleStateBelongsToModel(caseState: Case, model: ModelKey, expected: CaseInputs): void {
  const { definition, marketBase, economicScenario, solverConfiguration, latestRun } = caseState.core;
  assert.equal(definition.model, model);
  assert.equal(definition.measure, MODEL_SPECS[model].measure);
  assert.equal(marketBase.model, model);
  assert.equal(marketBase.snapshotId, expected.marketBase.snapshotId);
  assert.equal(marketBase.measure, MODEL_SPECS[model].measure);
  assert.deepEqual(marketBase.parameters, expected.marketBase.parameters);
  assert.equal(economicScenario?.model, model);
  assert.equal(economicScenario?.baseMarketSnapshotId, marketBase.snapshotId);
  assert.equal(solverConfiguration.model, model);
  assert.equal(solverConfiguration.contractId, getContractSpec(model, definition.contractId).id);
  assert.deepEqual(solverConfiguration.parameters, expected.solverConfiguration.parameters);
  assert.equal(latestRun?.model, model);
  assert.equal(latestRun?.contractId, definition.contractId);
  assert.equal(latestRun?.status, "completed");
  assert.deepEqual(getCaseModelCompatibilityIssues(caseState.core), []);
  assert.equal(deriveCaseReadiness(caseState).conditioning, "complete");
  assert.equal(deriveCaseReadiness(caseState).resultState, "current");
}

test("model fixture snapshots, scenarios, solver inputs, and results remain model-scoped through a full round trip", async () => {
  const snapshots = new Map<ModelKey, MarketSnapshot>();
  for (const model of MODELS) snapshots.set(model, await fixtureSnapshot(model));

  const appliedInputs = new Map<ModelKey, CaseInputs>();
  for (const model of MODELS) {
    const snapshot = snapshots.get(model)!;
    assert.deepEqual(checkModelSnapshotCompatibility({ model, measure: MODEL_SPECS[model].measure }, snapshot), []);
    appliedInputs.set(model, inputsFromAppliedSnapshot(model, snapshot));
  }

  let caseState = createCase(appliedInputs.get("Black–Scholes")!, { id: "case-model-round-trip", now: "2026-08-24T00:00:00.000Z" });
  caseState = approveCaseConditioning(caseState, { reason: "Approve Black–Scholes inputs", now: "2026-08-24T00:00:30.000Z" });
  caseState = completeCaseRun(queueCaseRun(caseState, { id: "run-Black–Scholes", now: "2026-08-24T00:01:00.000Z" }), "run-Black–Scholes", {
    now: "2026-08-24T00:02:00.000Z",
    execution: "fixture",
    summary: { primaryValue: 1, benchmarkValue: 1, accepted: true, warningCount: 0 },
  });
  assertVisibleStateBelongsToModel(caseState, "Black–Scholes", appliedInputs.get("Black–Scholes")!);

  for (const [index, model] of MODELS.slice(1).entries()) {
    const now = `2026-08-24T00:${String(3 + index * 3).padStart(2, "0")}:00.000Z`;
    caseState = switchCaseModelRevision(caseState, model, manualInputs(model), {
      reason: `Switch governing model to ${model}`,
      revisionId: `switch-to-${model}`,
      now,
    });
    assert.equal(caseState.core.marketBase.source, "manual");
    assert.equal(caseState.core.marketBase.snapshotId, null, "a first visit must not inherit another model's snapshot ID");
    assert.equal(caseState.core.latestRun, null, "a first visit must not inherit another model's result");

    const applied = appliedInputs.get(model)!;
    caseState = reviseCase(caseState, applied, { reason: `Apply ${model} fixture snapshot`, revisionId: `apply-${model}`, now });
    caseState = approveCaseConditioning(caseState, { reason: `Approve ${model} inputs`, now });
    const runId = `run-${model}`;
    caseState = completeCaseRun(queueCaseRun(caseState, { id: runId, now }), runId, {
      now,
      execution: "fixture",
      summary: { primaryValue: index + 2, benchmarkValue: index + 2, accepted: true, warningCount: 0 },
    });
    assertVisibleStateBelongsToModel(caseState, model, applied);
  }

  for (const [index, model] of [...MODELS].reverse().slice(1).entries()) {
    caseState = switchCaseModelRevision(caseState, model, manualInputs(model), {
      reason: `Return governing model to ${model}`,
      revisionId: `return-to-${model}`,
      now: `2026-08-24T01:${String(index).padStart(2, "0")}:00.000Z`,
    });
    assertVisibleStateBelongsToModel(caseState, model, appliedInputs.get(model)!);
  }

  assert.ok(caseState.revisions.some((revision) => revision.snapshot.definition.model === "HJB"));
  assert.ok(caseState.revisions.some((revision) => revision.snapshot.definition.model === "Hull–White"));
  assert.ok(caseState.revisions.some((revision) => revision.snapshot.definition.model === "Vasicek"));
  assert.ok(caseState.revisions.some((revision) => revision.snapshot.definition.model === "Heston"));
});

test("incompatible model or measure provenance blocks Condition and solver queueing", async () => {
  const hestonSnapshot = await fixtureSnapshot("Heston");
  const invalid = createCase({
    ...manualInputs("Black–Scholes"),
    marketBase: {
      ...manualInputs("Black–Scholes").marketBase,
      model: hestonSnapshot.model,
      source: "snapshot",
      snapshotId: hestonSnapshot.id,
      applicationId: "incompatible-application",
      measure: hestonSnapshot.measure,
    },
  }, { id: "case-incompatible" });

  assert.ok(getCaseModelCompatibilityIssues(invalid.core).some((issue) => issue.includes("Heston market snapshot")));
  assert.equal(deriveCaseReadiness(invalid).conditioning, "in-progress");
  assert.equal(deriveCaseReadiness(invalid).solve, "not-started");
  assert.throws(() => queueCaseRun(invalid, { id: "must-not-run" }), /blocked by invalid or incompatible case state/);
});
