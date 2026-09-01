import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConditionBaseSummary } from "../app/components/condition-base-summary.ts";
import { checkModelSnapshotCompatibility, type CaseMarketBase } from "../app/lib/case-state.ts";
import { getConditionBasePresentation } from "../app/lib/condition-presentation.ts";
import { defaultMarketRequest, getMarketAdapter, type MarketSnapshot } from "../app/lib/market-data/index.ts";
import { MODEL_SPECS, defaultParameters, type ModelKey } from "../app/lib/pde-spec.ts";

async function snapshot(model: ModelKey, vasicekMode?: "historical-p" | "q-curve"): Promise<MarketSnapshot> {
  const request = {
    ...defaultMarketRequest(model),
    ...(vasicekMode ? { vasicekMeasureMode: vasicekMode } : {}),
  };
  return getMarketAdapter(model).preview(request, defaultParameters(model, MODEL_SPECS[model].contracts[0].id));
}

function renderBase(model: ModelKey, evidence: MarketSnapshot): string {
  const requiredMeasure = MODEL_SPECS[model].measure;
  const marketBase: CaseMarketBase = {
    model,
    source: "manual",
    snapshotId: null,
    applicationId: null,
    instrument: evidence.instrument,
    currency: evidence.currency,
    asOfDate: evidence.asOfDate,
    measure: requiredMeasure,
    appliedAt: null,
    parameters: defaultParameters(model, MODEL_SPECS[model].contracts[0].id),
  };
  return renderToStaticMarkup(createElement(ConditionBaseSummary, {
    presentation: getConditionBasePresentation(model, evidence.measure),
    marketBase,
    active: true,
  }));
}

test("Condition renders a Q-measure pricing base for Black–Scholes", async () => {
  const html = renderBase("Black–Scholes", await snapshot("Black–Scholes"));
  assert.match(html, /data-model="Black–Scholes"/);
  assert.match(html, /data-required-measure="Q"/);
  assert.match(html, />Q-measure pricing base</);
  assert.match(html, /Risk-neutral pricing inputs/);
});

test("Condition renders historical P evidence versus the Q Vasicek pricing base", async () => {
  const html = renderBase("Vasicek", await snapshot("Vasicek", "historical-p"));
  assert.match(html, /data-required-measure="Q"/);
  assert.match(html, />P historical scenario versus Q pricing base</);
  assert.match(html, /Historical P estimates may be saved as scenarios/);
  assert.match(html, /class="condition-measure-details"/);
  assert.match(html, /aria-label="Show explanation for P historical scenario versus Q pricing base"/);
  assert.match(html, />P \/ Q</);
});

test("Condition renders a Q-measure pricing base for Vasicek Q calibration", async () => {
  const html = renderBase("Vasicek", await snapshot("Vasicek", "q-curve"));
  assert.match(html, /data-required-measure="Q"/);
  assert.match(html, />Q-measure pricing base</);
  assert.doesNotMatch(html, /P historical scenario versus Q pricing base/);
});

test("Condition renders a P-measure opportunity set for HJB", async () => {
  const html = renderBase("HJB", await snapshot("HJB"));
  assert.match(html, /data-model="HJB"/);
  assert.match(html, /data-required-measure="P"/);
  assert.match(html, />P-measure opportunity set</);
  assert.match(html, /Real-world return, volatility and funding inputs/);
});

test("Condition compatibility follows the active model requirement, not a supplied presentation measure", () => {
  const issues = checkModelSnapshotCompatibility(
    { model: "HJB", measure: "Q" },
    { model: "HJB", measure: "Q" },
  );
  assert.ok(issues.some((issue) => issue.includes("governing P-measure HJB case")));
});
