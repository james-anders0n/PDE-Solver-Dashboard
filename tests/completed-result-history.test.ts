import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";

import { ConvergenceLevelLabel, convergenceLevelKey } from "../app/components/convergence-level.ts";
import { DownloadFeedbackNotice } from "../app/components/download-feedback.ts";
import { MissingBaseRunRecovery } from "../app/components/missing-base-run-recovery.ts";
import { buildCaseTimeline, CaseChangePreview, TimelineCheckpointContent } from "../app/lib/case-history-presentation.ts";
import {
  approveCaseConditioning,
  completeCaseRun,
  createCase,
  finishCaseRun,
  queueCaseRun,
  reviseCase,
  type CaseInputs,
} from "../app/lib/case-state.ts";

const inputs = (): CaseInputs => ({
  definition: {
    caseName: "AAPL call",
    instrument: "AAPL",
    valuationDate: "2026-08-24",
    model: "Black–Scholes",
    contractId: "european",
    contractLabel: "European option",
    side: "Call",
    measure: "Q",
    objective: "Value the option.",
    confirmedAt: "2026-08-24T00:00:00.000Z",
  },
  marketBase: {
    model: "Black–Scholes",
    source: "snapshot",
    snapshotId: "market-aapl-2026-08-24",
    applicationId: "application-aapl",
    instrument: "AAPL",
    currency: "USD",
    asOfDate: "2026-08-24",
    measure: "Q",
    appliedAt: "2026-08-24T00:00:00.000Z",
    parameters: { spot: "100", rate: "0.04", volatility: "0.2" },
  },
  economicScenario: null,
  solverConfiguration: {
    model: "Black–Scholes",
    contractId: "european",
    scheme: "rannacher-cn",
    gridKind: "nonuniform",
    spaceSteps: 100,
    varianceSteps: null,
    timeSteps: 100,
    parameters: { spot: "100", strike: "100", maturity: "1", rate: "0.04", dividend: "0", volatility: "0.2" },
    monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
    validationIssues: [],
  },
});

function approvedCase(id: string) {
  return approveCaseConditioning(createCase(inputs(), { id, now: "2026-08-24T00:00:00.000Z" }), {
    reason: "Approve market base",
    revisionId: `${id}-inputs-captured`,
    now: "2026-08-24T00:00:30.000Z",
  });
}

test("three convergence refinements render uniquely as Level 1, Level 2, and Level 3", () => {
  const levels = [
    { space: 50, time: 50 },
    { space: 100, time: 100 },
    { space: 200, time: 200 },
  ];
  const keys = levels.map((level, index) => convergenceLevelKey("Black–Scholes", index, level.space, null, level.time));
  assert.equal(new Set(keys).size, 3);
  const html = renderToStaticMarkup(createElement(Fragment, null, ...levels.map((level, index) => createElement(ConvergenceLevelLabel, {
    key: keys[index],
    index,
    grid: `${level.space} × ${level.time}`,
  }))));
  assert.match(html, /Level 1/);
  assert.match(html, /Level 2/);
  assert.match(html, /Level 3/);
  assert.equal((html.match(/Convergence Level/g) ?? []).length, 3);
});

test("Decide convergence evidence uses the same one-based level offset", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Math\.max\(0, convergence\.length - 4\) \+ index \+ 1/);
  assert.doesNotMatch(page, /Math\.max\(1, convergence\.length - 3 \+ index\)/);
});

test("download feedback renders success and failure with filename and file type", () => {
  const success = renderToStaticMarkup(createElement(DownloadFeedbackNotice, { feedback: {
    status: "success", filename: "pde-results-run-7.csv", fileType: "CSV",
  } }));
  const failure = renderToStaticMarkup(createElement(DownloadFeedbackNotice, { feedback: {
    status: "error", filename: "pde-run-manifest-run-7.json", fileType: "JSON", message: "Downloads are blocked.",
  } }));
  assert.match(success, /role="status"/);
  assert.match(success, /Download started/);
  assert.match(success, /pde-results-run-7\.csv · CSV/);
  assert.match(failure, /role="alert"/);
  assert.match(failure, /Download failed/);
  assert.match(failure, /pde-run-manifest-run-7\.json · JSON/);
  assert.match(failure, /Downloads are blocked/);
});

test("missing base comparison explains the mismatch and offers a matching-base action", () => {
  const html = renderToStaticMarkup(createElement(MissingBaseRunRecovery, { onRunMatchingBase() {} }));
  assert.match(html, /Base run required/);
  assert.match(html, /same definition, market snapshot, and solver settings/);
  assert.match(html, />Run matching base</);
  assert.doesNotMatch(html, /No matching run/);
});

test("timeline checkpoints have unique auditable identities and distinct run states", () => {
  const approved = approvedCase("history");
  const queued = queueCaseRun(approved, { id: "run-history", now: "2026-08-24T00:01:00.000Z" });
  const completed = completeCaseRun(queued, "run-history", {
    now: "2026-08-24T00:02:00.000Z",
    execution: "worker",
    summary: { primaryValue: 10, benchmarkValue: 10, accepted: true, warningCount: 0 },
  });
  const checkpoints = buildCaseTimeline(completed);
  assert.equal(new Set(checkpoints.map((checkpoint) => checkpoint.title)).size, checkpoints.length);
  assert.ok(checkpoints.every((checkpoint) => /Black–Scholes · market market-aapl-2026-08-24 · scenario base · (not-run|queued|completed) ·/.test(checkpoint.title)));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.event === "inputs-captured"));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.event === "queued"));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.event === "completed"));

  const cancelled = finishCaseRun(queueCaseRun(approvedCase("cancel"), { id: "run-cancel", now: "2026-08-24T00:03:00.000Z" }), "run-cancel", "cancelled", { now: "2026-08-24T00:04:00.000Z" });
  const failed = finishCaseRun(queueCaseRun(approvedCase("fail"), { id: "run-fail", now: "2026-08-24T00:05:00.000Z" }), "run-fail", "failed", { now: "2026-08-24T00:06:00.000Z", error: "Worker failed" });
  const rendered = renderToStaticMarkup(createElement(Fragment, null,
    createElement(TimelineCheckpointContent, { checkpoint: buildCaseTimeline(cancelled)[0] }),
    createElement(TimelineCheckpointContent, { checkpoint: buildCaseTimeline(failed)[0] }),
    createElement(TimelineCheckpointContent, { checkpoint: checkpoints[0] }),
  ));
  assert.match(rendered, /cancelled/);
  assert.match(rendered, /failed/);
  assert.match(rendered, /completed/);
});

test("restore and branch preview renders all change groups and stale-result consequence", () => {
  const approved = approvedCase("preview");
  const completed = completeCaseRun(queueCaseRun(approved, { id: "run-preview", now: "2026-08-24T00:01:00.000Z" }), "run-preview", {
    now: "2026-08-24T00:02:00.000Z",
    execution: "worker",
    summary: { primaryValue: 10, benchmarkValue: 10, accepted: true, warningCount: 0 },
  });
  const stale = reviseCase(completed, {
    solverConfiguration: { ...completed.core.solverConfiguration, spaceSteps: 200 },
  }, { reason: "Refine grid", revisionId: "before-refine", now: "2026-08-24T00:03:00.000Z" });
  const html = renderToStaticMarkup(createElement(CaseChangePreview, { current: completed.core, target: stale.core }));
  assert.match(html, /Checkpoint change preview/);
  for (const label of ["Definition", "Market base", "Scenario", "Solver settings", "Result"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /The restored result will be stale and must be rerun/);
  assert.match(html, /Will change/);
});
