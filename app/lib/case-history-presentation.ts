import { createElement, Fragment } from "react";
import { createCaseInputFingerprint, type Case, type CaseCore, type CaseRevision } from "./case-state.ts";

export type TimelineEvent = "inputs-captured" | "queued" | "cancelled" | "failed" | "completed";

export interface TimelineCheckpoint {
  id: string;
  createdAt: string;
  title: string;
  reason: string;
  event: TimelineEvent;
  core: CaseCore;
  current: boolean;
  revision: CaseRevision | null;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function formatCheckpointTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp)) + " UTC";
}

function eventForCore(core: CaseCore): TimelineEvent {
  const status = core.latestRun?.status;
  return status === "queued" || status === "cancelled" || status === "failed" || status === "completed"
    ? status
    : "inputs-captured";
}

function marketIdentity(core: CaseCore): string {
  return core.marketBase.snapshotId ?? `manual-${core.marketBase.instrument || "market"}-${core.marketBase.asOfDate}`;
}

export function checkpointIdentity(core: CaseCore, createdAt: string, checkpointId = "checkpoint"): string {
  const scenarioIdentity = core.economicScenario?.scenarioId ?? "base";
  const runState = core.latestRun?.status ?? "not-run";
  return `${core.definition.model} · market ${marketIdentity(core)} · scenario ${scenarioIdentity} · ${runState} · ${formatCheckpointTime(createdAt)} · ${checkpointId}`;
}

export function buildCaseTimeline(caseState: Case): TimelineCheckpoint[] {
  const checkpoints = caseState.revisions.map((revision) => ({
    id: revision.id,
    createdAt: revision.createdAt,
    title: checkpointIdentity(revision.snapshot, revision.createdAt, `checkpoint ${revision.id}`),
    reason: revision.reason,
    event: eventForCore(revision.snapshot),
    core: revision.snapshot,
    current: false,
    revision,
  } satisfies TimelineCheckpoint));
  checkpoints.push({
    id: `current-${caseState.id}`,
    createdAt: caseState.updatedAt,
    title: checkpointIdentity(caseState.core, caseState.updatedAt, `live case ${caseState.id}`),
    reason: "Latest case state",
    event: eventForCore(caseState.core),
    core: caseState.core,
    current: true,
    revision: null,
  });
  return checkpoints.reverse();
}

type PreviewRow = { label: string; current: string; target: string; changed: boolean };

function describeDefinition(core: CaseCore): string {
  return `${core.definition.instrument} · ${core.definition.contractLabel} · ${core.definition.model} · ${core.definition.measure}`;
}

function describeMarket(core: CaseCore): string {
  return `${core.marketBase.snapshotId ?? "Manual base"} · ${core.marketBase.asOfDate}`;
}

function describeScenario(core: CaseCore): string {
  return core.economicScenario?.scenarioId ?? "Base only";
}

function describeSolver(core: CaseCore): string {
  const variance = core.solverConfiguration.varianceSteps == null ? "" : ` × ${core.solverConfiguration.varianceSteps}`;
  return `${core.solverConfiguration.scheme} · ${core.solverConfiguration.spaceSteps}${variance} × ${core.solverConfiguration.timeSteps}`;
}

function resultFreshness(core: CaseCore): "current" | "stale" | "no result" {
  if (core.latestRun?.status !== "completed") return "no result";
  return core.latestRun.inputFingerprint.combined === createCaseInputFingerprint(core).combined ? "current" : "stale";
}

function describeResult(core: CaseCore): string {
  const run = core.latestRun;
  if (!run) return "No result";
  return `${run.id} · ${run.status}${run.status === "completed" ? ` · ${resultFreshness(core)}` : ""}`;
}

export function getCaseChangePreview(current: CaseCore, target: CaseCore): { rows: PreviewRow[]; resultFreshness: "current" | "stale" | "no result" } {
  const values = [
    ["Definition", describeDefinition(current), describeDefinition(target), same(current.definition, target.definition)],
    ["Market base", describeMarket(current), describeMarket(target), same(current.marketBase, target.marketBase)],
    ["Scenario", describeScenario(current), describeScenario(target), same(current.economicScenario, target.economicScenario)],
    ["Solver settings", describeSolver(current), describeSolver(target), same(current.solverConfiguration, target.solverConfiguration)],
    ["Result", describeResult(current), describeResult(target), same(current.latestRun, target.latestRun)],
  ] as const;
  return {
    rows: values.map(([label, currentValue, targetValue, unchanged]) => ({ label, current: currentValue, target: targetValue, changed: !unchanged })),
    resultFreshness: resultFreshness(target),
  };
}

export function CaseChangePreview({ current, target }: { current: CaseCore; target: CaseCore }) {
  const preview = getCaseChangePreview(current, target);
  return createElement("section", { className: "timeline-change-preview", "aria-label": "Restore and branch change preview" },
    createElement("header", null,
      createElement("span", null, "BEFORE YOU RESTORE OR BRANCH"),
      createElement("h4", null, "Checkpoint change preview"),
      createElement("p", { className: `result-${preview.resultFreshness.replace(" ", "-")}` },
        preview.resultFreshness === "current" ? "The restored result will be current."
          : preview.resultFreshness === "stale" ? "The restored result will be stale and must be rerun."
            : "No completed result will be restored."),
    ),
    createElement("div", { className: "timeline-change-rows" }, ...preview.rows.map((row) => createElement("article", {
      key: row.label,
      className: row.changed ? "changed" : "unchanged",
    },
    createElement("span", null, row.label),
    createElement("small", null, row.current),
    createElement("i", { "aria-hidden": "true" }, "→"),
    createElement("b", null, row.target),
    createElement("em", null, row.changed ? "Will change" : "Unchanged")))),
  );
}

export const TIMELINE_EVENT_LABELS: Record<TimelineEvent, string> = {
  "inputs-captured": "INPUTS",
  queued: "QUEUED",
  cancelled: "CANCELLED",
  failed: "FAILED",
  completed: "COMPLETED",
};

export function TimelineCheckpointContent({ checkpoint }: { checkpoint: TimelineCheckpoint }) {
  return createElement(Fragment, null,
    createElement("span", null,
      createElement("b", null, checkpoint.title),
      createElement("small", null, formatCheckpointTime(checkpoint.createdAt)),
      createElement("em", null, checkpoint.reason),
    ),
    createElement("strong", null, checkpoint.current ? "LIVE" : TIMELINE_EVENT_LABELS[checkpoint.event]),
  );
}
