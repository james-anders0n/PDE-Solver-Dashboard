import { validateCaseDefinition } from "./case-definition.ts";
import { MODEL_SPECS, type Measure, type ModelKey, type OptionSide } from "./pde-spec.ts";

export const CASE_SCHEMA_VERSION = "1.0.0" as const;

export type CaseParameterValue = string | number;
export type CaseParameterSet = Record<string, CaseParameterValue>;
export type CaseRunStatus = "queued" | "completed" | "failed" | "cancelled";
export type CaseResultState = "missing" | "queued" | "current" | "stale" | "failed" | "cancelled";
export type CaseStageState = "not-started" | "in-progress" | "complete";
export type CaseResultFreshness = "current" | "stale" | "no-result";
export type CaseWorkflowProgress = "not-started" | "in-progress" | "complete";
export type CaseNumericalAcceptance = "passed" | "review" | "failed" | "not-evaluated";
export type CaseRunActivity = "idle" | "running" | "failed" | "cancelled";
export type CaseRunOrigin = "sample" | "user";

export interface CaseDefinition {
  caseName: string;
  instrument: string;
  valuationDate: string;
  model: ModelKey;
  contractId: string;
  contractLabel: string;
  side: OptionSide | null;
  measure: Measure;
  objective: string;
  confirmedAt: string | null;
}

export interface CaseMarketBase {
  model: ModelKey;
  source: "manual" | "snapshot";
  snapshotId: string | null;
  applicationId: string | null;
  instrument: string;
  currency: string;
  asOfDate: string;
  measure: Measure;
  appliedAt: string | null;
  parameters: CaseParameterSet;
}

export interface CaseScenarioParameter {
  id: string;
  baseValue: CaseParameterValue;
  scenarioValue: CaseParameterValue;
  targetMeasure: Measure;
}

export interface CaseEconomicScenario {
  model: ModelKey;
  source: "forecast" | "economic-bridge";
  scenarioId: string;
  forecastRunId: string | null;
  mappingId: string;
  mappingVersion: string;
  scenarioMeasure: "P";
  baseMarketSnapshotId: string | null;
  appliedAt: string | null;
  parameters: CaseScenarioParameter[];
}

export interface CaseMonteCarloConfiguration {
  enabled: boolean;
  paths: number | null;
  timeSteps: number | null;
  seed: number | null;
}

export interface CaseSolverConfiguration {
  model: ModelKey;
  contractId: string;
  scheme: string;
  gridKind: string;
  spaceSteps: number;
  varianceSteps: number | null;
  timeSteps: number;
  parameters: CaseParameterSet;
  monteCarlo: CaseMonteCarloConfiguration;
  validationIssues: string[];
}

export interface CaseConditionApproval {
  inputFingerprint: string;
  approvedAt: string;
}

export interface CaseInputFingerprint {
  definition: string;
  marketBase: string;
  economicScenario: string;
  solverConfiguration: string;
  combined: string;
}

export interface CaseRunSummary {
  primaryValue: number | null;
  benchmarkValue: number | null;
  accepted: boolean | null;
  warningCount: number;
  acceptanceIssues?: string[];
}

export interface CaseSolverRun {
  id: string;
  model: ModelKey;
  contractId: string;
  status: CaseRunStatus;
  inputFingerprint: CaseInputFingerprint;
  queuedAt: string;
  completedAt: string | null;
  execution: "fixture" | "worker" | "cache";
  origin: CaseRunOrigin;
  error: string | null;
  summary: CaseRunSummary | null;
}

export interface CaseInputs {
  definition: CaseDefinition;
  marketBase: CaseMarketBase;
  economicScenario: CaseEconomicScenario | null;
  solverConfiguration: CaseSolverConfiguration;
  conditionApproval?: CaseConditionApproval | null;
}

export interface CaseCore extends CaseInputs {
  latestRun: CaseSolverRun | null;
}

export interface CaseRevision {
  id: string;
  createdAt: string;
  reason: string;
  snapshot: CaseCore;
}

export interface Case {
  schemaVersion: typeof CASE_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  core: CaseCore;
  revisions: CaseRevision[];
}

export interface CaseReadiness {
  definition: CaseStageState;
  conditioning: CaseStageState;
  solve: CaseStageState;
  decide: CaseStageState;
  resultState: CaseResultState;
  isResultCurrent: boolean;
  blockingReasons: string[];
  staleReasons: string[];
  nextAction: "complete-definition" | "review-conditioning" | "fix-validation" | "run-case" | "wait-for-run" | "review-result";
  status: CaseStatusSystem;
}

export interface CaseStatusSystem {
  resultFreshness: CaseResultFreshness;
  workflowProgress: CaseWorkflowProgress;
  numericalAcceptance: CaseNumericalAcceptance;
  runActivity: CaseRunActivity;
  stages: Record<"define" | "condition" | "solve" | "decide", CaseStageState>;
  sampleResultLoaded: boolean;
  labels: {
    resultFreshness: "Current" | "Stale" | "No result";
    workflowProgress: "Not started" | "In progress" | "Complete";
    numericalAcceptance: "Passed" | "Review" | "Failed" | "Not evaluated";
    runActivity: "Idle" | "Running" | "Failed" | "Cancelled";
    solverState: "Ready to run" | "Current result available" | "Running" | "Blocked";
    headline: string;
  };
}

export interface CaseMutationMetadata {
  now?: string;
  revisionId?: string;
  reason: string;
}

export interface ModelSnapshotCompatibilityTarget {
  model: ModelKey;
  measure: Measure;
}

const clone = <T>(value: T): T => structuredClone(value);

function sortForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForFingerprint);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortForFingerprint(entry)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  const source = JSON.stringify(sortForFingerprint(value));
  let result = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    result ^= source.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function inputParts(core: CaseCore | CaseInputs): CaseInputs {
  return {
    definition: core.definition,
    marketBase: core.marketBase,
    economicScenario: core.economicScenario,
    solverConfiguration: core.solverConfiguration,
    conditionApproval: core.conditionApproval ?? null,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortForFingerprint(left)) === JSON.stringify(sortForFingerprint(right));
}

function uniqueRevisionId(caseState: Case, now: string, requested?: string): string {
  const base = requested ?? `revision-${now.replaceAll(":", "-")}`;
  if (!caseState.revisions.some((revision) => revision.id === base)) return base;
  let suffix = 2;
  while (caseState.revisions.some((revision) => revision.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function revisionOf(caseState: Case, metadata: CaseMutationMetadata): CaseRevision {
  const now = metadata.now ?? new Date().toISOString();
  return {
    id: uniqueRevisionId(caseState, now, metadata.revisionId),
    createdAt: now,
    reason: metadata.reason,
    snapshot: clone(caseState.core),
  };
}

export function createCaseInputFingerprint(core: CaseCore | CaseInputs): CaseInputFingerprint {
  const inputs = inputParts(core);
  const definition = hash(inputs.definition);
  const marketBase = hash(inputs.marketBase);
  const economicScenario = hash(inputs.economicScenario);
  const solverConfiguration = hash(inputs.solverConfiguration);
  return {
    definition,
    marketBase,
    economicScenario,
    solverConfiguration,
    combined: hash({ definition, marketBase, economicScenario, solverConfiguration }),
  };
}

export function createConditionInputFingerprint(core: CaseCore | CaseInputs): string {
  return hash({
    definition: {
      instrument: core.definition.instrument,
      valuationDate: core.definition.valuationDate,
      model: core.definition.model,
      contractId: core.definition.contractId,
      side: core.definition.side,
      measure: core.definition.measure,
    },
    marketBase: core.marketBase,
  });
}

export function isCaseConditioningApproved(core: CaseCore | CaseInputs): boolean {
  return Boolean(core.conditionApproval
    && core.conditionApproval.inputFingerprint === createConditionInputFingerprint(core));
}

export function checkModelSnapshotCompatibility(
  governing: ModelSnapshotCompatibilityTarget,
  snapshot: ModelSnapshotCompatibilityTarget | null,
): string[] {
  if (!snapshot) return [];
  const issues: string[] = [];
  const requiredMeasure = MODEL_SPECS[governing.model].measure;
  if (snapshot.model !== governing.model) {
    issues.push(`The ${snapshot.model} market snapshot is incompatible with the governing ${governing.model} model.`);
  }
  if (snapshot.measure !== requiredMeasure) {
    issues.push(`The ${snapshot.measure}-measure market snapshot is incompatible with the governing ${requiredMeasure}-measure ${governing.model} case.`);
  }
  return issues;
}

export function getCaseModelCompatibilityIssues(core: CaseCore | CaseInputs): string[] {
  const { definition, marketBase, economicScenario, solverConfiguration } = core;
  const issues = checkModelSnapshotCompatibility(definition, marketBase);
  const requiredMeasure = MODEL_SPECS[definition.model].measure;
  if (definition.measure !== requiredMeasure) {
    issues.push(`The ${definition.model} definition must use the ${requiredMeasure}-measure.`);
  }
  if (marketBase.source === "snapshot" && !marketBase.snapshotId) {
    issues.push("The applied market base is missing its snapshot ID.");
  }
  if (marketBase.source === "manual" && marketBase.snapshotId) {
    issues.push("A manual market base cannot inherit a market snapshot ID.");
  }
  if (economicScenario?.model !== undefined && economicScenario.model !== definition.model) {
    issues.push(`The ${economicScenario.model} economic scenario is incompatible with the governing ${definition.model} model.`);
  }
  if (economicScenario && economicScenario.baseMarketSnapshotId !== marketBase.snapshotId) {
    issues.push("The economic scenario was created from a different market base.");
  }
  if (solverConfiguration.model !== definition.model) {
    issues.push("The solver model does not match the case definition.");
  }
  if (solverConfiguration.contractId !== definition.contractId) {
    issues.push("The solver contract does not match the case definition.");
  }
  if ("latestRun" in core && core.latestRun) {
    if (core.latestRun.model !== definition.model) {
      issues.push(`The completed or queued ${core.latestRun.model} result is incompatible with the governing ${definition.model} model.`);
    }
  }
  return [...new Set(issues)];
}

export function findCompatibleModelDraft(caseState: Case, model: ModelKey): CaseCore | null {
  const candidates = [caseState.core, ...[...caseState.revisions].reverse().map((revision) => revision.snapshot)];
  const draft = candidates.find((candidate) => candidate.definition.model === model && getCaseModelCompatibilityIssues(candidate).length === 0);
  return draft ? clone(draft) : null;
}

export function switchCaseModelRevision(
  caseState: Case,
  nextModel: ModelKey,
  defaultInputs: CaseInputs,
  metadata: CaseMutationMetadata,
): Case {
  if (defaultInputs.definition.model !== nextModel || defaultInputs.marketBase.model !== nextModel || defaultInputs.solverConfiguration.model !== nextModel) {
    throw new Error(`The default case base is not compatible with ${nextModel}.`);
  }
  if (caseState.core.definition.model === nextModel) return caseState;
  const now = metadata.now ?? new Date().toISOString();
  const restoredDraft = findCompatibleModelDraft(caseState, nextModel);
  return {
    ...caseState,
    updatedAt: now,
    core: restoredDraft ?? { ...clone(defaultInputs), latestRun: null },
    revisions: [...caseState.revisions, revisionOf(caseState, { ...metadata, now })],
  };
}

export function createCase(inputs: CaseInputs, options: { id: string; now?: string; latestRun?: CaseSolverRun | null }): Case {
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: CASE_SCHEMA_VERSION,
    id: options.id,
    createdAt: now,
    updatedAt: now,
    core: { ...clone(inputs), latestRun: clone(options.latestRun ?? null) },
    revisions: [],
  };
}

export function reviseCase(caseState: Case, changes: Partial<CaseInputs>, metadata: CaseMutationMetadata): Case {
  const now = metadata.now ?? new Date().toISOString();
  const nextInputs = { ...inputParts(caseState.core), ...clone(changes) };
  if (sameValue(inputParts(caseState.core), nextInputs)) return caseState;
  return {
    ...caseState,
    updatedAt: now,
    core: { ...nextInputs, latestRun: clone(caseState.core.latestRun) },
    revisions: [...caseState.revisions, revisionOf(caseState, { ...metadata, now })],
  };
}

export function changeCaseContractRevision(
  caseState: Case,
  nextContractId: string,
  nextParameters: CaseParameterSet,
  metadata: CaseMutationMetadata,
): Case {
  const model = caseState.core.definition.model;
  const previousContract = MODEL_SPECS[model].contracts.find((contract) => contract.id === caseState.core.definition.contractId);
  const nextContract = MODEL_SPECS[model].contracts.find((contract) => contract.id === nextContractId);
  if (!nextContract) throw new Error(`${nextContractId} is not compatible with ${model}.`);
  if (nextContract.id === caseState.core.definition.contractId) return caseState;
  const previousSide = caseState.core.definition.side;
  const nextSide = nextContract.optionSides
    ? previousSide && nextContract.optionSides.includes(previousSide) ? previousSide : nextContract.optionSides[0]
    : null;
  const objective = previousContract && caseState.core.definition.objective === previousContract.summary
    ? nextContract.summary
    : caseState.core.definition.objective;
  return reviseCase(caseState, {
    definition: {
      ...caseState.core.definition,
      contractId: nextContract.id,
      contractLabel: nextContract.label,
      side: nextSide,
      objective,
      confirmedAt: null,
    },
    economicScenario: null,
    solverConfiguration: {
      ...caseState.core.solverConfiguration,
      contractId: nextContract.id,
      parameters: clone(nextParameters),
    },
  }, metadata);
}

export function branchCaseWithEconomicScenario(
  caseState: Case,
  scenario: CaseEconomicScenario,
  scenarioParameters: CaseParameterSet,
  metadata: CaseMutationMetadata,
): Case {
  if (scenario.model !== caseState.core.definition.model) {
    throw new Error("The economic scenario must belong to the governing model.");
  }
  if (scenario.baseMarketSnapshotId !== caseState.core.marketBase.snapshotId) {
    throw new Error("The economic scenario must branch from the current market base.");
  }
  return reviseCase(caseState, {
    economicScenario: { ...clone(scenario), appliedAt: metadata.now ?? new Date().toISOString() },
    solverConfiguration: {
      ...caseState.core.solverConfiguration,
      parameters: { ...caseState.core.solverConfiguration.parameters, ...clone(scenarioParameters) },
    },
  }, metadata);
}

export function branchCaseToMarketBase(caseState: Case, metadata: CaseMutationMetadata): Case {
  if (!caseState.core.economicScenario) return caseState;
  const restoredParameters = { ...caseState.core.solverConfiguration.parameters };
  caseState.core.economicScenario.parameters.forEach((parameter) => {
    restoredParameters[parameter.id] = caseState.core.marketBase.parameters[parameter.id] ?? parameter.baseValue;
  });
  return reviseCase(caseState, {
    economicScenario: null,
    solverConfiguration: {
      ...caseState.core.solverConfiguration,
      parameters: restoredParameters,
    },
  }, metadata);
}

export function approveCaseConditioning(caseState: Case, metadata: CaseMutationMetadata): Case {
  const definitionIssues = validateCaseDefinition(caseState.core.definition);
  const compatibilityIssues = getCaseModelCompatibilityIssues(caseState.core);
  const blockingIssues = [...definitionIssues, ...compatibilityIssues];
  if (Object.keys(caseState.core.marketBase.parameters).length === 0) {
    blockingIssues.push("Review the market or manual parameter base.");
  }
  if (blockingIssues.length > 0) {
    throw new Error(`Condition approval is blocked: ${[...new Set(blockingIssues)].join(" ")}`);
  }
  const now = metadata.now ?? new Date().toISOString();
  return reviseCase(caseState, {
    conditionApproval: {
      inputFingerprint: createConditionInputFingerprint(caseState.core),
      approvedAt: now,
    },
  }, { ...metadata, now });
}

export function synchroniseCaseInputs(caseState: Case, inputs: CaseInputs, metadata: CaseMutationMetadata): Case {
  return reviseCase(caseState, inputs, metadata);
}

export function restoreCaseRevision(caseState: Case, revisionId: string, metadata: CaseMutationMetadata): Case {
  const revision = caseState.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) throw new Error(`Case revision ${revisionId} does not exist.`);
  const now = metadata.now ?? new Date().toISOString();
  return {
    ...caseState,
    updatedAt: now,
    core: clone(revision.snapshot),
    revisions: [...caseState.revisions, revisionOf(caseState, { ...metadata, now })],
  };
}

export function queueCaseRun(caseState: Case, options: { id: string; now?: string; execution?: CaseSolverRun["execution"]; origin?: CaseRunOrigin }): Case {
  const compatibilityIssues = getCaseModelCompatibilityIssues(caseState.core);
  const definitionIssues = options.origin === "sample" ? [] : validateCaseDefinition(caseState.core.definition);
  const validationIssues = caseState.core.solverConfiguration.validationIssues;
  const approvalIssues = options.origin === "sample" || isCaseConditioningApproved(caseState.core)
    ? []
    : ["Approve the market base in Condition before running the solver."];
  const blockingIssues = [...definitionIssues, ...compatibilityIssues, ...validationIssues, ...approvalIssues];
  if (blockingIssues.length > 0) {
    throw new Error(`The solver run is blocked by invalid or incompatible case state: ${blockingIssues.join(" ")}`);
  }
  const now = options.now ?? new Date().toISOString();
  return {
    ...caseState,
    updatedAt: now,
    revisions: [...caseState.revisions, revisionOf(caseState, {
      reason: `Queue solver run ${options.id}`,
      revisionId: `before-run-${options.id}`,
      now,
    })],
    core: {
      ...caseState.core,
      latestRun: {
        id: options.id,
        model: caseState.core.definition.model,
        contractId: caseState.core.definition.contractId,
        status: "queued",
        inputFingerprint: createCaseInputFingerprint(caseState.core),
        queuedAt: now,
        completedAt: null,
        execution: options.execution ?? "worker",
        origin: options.origin ?? "user",
        error: null,
        summary: null,
      },
    },
  };
}

export function completeCaseRun(caseState: Case, runId: string, options: { now?: string; execution: CaseSolverRun["execution"]; summary: CaseRunSummary }): Case {
  if (caseState.core.latestRun?.id !== runId) return caseState;
  const now = options.now ?? new Date().toISOString();
  return {
    ...caseState,
    updatedAt: now,
    revisions: [...caseState.revisions, revisionOf(caseState, {
      reason: `Complete solver run ${runId}`,
      revisionId: `queued-run-${runId}`,
      now,
    })],
    core: {
      ...caseState.core,
      latestRun: {
        ...caseState.core.latestRun,
        status: "completed",
        completedAt: now,
        execution: options.execution,
        error: null,
        summary: clone(options.summary),
      },
    },
  };
}

export function finishCaseRun(caseState: Case, runId: string, status: "failed" | "cancelled", options: { now?: string; error?: string }): Case {
  if (caseState.core.latestRun?.id !== runId) return caseState;
  const now = options.now ?? new Date().toISOString();
  return {
    ...caseState,
    updatedAt: now,
    revisions: [...caseState.revisions, revisionOf(caseState, {
      reason: `${status === "failed" ? "Fail" : "Cancel"} solver run ${runId}`,
      revisionId: `queued-run-${runId}-${status}`,
      now,
    })],
    core: {
      ...caseState.core,
      latestRun: {
        ...caseState.core.latestRun,
        status,
        completedAt: now,
        error: options.error ?? null,
      },
    },
  };
}

export function deriveCaseReadiness(caseState: Case): CaseReadiness {
  const { definition, marketBase, solverConfiguration, latestRun } = caseState.core;
  const definitionIssues = validateCaseDefinition(definition);
  const definitionReady = definitionIssues.length === 0;

  const compatibilityIssues = getCaseModelCompatibilityIssues(caseState.core);
  const conditioningIssues: string[] = compatibilityIssues.filter((issue) => !issue.startsWith("The solver ") && !issue.startsWith("The completed or queued "));
  if (Object.keys(marketBase.parameters).length === 0) conditioningIssues.push("Review the market or manual parameter base.");
  const evidenceReady = definitionReady && conditioningIssues.length === 0;
  const conditioningApproved = isCaseConditioningApproved(caseState.core);
  if (evidenceReady && !conditioningApproved) conditioningIssues.push("Approve the market base before continuing.");
  const conditioningReady = evidenceReady && conditioningApproved;

  const solverIssues: string[] = [];
  solverIssues.push(...compatibilityIssues.filter((issue) => issue.startsWith("The solver ") || issue.startsWith("The completed or queued ")));
  solverIssues.push(...solverConfiguration.validationIssues);
  const blockingReasons = [...definitionIssues, ...conditioningIssues, ...solverIssues];
  const solveReady = definitionReady && conditioningReady && solverIssues.length === 0;

  const currentFingerprint = createCaseInputFingerprint(caseState.core);
  const staleReasons: string[] = [];
  if (latestRun?.status === "completed" && latestRun.inputFingerprint.definition !== currentFingerprint.definition) staleReasons.push("The problem definition changed after the run.");
  if (latestRun?.status === "completed" && latestRun.inputFingerprint.marketBase !== currentFingerprint.marketBase) staleReasons.push("The market base changed after the run.");
  if (latestRun?.status === "completed" && latestRun.inputFingerprint.economicScenario !== currentFingerprint.economicScenario) staleReasons.push("The economic scenario changed after the run.");
  if (latestRun?.status === "completed" && latestRun.inputFingerprint.solverConfiguration !== currentFingerprint.solverConfiguration) staleReasons.push("The solver configuration changed after the run.");

  const resultState: CaseResultState = !latestRun
    ? "missing"
    : latestRun.status === "queued"
      ? "queued"
      : latestRun.status === "failed"
        ? "failed"
        : latestRun.status === "cancelled"
          ? "cancelled"
          : staleReasons.length > 0
            ? "stale"
            : "current";

  const resultFreshness: CaseResultFreshness = resultState === "current"
    ? "current"
    : resultState === "stale"
      ? "stale"
      : "no-result";
  const runActivity: CaseRunActivity = resultState === "queued"
    ? "running"
    : resultState === "failed"
      ? "failed"
      : resultState === "cancelled"
        ? "cancelled"
        : "idle";
  const numericalAcceptance: CaseNumericalAcceptance = resultState === "failed"
    ? "failed"
    : latestRun?.status === "completed" && latestRun.summary?.accepted === true
      ? "passed"
      : latestRun?.status === "completed" && latestRun.summary?.accepted === false
        ? "review"
        : "not-evaluated";
  const sampleResultLoaded = latestRun?.origin === "sample" && latestRun.status === "completed";

  const definitionProgress: CaseStageState = definitionReady
    ? "complete"
    : definition.caseName.trim() || definition.instrument.trim() || definition.valuationDate.trim() || definition.contractId.trim() || definition.objective.trim()
      ? "in-progress"
      : "not-started";
  const conditioningProgress: CaseStageState = !definitionReady
    ? "not-started"
    : conditioningReady
      ? "complete"
      : "in-progress";
  const solveProgress: CaseStageState = !solveReady
    ? "not-started"
    : runActivity === "running" || runActivity === "failed" || runActivity === "cancelled" || resultFreshness === "stale"
      ? "in-progress"
      : resultFreshness === "current"
        ? "complete"
        : "not-started";
  const decideProgress: CaseStageState = resultFreshness === "current" && !sampleResultLoaded
    ? "complete"
    : "not-started";
  const workflowProgress: CaseWorkflowProgress = decideProgress === "complete"
    ? "complete"
    : definitionProgress === "not-started"
      ? "not-started"
      : "in-progress";

  const resultFreshnessLabel: CaseStatusSystem["labels"]["resultFreshness"] = resultFreshness === "current" ? "Current" : resultFreshness === "stale" ? "Stale" : "No result";
  const workflowProgressLabel: CaseStatusSystem["labels"]["workflowProgress"] = workflowProgress === "complete" ? "Complete" : workflowProgress === "in-progress" ? "In progress" : "Not started";
  const numericalAcceptanceLabel: CaseStatusSystem["labels"]["numericalAcceptance"] = numericalAcceptance === "passed" ? "Passed" : numericalAcceptance === "review" ? "Review" : numericalAcceptance === "failed" ? "Failed" : "Not evaluated";
  const runActivityLabel: CaseStatusSystem["labels"]["runActivity"] = runActivity === "running" ? "Running" : runActivity === "failed" ? "Failed" : runActivity === "cancelled" ? "Cancelled" : "Idle";
  const solverState: CaseStatusSystem["labels"]["solverState"] = runActivity === "running"
    ? "Running"
    : !solveReady
      ? "Blocked"
      : resultFreshness === "current"
        ? "Current result available"
        : "Ready to run";
  const headline = sampleResultLoaded
    ? "Sample result loaded"
    : runActivity === "running"
      ? "Run in progress"
      : runActivity === "failed"
        ? "Run failed"
        : runActivity === "cancelled"
          ? "Run cancelled"
          : `Workflow ${workflowProgressLabel.toLowerCase()}`;

  const status: CaseStatusSystem = {
    resultFreshness,
    workflowProgress,
    numericalAcceptance,
    runActivity,
    stages: {
      define: definitionProgress,
      condition: conditioningProgress,
      solve: solveProgress,
      decide: decideProgress,
    },
    sampleResultLoaded,
    labels: {
      resultFreshness: resultFreshnessLabel,
      workflowProgress: workflowProgressLabel,
      numericalAcceptance: numericalAcceptanceLabel,
      runActivity: runActivityLabel,
      solverState,
      headline,
    },
  };

  const nextAction: CaseReadiness["nextAction"] = !definitionReady
    ? "complete-definition"
    : !conditioningReady
      ? "review-conditioning"
      : !solveReady
        ? "fix-validation"
        : resultState === "queued"
          ? "wait-for-run"
          : resultState === "current"
            ? "review-result"
            : "run-case";

  return {
    definition: status.stages.define,
    conditioning: status.stages.condition,
    solve: status.stages.solve,
    decide: status.stages.decide,
    resultState,
    isResultCurrent: resultState === "current",
    blockingReasons,
    staleReasons,
    nextAction,
    status,
  };
}
