import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EvidenceApplyStatus } from "../app/components/evidence-apply-status.ts";
import { OperationsUnavailable } from "../app/components/operations-unavailable.ts";
import { TechnicalTerminologyGuide } from "../app/components/technical-terminology-guide.ts";
import { decimalToPercent, decimalToPercentInput, formatEvidenceValue, formatUtcDateTime, percentInputToDecimal } from "../app/lib/presentation.ts";

test("mobile case chrome, ledger, sticky action, and equation use responsive disclosure patterns", async () => {
  const [page, chrome, condition, solver, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/case-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/condition-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/solver-studio-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(chrome, /case-summary-mobile/);
  assert.match(chrome, /View case details/);
  assert.match(chrome, /window\.scrollY > 180/);
  assert.match(chrome, /compact \? "scrolled"/);
  assert.match(condition, /data-label="Approved value"/);
  assert.match(condition, /data-label="Measure and classification"/);
  assert.match(condition, /condition-lineage-mobile/);
  assert.match(condition, /View lineage/);
  assert.match(solver, /equationSummary/);
  assert.match(solver, /Scrollable mathematical notation/);
  assert.match(css, /@media \(max-width: 580px\)/);
  assert.match(css, /\.condition-ledger-row \{ min-width: 0; display: grid/);
  assert.match(css, /scrollbar-color: var\(--teal\)/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.mapping-actions \.apply-market-button \{ display: block/);
  assert.match(page, /if \(!controlsOpen \|\| !window\.matchMedia\("\(max-width: 800px\)"\)\.matches\) return/);
  assert.match(page, /function openParameterControls\(\)[\s\S]*?setSidebarCollapsed\(false\)[\s\S]*?setControlsOpen\(true\)/);
  assert.match(css, /\.sidebar-scroll[\s\S]*?overscroll-behavior-y: contain[\s\S]*?touch-action: pan-y[\s\S]*?scrollbar-gutter: stable/);
});

test("evidence disclosures preserve diagnostics while keeping one market Apply action", async () => {
  const [market, forecast, condition] = await Promise.all([
    readFile(new URL("../app/components/market-data-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/economic-forecast-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/condition-workbench.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(market, /Changed parameters/);
  assert.match(market, /All mappings and detailed provenance/);
  assert.match(market, /Model diagnostics and residuals/);
  assert.match(market, /Raw observations and operational diagnostics/);
  assert.equal(market.match(/className="apply-market-button/g)?.length, 2, "mutually exclusive historical-scenario and base-apply branches are the only primary actions");
  assert.match(market, /requestedMeasureMode === "historical-p"[\s\S]*Save P historical scenario[\s\S]*Apply \{selectedIds\.size\} changes/);
  assert.doesNotMatch(market, /market-mobile-actions/);
  assert.match(forecast, /Residual observations and fold tables/);
  assert.match(forecast, /Detailed provenance and source files/);
  assert.match(forecast, /Operational monitors and policies/);
  assert.match(forecast, /Persistent run history and artifacts/);
  assert.match(condition, /aria-modal="true"/);
  assert.match(condition, /aria-describedby="condition-evidence-description"/);
  assert.match(condition, /returnFocusRef/);
  assert.match(condition, /event\.key === "Tab"/);
  assert.match(condition, /<EvidenceApplyStatus message=\{applyCompletion\}/);
});

test("terminology, Operations recovery, percent units, and UTC presentation are explicit", () => {
  const terminology = renderToStaticMarkup(createElement(TechnicalTerminologyGuide, {
    schemeOptions: [
      { id: "crank-nicolson", label: "Crank–Nicolson" },
      { id: "howard-implicit", label: "Howard implicit" },
    ],
  }));
  assert.match(terminology, /Q measure/);
  assert.match(terminology, /P measure/);
  assert.match(terminology, /Proxy \/ calibrated \/ derived/);
  assert.match(terminology, /OIS/);
  assert.match(terminology, /Feller condition/);
  assert.match(terminology, /ln\(K\/F\)/);
  assert.match(terminology, /Crank–Nicolson is second-order/);
  assert.match(terminology, /bounded HJB policy improvement/);

  const operations = renderToStaticMarkup(createElement(OperationsUnavailable, { message: "Endpoint unavailable.", onRetry() {} }));
  assert.match(operations, /Forecast Operations unavailable/);
  assert.match(operations, /Does not block Define, Condition, Solve/);
  assert.match(operations, /DB and FORECAST_ARTIFACTS/);
  assert.match(operations, /Retry Operations status/);

  const applied = renderToStaticMarkup(createElement(EvidenceApplyStatus, { message: "Snapshot fixture is active." }));
  assert.match(applied, /role="status"/);
  assert.match(applied, /Applied — returned to Condition/);

  assert.equal(decimalToPercent("0.041"), "4.1%");
  assert.equal(decimalToPercentInput("0.041"), "4.1");
  assert.equal(percentInputToDecimal("4.1"), "0.041");
  assert.equal(formatEvidenceValue("0.2", "dec"), "20%");
  assert.match(formatUtcDateTime("2026-08-24T01:02:00Z"), /UTC$/);
});
