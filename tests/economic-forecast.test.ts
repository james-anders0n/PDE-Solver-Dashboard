import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ECONOMIC_FORECAST_FIXTURE } from "../app/lib/economic-forecast/fixtures.ts";
import { buildForecastDensityPoints, FORECAST_DENSITY_BOUNDS } from "../app/lib/economic-forecast/chart.ts";

test("the bundled economic forecast fallback is compact, calibrated, and locked", () => {
  const fixture = ECONOMIC_FORECAST_FIXTURE;
  const selectedModel = fixture.models.find((model) => model.id === fixture.selectedModelId);
  const histogramCount = fixture.distribution.histogram.reduce((sum, bin) => sum + bin.count, 0);

  assert.ok(selectedModel);
  assert.equal(fixture.status, "sample");
  assert.equal(fixture.freshness, "stale");
  assert.equal(fixture.distribution.status, "sample-not-validated");
  assert.equal(fixture.distribution.histogram.length, 40);
  assert.equal(histogramCount, fixture.distribution.drawCount);
  assert.equal(fixture.distribution.drawCount, 10_000);
  assert.deepEqual(fixture.distribution.coverage.map((item) => item.nominal), [0.5, 0.8, 0.9]);
  assert.ok(fixture.distribution.p10Pct < selectedModel.pointForecastPct);
  assert.ok(selectedModel.pointForecastPct < fixture.distribution.p90Pct);
  assert.ok(fixture.distribution.p10Pct <= fixture.distribution.p25Pct);
  assert.ok(fixture.distribution.p25Pct <= fixture.distribution.p50Pct);
  assert.ok(fixture.distribution.p50Pct <= fixture.distribution.p75Pct);
  assert.ok(fixture.distribution.p75Pct <= fixture.distribution.p90Pct);
  assert.ok(fixture.models.every((model) => Number.isFinite(model.pointForecastPct)));
  assert.ok(fixture.history.every((point) => [point.actualPct, point.predictionPct, point.naivePct].every(Number.isFinite)));
});

test("the retained Economic Forecast implementation is not exposed in the active Studio", async () => {
  const [page, workbench, workspace] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/case-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/economic-forecast-workspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workbench, /"define"[\s\S]*?"condition"[\s\S]*?"solve"[\s\S]*?"decide"/);
  assert.match(page, /<ConditionWorkbench/);
  assert.match(page, /marketEvidence=\{<MarketDataWorkspace/);
  assert.doesNotMatch(page, /forecastEvidence=\{<EconomicForecastWorkspace|onOpenForecastControls=|\["Overview"[^\n]+"Economic bridge"/);
  assert.doesNotMatch(page, /primary-workspace-nav/);
  assert.match(workspace, /Forecast/);
  assert.match(workspace, /Distribution/);
  assert.match(workspace, /Backtest/);
  assert.match(workspace, /Drivers/);
  assert.match(workspace, /Data & Provenance/);
  assert.match(workspace, /No price paths/i);
  assert.match(workspace, /Refresh forecast/);
  assert.match(workspace, /Empirical density/);
  assert.match(workspace, /Fold metrics/);
  assert.match(workspace, /last known good/i);
  assert.match(workspace, /Preview scenario mapping/);
  assert.match(workspace, /REVIEW REQUIRED/);
  assert.match(workspace, /Create reviewed scenario revision/);
  assert.match(workspace, /authenticated background refresh/i);
  assert.match(page, /mainTab === "Monte Carlo"/);
});

test("forecast density coordinates stay inside the chart plotting bounds", () => {
  const histogram = ECONOMIC_FORECAST_FIXTURE.distribution.histogram;
  const points = buildForecastDensityPoints(histogram, histogram[0].lowerPct, histogram.at(-1)!.upperPct);

  assert.equal(points.length, histogram.length);
  assert.ok(points.every((point) => point.x >= FORECAST_DENSITY_BOUNDS.left && point.x <= FORECAST_DENSITY_BOUNDS.right));
  assert.ok(points.every((point) => point.y >= FORECAST_DENSITY_BOUNDS.top && point.y <= FORECAST_DENSITY_BOUNDS.bottom));

  const adversarial = buildForecastDensityPoints([
    { lowerPct: -20, upperPct: -10, count: -100 },
    { lowerPct: 0, upperPct: 1, count: 100 },
    { lowerPct: 10, upperPct: 20, count: Number.POSITIVE_INFINITY },
  ], 0, 1);
  assert.ok(adversarial.every((point) => point.x >= FORECAST_DENSITY_BOUNDS.left && point.x <= FORECAST_DENSITY_BOUNDS.right));
  assert.ok(adversarial.every((point) => point.y >= FORECAST_DENSITY_BOUNDS.top && point.y <= FORECAST_DENSITY_BOUNDS.bottom));
});

test("forecast density rendering is plot-local and disabled for compact or unaccepted snapshots", async () => {
  const [workspace, css] = await Promise.all([
    readFile(new URL("../app/components/economic-forecast-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /const densityVisible = !compact && distribution\.densityEligible && distribution\.accepted/);
  assert.match(workspace, /className="forecast-histogram-plot"[\s\S]*?<svg className="forecast-density-overlay"[\s\S]*?<clipPath[\s\S]*?<polyline className="forecast-density-line"/);
  assert.doesNotMatch(workspace, /forecast-density-points/);
  assert.match(css, /\.forecast-histogram-plot \{[^}]*position: relative;[^}]*overflow: hidden;[^}]*isolation: isolate;/);
  assert.match(css, /\.forecast-density-overlay \{[^}]*position: absolute;[^}]*inset: 0 0 23px;[^}]*z-index: 3;[^}]*overflow: hidden;/);
  assert.match(css, /\.forecast-interval-band \{[^}]*z-index: 1;/);
  assert.match(css, /\.forecast-histogram-bars \{[^}]*z-index: 2;/);
  assert.match(css, /\.forecast-point-marker \{[^}]*z-index: 4;/);
  assert.match(css, /\.economic-forecast-tabs \{[^}]*position: sticky;[^}]*top: 119px;/);
});
