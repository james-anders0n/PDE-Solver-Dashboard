import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the case workbench exposes one ordered, keyboard-accessible four-stage workflow", async () => {
  const workbench = await readFile(new URL("../app/components/case-workbench.tsx", import.meta.url), "utf8");
  const define = workbench.indexOf('id: "define"');
  const condition = workbench.indexOf('id: "condition"');
  const solve = workbench.indexOf('id: "solve"');
  const decide = workbench.indexOf('id: "decide"');

  assert.ok(define >= 0 && define < condition && condition < solve && solve < decide);
  assert.match(workbench, /aria-label="Case workflow"/);
  assert.match(workbench, /aria-current=\{active \? "step"/);
  assert.match(workbench, /ArrowRight/);
  assert.match(workbench, /ArrowLeft/);
  assert.match(workbench, /Home/);
  assert.match(workbench, /End/);
  assert.match(workbench, /case-summary-strip/);
  assert.match(workbench, /CaseStatusSummary/);
  assert.match(workbench, /case-next-action/);
});

test("active specialist capabilities remain inside stages while history belongs to the case", async () => {
  const [page, market, solver, timeline] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/market-data-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/solver-studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/case-timeline-drawer.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /primary-workspace-nav/);
  assert.match(page, /<ConditionWorkbench/);
  assert.match(page, /activeStage === "define"/);
  assert.match(page, /marketEvidence=\{<MarketDataWorkspace/);
  assert.doesNotMatch(page, /forecastEvidence=\{<EconomicForecastWorkspace|onOpenForecastControls=|onApplyEconomicRegime=/);
  assert.match(page, /activeWorkspace === "solver-studio"/);
  assert.match(page, /<CaseTimelineDrawer/);
  assert.doesNotMatch(page, /activeWorkspace === "run-history"/);
  assert.doesNotMatch(market, /Open Solver Studio/);
  assert.doesNotMatch(solver, /Open Market Data|Open Results/);
  assert.match(timeline, /Restore revision/);
  assert.match(timeline, /Branch from here/);
});

test("Define owns the editable problem definition while Solve retains numerical controls", async () => {
  const [workbench, page, solver] = await Promise.all([
    readFile(new URL("../app/components/case-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/solver-studio-workspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workbench, /aria-label="Case name"/);
  assert.match(workbench, /aria-label="Case instrument"/);
  assert.match(workbench, /aria-label="Case valuation date"/);
  assert.match(workbench, /aria-label="Case governing model"/);
  assert.match(workbench, /aria-label="Case contract"/);
  assert.match(workbench, /Option side/);
  assert.match(workbench, /aria-label="Case objective"/);
  assert.match(workbench, /Required measure/);
  assert.match(workbench, /Save definition/);
  assert.doesNotMatch(page, /contract controls remain available in Solve during this migration/i);
  assert.match(solver, /Advanced execution settings/);
  assert.match(solver, /Scheme[\s\S]*Grid[\s\S]*Convergence verification[\s\S]*Monte Carlo/);
});
