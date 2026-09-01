import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Decide leads with the answer, acceptance, comparison and reliability", async () => {
  const surface = await readFile(new URL("../app/components/decide-workspace.tsx", import.meta.url), "utf8");

  assert.match(surface, /Completed decision run/);
  assert.match(surface, /primaryLabel/);
  assert.match(surface, /decide-status-pills/);
  assert.match(surface, /Result freshness/);
  assert.match(surface, /Numerical acceptance/);
  assert.match(surface, /Base versus scenario comparison/);
  assert.match(surface, /Result reliability/);
  assert.match(surface, /Uncertainty/);
  assert.match(surface, /Sensitivities/);
  assert.match(surface, /Long-entry relative valuation/);
  assert.match(surface, /Executable ask/);
  assert.match(surface, /Required buffer/);
  assert.match(surface, /Relative valuation only—not a return forecast or trading recommendation/);
  assert.match(surface, /Why the assessment is unavailable/);
  assert.match(surface, /supportsListedOptionValuation\(definition\.model\)/);
  assert.match(surface, /Representative quoted contract available in Solve/);
  assert.match(surface, /Return to Solve to apply it/);
  assert.doesNotMatch(surface, /onUseSuggestedQuote/);
  assert.match(surface, /requires Condition approval and a new solver run/);
});

test("Decide retains stale output and keeps technical evidence expandable", async () => {
  const [surface, page] = await Promise.all([
    readFile(new URL("../app/components/decide-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(surface, /Previous result retained/);
  assert.match(surface, /staleReasons\.map/);
  assert.match(surface, /Technical evidence/);
  assert.match(surface, /<details key=\{section\.title\}>/);
  assert.match(surface, /Results CSV/);
  assert.match(surface, /Run manifest/);
  assert.match(page, /Inputs changed — previous result retained as stale/);
  const invalidationBlock = page.match(/const clearCalculatedResult = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.doesNotMatch(invalidationBlock, /setSolverResult\(null\)/);
  assert.match(page, /activeWorkspace === "results" \? <>[\s\S]*?<DecideWorkspace/);
});

test("Decide reconnects current model-matched visual diagnostics and withholds stale plots", async () => {
  const [page, decide, monteCarlo, shortRateMonteCarlo, mertonMonteCarlo] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/decide-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/monte-carlo-results.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/short-rate-monte-carlo-results.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/merton-policy-monte-carlo-results.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Visual diagnostics/);
  assert.match(page, /Every visible view below is generated from this current \{model\} run under the approved/);
  assert.match(page, /decideRun\?\.status === "completed" && caseReadiness\.status\.resultFreshness === "current"/);
  assert.match(page, /Visuals are withheld so a previous model, scenario, or parameter set cannot appear under the current definition/);
  assert.match(page, /Drag to orbit · Scroll to zoom · Right-drag to pan · Double-click to reset/);
  assert.match(page, /disabled=\{tab === "Monte Carlo" && !monteCarloTabAvailable\}/);
  assert.match(page, /window\.matchMedia\("\(max-width: 720px\)"\)[\s\S]*?setViewMode\("Heatmap"\)/);
  assert.match(monteCarlo, /Paths, sample mean and quantile bands/);
  assert.match(shortRateMonteCarlo, /short-rate paths/);
  assert.match(mertonMonteCarlo, /Controlled wealth trajectories/);
  assert.ok(decide.indexOf("{children}") < decide.indexOf("Technical evidence"));
});

test("HJB Decide uses native dollar policy units and a separately calculated wealth share", async () => {
  const [page, presentation] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/merton-policy-presentation.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /presentMertonPolicy\(decideMertonResult\)/);
  assert.match(page, /Optimal risky allocation/);
  assert.match(page, /Allocation \/ current wealth/);
  assert.match(page, /Control bounds/);
  assert.match(page, /Dollar risky-asset position/);
  assert.doesNotMatch(page, /formatPercent\(decideMertonResult\.policy\)/);
  assert.match(presentation, /allocation \/ wealth/);
});
