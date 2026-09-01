import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Solve owns the real case controls and exposes one execution action", async () => {
  const [surface, page] = await Promise.all([
    readFile(new URL("../app/components/solver-studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(surface, /ESSENTIAL SETTINGS/);
  assert.match(surface, /Contract and model inputs/);
  assert.match(surface, /parameterSpecs\.map/);
  assert.match(surface, /Quoted market contract available/);
  assert.match(surface, /Use representative quoted contract/);
  assert.match(surface, /The case stays in Solve and the previous result becomes stale/);
  assert.match(surface, /Return to Condition to approve market base/);
  assert.match(surface, /onReturnToCondition/);
  assert.match(surface, /Advanced execution settings/);
  assert.match(surface, /Scheme[\s\S]*Grid[\s\S]*Convergence verification[\s\S]*Monte Carlo/);
  assert.match(surface, /EXECUTION READINESS/);
  assert.equal(surface.match(/Run case/g)?.length, 1);
  assert.doesNotMatch(surface, /solver-readiness-grid/);
  assert.match(page, /activeStage !== "solve" && activeStage !== "condition" && <CaseNextActionBar/);
  assert.match(page, /onRun=\{runSolver\}/);
  assert.match(page, /onCancel=\{cancelSolver\}/);
  assert.match(page, /onReturnToCondition=\{\(\) => selectCaseStage\("condition"\)\}/);
  assert.match(page, /quotedContract=\{solveQuotedContract\}/);
  assert.match(page, /onUseQuotedContract=\{\(\) => applyQuotedContract\(solveQuotedContract\)\}/);
});

test("Solve presents field-level validation and hides model-irrelevant controls", async () => {
  const surface = await readFile(new URL("../app/components/solver-studio-workspace.tsx", import.meta.url), "utf8");

  assert.match(surface, /aria-invalid=\{issues\.length > 0\}/);
  assert.match(surface, /solve-field-errors/);
  assert.match(surface, /Each issue is shown beside its affected input/);
  assert.match(surface, /contract === "barrier" &&/);
  assert.match(surface, /isHeston && <label/);
  assert.match(surface, /monteCarloEligible && <section/);
  assert.match(surface, /monteCarloEnabled && <div/);
});

test("numerical and provenance validation block invalid state before worker execution", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /minimumSpaceSteps/);
  assert.match(page, /Variance steps must be an integer of at least 4/);
  assert.match(page, /Time steps must be a positive integer/);
  assert.match(page, /getCaseModelCompatibilityIssues\(liveCaseRecord\.core\)/);
  assert.match(page, /Solver execution blocked/);
  assert.match(page, /if \(running \|\| validationIssues\.length > 0 \|\| !caseExecutionReady \|\| !solverAvailable\) return/);
  assert.match(page, /Queued in background worker/);
  assert.match(page, /message\.cacheHit \? "cache" : "worker"/);
});
