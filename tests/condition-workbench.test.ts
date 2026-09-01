import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Condition presents one dependency flow and a complete input approval ledger", async () => {
  const [condition, flow, presentation, baseSummary] = await Promise.all([
    readFile(new URL("../app/components/condition-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/condition-flow.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/condition-presentation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/condition-base-summary.ts", import.meta.url), "utf8"),
  ]);

  assert.match(condition, /Choose source[\s\S]*Fetch or enter evidence[\s\S]*Review mappings[\s\S]*Apply market base[\s\S]*Approve market base/);
  assert.match(condition, /Market base and current solver values/);
  assert.match(condition, /<details className="condition-ledger">/);
  assert.doesNotMatch(condition, /<details className="condition-ledger" open/);
  assert.match(condition, /Open ledger/);
  assert.match(condition, /Close ledger/);
  assert.match(condition, /Classification & measure/);
  assert.match(condition, /Timestamp & mapping lineage/);
  assert.match(condition, /basePresentation\.storedBaseLabel/);
  assert.match(condition, /ConditionBaseSummary/);
  assert.match(presentation + baseSummary, /Q-measure pricing base/);
  assert.match(presentation + baseSummary, /P-measure opportunity set/);
  assert.match(presentation + baseSummary, /P historical scenario versus Q pricing base/);
  assert.match(condition, /Approve market base/);
  assert.match(flow, /Apply \$\{input\.selectedChangeCount\} changes to \$\{input\.requiredMeasure\} base/);
  assert.match(flow, /Open market-data controls/);
  assert.doesNotMatch(condition, /Approve inputs & continue/);
  assert.match(condition, /snapshotCompatibilityIssues\.length === 0/);
  assert.match(condition, /historicalVasicekEvidence/);
  assert.match(condition, /isPendingBaseApplication/);
  assert.match(condition, /compatibilityIssueCount: snapshotCompatibilityIssues\.length/);
  assert.match(baseSummary, /condition-measure-details/);
  assert.doesNotMatch(condition, /Economic scenario overlay|Macro overlay|Forecast diagnostics|Preview scenario mapping/);
});

test("Condition exposes only market evidence and keeps market-base approval separate from execution", async () => {
  const [condition, flow, page] = await Promise.all([
    readFile(new URL("../app/components/condition-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/condition-flow.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(flow, /scenario|forecast/i);
  assert.match(condition, /Solver execution has not started/);
  assert.match(condition, /Review market evidence and lineage/);
  assert.match(condition, /MARKET EVIDENCE & LINEAGE/);
  assert.doesNotMatch(condition, /forecast|macro overlay|economic scenario/i);
  assert.match(condition, /role="dialog"/);
  assert.match(condition, /Escape/);
  assert.match(page, /approveCaseConditioning/);
  const fetchBlock = page.match(/const fetchMarketData = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.match(fetchBlock, /alignParametersToOptionQuote/);
  assert.match(fetchBlock, /setParameters\(quoteAlignment\.parameters\)/);
  assert.match(fetchBlock, /selected automatically from fetched data/);
  assert.doesNotMatch(page, /forecastEvidence=|onOpenForecastControls=|onApplyEconomicRegime=/);
  assert.match(page, /activeStage !== "solve" && activeStage !== "condition" && <CaseNextActionBar/);
});
