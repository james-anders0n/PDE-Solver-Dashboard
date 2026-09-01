"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { OperationsUnavailable } from "@/app/components/operations-unavailable";
import { formatUtcDate, formatUtcDateTime } from "@/app/lib/presentation";
import type {
  CpiPdeScenarioHandoff,
  CpiScenarioQuantile,
  EconomicForecastRefreshJob,
  EconomicForecastOperationsResponse,
  EconomicForecastSnapshot,
  EconomicForecastSource,
} from "@/app/lib/economic-forecast";
import { buildForecastDensityPoints, FORECAST_DENSITY_BOUNDS } from "@/app/lib/economic-forecast/chart";

type ForecastTab = "forecast" | "distribution" | "backtest" | "drivers" | "provenance" | "operations";
const FORECAST_TABS: Array<{ id: ForecastTab; label: string }> = [
  { id: "forecast", label: "Forecast" },
  { id: "distribution", label: "Distribution" },
  { id: "backtest", label: "Backtest" },
  { id: "drivers", label: "Drivers" },
  { id: "provenance", label: "Data & Provenance" },
  { id: "operations", label: "Operations" },
];

const percent = (value: number | null, digits = 3) =>
  value === null ? "Unavailable" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const probability = (value: number | null) => value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
const shortDate = (value: string) => formatUtcDate(value);
const monthDate = (value: string) => new Date(value).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
const clamp = (value: number) => Math.max(0, Math.min(100, value));

function ForecastHistogram({ snapshot, thresholdPct, compact = false }: { snapshot: EconomicForecastSnapshot; thresholdPct: number; compact?: boolean }) {
  const distribution = snapshot.distribution;
  const model = snapshot.models.find((item) => item.id === snapshot.selectedModelId) ?? snapshot.models[0];
  const maxCount = Math.max(...distribution.histogram.map((bin) => bin.count), 1);
  const lower = distribution.histogram[0]?.lowerPct ?? -0.5;
  const upper = distribution.histogram.at(-1)?.upperPct ?? 1.5;
  const position = (value: number) => clamp((value - lower) / (upper - lower) * 100);
  const naive = snapshot.history.at(-1)?.naivePct;
  const densityClipId = `forecast-density-clip-${useId().replaceAll(":", "")}`;
  const densityPoints = buildForecastDensityPoints(distribution.histogram, lower, upper);
  const densityPolyline = densityPoints.map((point) => `${point.x},${point.y}`).join(" ");
  const densityVisible = !compact && distribution.densityEligible && distribution.accepted && densityPoints.length > 1;
  return (
    <div className={`forecast-histogram ${compact ? "compact" : ""}`}>
      <div className="forecast-histogram-plot" role="img" aria-label={`CPI forecast distribution with ${distribution.drawCount} draws. Point forecast ${percent(model.pointForecastPct)}. P10 ${percent(distribution.p10Pct)} and P90 ${percent(distribution.p90Pct)}.`}>
        <span className="forecast-interval-band" style={{ left: `${position(distribution.p10Pct)}%`, width: `${position(distribution.p90Pct) - position(distribution.p10Pct)}%` }} />
        <div className="forecast-histogram-bars">
          {distribution.histogram.map((bin) => <span key={`${bin.lowerPct}-${bin.upperPct}`} title={`${bin.lowerPct.toFixed(2)}% to ${bin.upperPct.toFixed(2)}%: ${bin.count} draws`}><i style={{ height: `${Math.max(2, bin.count / maxCount * 100)}%` }} /></span>)}
        </div>
        {densityVisible && <svg className="forecast-density-overlay" viewBox={`0 0 ${FORECAST_DENSITY_BOUNDS.width} ${FORECAST_DENSITY_BOUNDS.height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs><clipPath id={densityClipId}><rect x={FORECAST_DENSITY_BOUNDS.left} y={FORECAST_DENSITY_BOUNDS.top} width={FORECAST_DENSITY_BOUNDS.right - FORECAST_DENSITY_BOUNDS.left} height={FORECAST_DENSITY_BOUNDS.bottom - FORECAST_DENSITY_BOUNDS.top} /></clipPath></defs>
          <polyline className="forecast-density-line" points={densityPolyline} clipPath={`url(#${densityClipId})`} vectorEffect="non-scaling-stroke" />
        </svg>}
        <span className="forecast-point-marker" style={{ left: `${position(model.pointForecastPct)}%` }}><i /></span>
        {naive !== undefined && <span className="forecast-naive-marker" style={{ left: `${position(naive)}%` }} />}
        <span className="forecast-threshold-marker" style={{ left: `${position(thresholdPct)}%` }} />
        <div className="forecast-histogram-axis"><span>{lower.toFixed(1)}%</span><span>{((lower + upper) / 2).toFixed(1)}%</span><span>{upper.toFixed(1)}%</span></div>
      </div>
      <div className="forecast-distribution-legend">
        <span><i className="point" /> Point {percent(model.pointForecastPct)}</span>
        <span><i className="interval" /> P10–P90</span>
        {naive !== undefined && <span><i className="naive" /> Naive {percent(naive)}</span>}
        <span><i className="threshold" /> Threshold {percent(thresholdPct)}</span>
        {densityVisible && <span><i className="density" /> Empirical density</span>}
      </div>
    </div>
  );
}

function ForecastSummary({ snapshot, thresholdPct }: { snapshot: EconomicForecastSnapshot; thresholdPct: number }) {
  const model = snapshot.models.find((item) => item.id === snapshot.selectedModelId) ?? snapshot.models[0];
  const distribution = snapshot.distribution;
  const thresholdProbability = useMemo(() => {
    const above = distribution.histogram.filter((bin) => (bin.lowerPct + bin.upperPct) / 2 > thresholdPct).reduce((sum, bin) => sum + bin.count, 0);
    return above / distribution.drawCount;
  }, [distribution, thresholdPct]);
  return (
    <div className="economic-forecast-summary">
      <section className="forecast-hero-card">
        <div><span className="workspace-kicker">NEXT RELEASE · {snapshot.target.seriesId}</span><h3>{snapshot.target.label}</h3><p>Target month {monthDate(snapshot.target.referenceDate)} · one-month horizon</p></div>
        <div className="forecast-point-value"><strong>{percent(model.pointForecastPct)}</strong><span>{model.label} · {snapshot.status} snapshot</span></div>
        <div className="forecast-interval-strip">
          <span><b>P10</b>{percent(distribution.p10Pct)}</span><span><b>MEDIAN</b>{percent(distribution.p50Pct)}</span><span><b>P90</b>{percent(distribution.p90Pct)}</span>
          <small>{distribution.accepted ? "Accepted residual-bootstrap interval" : "Fallback interval · not accepted for scenario use"}</small>
        </div>
      </section>
      <section className="forecast-fact-grid" aria-label="Economic forecast summary">
        <article><span>Latest observation</span><strong>{percent(snapshot.latestObservation.momPct)}</strong><small>{monthDate(snapshot.latestObservation.referenceDate)}{snapshot.latestObservation.indexValue === null ? "" : ` · index ${snapshot.latestObservation.indexValue.toFixed(3)}`}</small></article>
        <article><span>Target release</span><strong>{shortDate(snapshot.target.releaseTimestamp)}</strong><small>Availability and target dates remain distinct</small></article>
        <article><span>Model status</span><strong>{snapshot.status === "accepted" ? "Accepted" : "Research fallback"}</strong><small>{model.metrics.beatsNaiveRmse ? "Beat naive aggregate RMSE" : "Did not beat naive RMSE"}</small></article>
        <article><span>Snapshot generated</span><strong>{shortDate(snapshot.generatedAt)}</strong><small>{snapshot.provenance.modelVersion}</small></article>
      </section>
      <div className="forecast-overview-grid">
        <section className="economic-panel distribution-preview"><header><div><span className="workspace-kicker">FORECAST UNCERTAINTY</span><h3>Next CPI outcome distribution</h3></div><b>{distribution.accepted ? "CALIBRATED" : "FALLBACK"}</b></header><ForecastHistogram snapshot={snapshot} thresholdPct={thresholdPct} compact /><footer><span>{distribution.residualObservationCount} OOS errors</span><span>σ {distribution.standardDeviationPct.toFixed(3)} pp</span><span>P(CPI &gt; {thresholdPct.toFixed(2)}%) {probability(thresholdProbability)}</span></footer></section>
        <section className="economic-panel forecast-quality-panel"><header><div><span className="workspace-kicker">WALK-FORWARD QUALITY</span><h3>{model.label} evidence</h3></div><b>{model.metrics.beatsNaiveRmse ? "BEATS NAIVE" : "REVIEW"}</b></header><div className="forecast-quality-grid"><span><b>{model.metrics.rmsePct.toFixed(3)} pp</b>RMSE</span><span><b>{model.metrics.maePct.toFixed(3)} pp</b>MAE</span><span><b>{probability(model.metrics.directionalAccuracy)}</b>Directional</span><span><b>{probability(model.metrics.hitRateVsNaive)}</b>Hit rate</span></div><p>{snapshot.naiveComparison}</p></section>
      </div>
    </div>
  );
}

function DistributionView({ snapshot, thresholdPct, onThresholdChange }: { snapshot: EconomicForecastSnapshot; thresholdPct: number; onThresholdChange(value: number): void }) {
  const distribution = snapshot.distribution;
  const above = distribution.histogram.filter((bin) => (bin.lowerPct + bin.upperPct) / 2 > thresholdPct).reduce((sum, bin) => sum + bin.count, 0) / distribution.drawCount;
  return (
    <section className="economic-panel forecast-distribution-panel">
      <header><div><span className="workspace-kicker">NO PRICE PATHS</span><h3>Forecast-error distribution</h3><p>10,000 Python draws summarized into {distribution.histogram.length} bins; raw draws never enter the browser.</p></div><b>{distribution.accepted ? "ACCEPTED" : "LAST KNOWN GOOD"}</b></header>
      {!distribution.accepted && <div className="forecast-sample-warning"><b>Scenario use locked</b><span>{distribution.warnings[0]}</span></div>}
      <div className="forecast-threshold-control"><label htmlFor="forecast-threshold">Probability threshold</label><input id="forecast-threshold" type="range" min="-0.5" max="1.5" step="0.05" value={thresholdPct} onChange={(event) => onThresholdChange(Number(event.target.value))} /><output>{thresholdPct.toFixed(2)}% · P(above) {probability(above)}</output></div>
      <ForecastHistogram snapshot={snapshot} thresholdPct={thresholdPct} />
      <div className="distribution-stat-grid"><span><b>{percent(distribution.meanPct)}</b>Mean</span><span><b>{percent(distribution.p50Pct)}</b>Median</span><span><b>{distribution.standardDeviationPct.toFixed(3)} pp</b>Standard deviation</span><span><b>{distribution.drawCount.toLocaleString()}</b>Python draws</span></div>
      <div className="forecast-coverage-grid">{distribution.coverage.map((item) => <article key={item.nominal} className={item.accepted ? "accepted" : "failed"}><span>{Math.round(item.nominal * 100)}% interval</span><strong>{probability(item.observed)}</strong><small>Average width {item.averageIntervalWidthPct === null ? "unavailable" : `${item.averageIntervalWidthPct.toFixed(3)} pp`} · n={item.sampleSize}</small><b>{item.accepted ? "PASS" : "REVIEW"}</b></article>)}</div>
      <details className="forecast-method-note"><summary>Method and reproducibility</summary><p>{distribution.method} · version {distribution.methodVersion} · seed {distribution.seed} · {distribution.residualWindowLabel}. Coverage is evaluated sequentially using only earlier OOS residuals.</p></details>
    </section>
  );
}

function BacktestView({ snapshot }: { snapshot: EconomicForecastSnapshot }) {
  const recent = snapshot.history.slice(-24);
  const values = recent.flatMap((point) => [point.actualPct, point.predictionPct, point.naivePct]);
  const lower = Math.min(...values, 0);
  const upper = Math.max(...values, 1);
  const y = (value: number) => clamp((value - lower) / Math.max(upper - lower, 0.001) * 100);
  return (
    <section className="economic-panel forecast-backtest-panel">
      <header><div><span className="workspace-kicker">EXPANDING-WINDOW OOS</span><h3>Actual versus predicted CPI</h3><p>Every displayed prediction is generated outside its training window.</p></div><b>{snapshot.history.length} OOS ROWS</b></header>
      <div className="backtest-mini-chart" role="img" aria-label="Recent actual, predicted, and naive CPI observations">{recent.map((point) => <span key={point.date} title={`${monthDate(point.date)} actual ${point.actualPct.toFixed(3)}%, predicted ${point.predictionPct.toFixed(3)}%`}><i className="actual" style={{ bottom: `${y(point.actualPct)}%` }} /><i className="predicted" style={{ bottom: `${y(point.predictionPct)}%` }} /><i className="naive" style={{ bottom: `${y(point.naivePct)}%` }} /></span>)}</div>
      <div className="backtest-chart-legend"><span><i className="actual" /> Actual</span><span><i className="predicted" /> Model</span><span><i className="naive" /> Naive</span></div>
      <p className="forecast-naive-statement">{snapshot.naiveComparison}</p>
      <details className="forecast-detail-disclosure"><summary><span><b>Residual observations and fold tables</b><small>Recent out-of-sample errors, availability dates, and fold metrics</small></span><i aria-hidden="true">+</i></summary>
        <div className="forecast-table-wrap"><table><thead><tr><th>Target month</th><th>Available</th><th>Actual</th><th>Prediction</th><th>Naive</th><th>Error</th></tr></thead><tbody>{recent.slice(-12).reverse().map((point) => <tr key={point.date}><td>{monthDate(point.date)}</td><td>{point.availabilityDate ? shortDate(point.availabilityDate) : "Legacy unavailable"}</td><td>{percent(point.actualPct)}</td><td>{percent(point.predictionPct)}</td><td>{percent(point.naivePct)}</td><td className={Math.abs(point.actualPct - point.predictionPct) <= Math.abs(point.actualPct - point.naivePct) ? "better" : "worse"}>{(point.actualPct - point.predictionPct).toFixed(3)} pp</td></tr>)}</tbody></table></div>
        <h4 className="forecast-subheading">Fold metrics</h4>
        {snapshot.folds.length ? <div className="forecast-table-wrap"><table><thead><tr><th>Fold</th><th>Train end</th><th>Test window</th><th>n</th><th>RMSE</th><th>MAE</th></tr></thead><tbody>{snapshot.folds.slice(-8).reverse().map((fold) => <tr key={fold.foldId}><td>{fold.foldId}</td><td>{shortDate(fold.trainEnd)}</td><td>{shortDate(fold.testStart)}–{shortDate(fold.testEnd)}</td><td>{fold.observations}</td><td>{fold.rmsePct.toFixed(3)} pp</td><td>{fold.maePct.toFixed(3)} pp</td></tr>)}</tbody></table></div> : <div className="forecast-empty-inline">Fold-level rows are unavailable in the bundled fallback. Aggregate OOS metrics and coverage remain visible.</div>}
      </details>
    </section>
  );
}

function DriversView({ snapshot }: { snapshot: EconomicForecastSnapshot }) {
  return <section className="economic-panel forecast-drivers-panel"><header><div><span className="workspace-kicker">MODEL INPUTS</span><h3>Point-in-time feature set</h3><p>Descriptions only; contribution scores are never invented.</p></div><b>RESEARCH</b></header><div className="forecast-driver-list">{snapshot.drivers.map((driver) => <article key={driver.label}><span>{driver.classification}</span><div><b>{driver.label}</b><p>{driver.detail}</p></div></article>)}</div>{!snapshot.drivers.length && <div className="forecast-empty-inline">Feature descriptions will appear when supplied by the accepted snapshot exporter.</div>}</section>;
}

function ProvenanceView({ snapshot, source }: { snapshot: EconomicForecastSnapshot; source: EconomicForecastSource }) {
  return <section className="economic-panel forecast-provenance-panel"><header><div><span className="workspace-kicker">DATA & PROVENANCE</span><h3>Snapshot lineage</h3><p>Source credentials and provider keys remain server-side.</p></div><b>{snapshot.schemaVersion}</b></header><div className="forecast-provenance-summary"><span><b>Run ID</b>{snapshot.runId}</span><span><b>Generated</b>{formatUtcDateTime(snapshot.generatedAt)}</span><span><b>Validation</b>{snapshot.provenance.validation}</span></div>{snapshot.provenance.limitation && <div className="forecast-sample-warning"><b>Known limitation</b><span>{snapshot.provenance.limitation}</span></div>}<details className="forecast-detail-disclosure"><summary><span><b>Detailed provenance and source files</b><small>API source, source series, distribution seed, and exact input paths</small></span><i aria-hidden="true">+</i></summary><div className="forecast-provenance-grid"><span><b>API source</b>{source}</span><span><b>Source series</b>{snapshot.provenance.sourceSeries.join(" · ")}</span><span><b>Distribution seed</b>{snapshot.distribution.seed}</span></div><div className="forecast-source-files"><b>Snapshot inputs</b>{snapshot.provenance.sourceFiles.map((file) => <code key={file}>{file}</code>)}</div></details></section>;
}

function OperationsView({ payload, loading, error, onRetry }: { payload: EconomicForecastOperationsResponse | null; loading: boolean; error: string | null; onRetry(): void }) {
  if (loading && !payload) return <section className="economic-panel forecast-operations-panel"><div className="forecast-empty-inline">Loading persistent run state, monitors, schedule and retention policy…</div></section>;
  if (!payload) return <section className="economic-panel forecast-operations-panel"><OperationsUnavailable message={error ?? "The persistent Operations API could not be read. Forecast serving remains isolated."} onRetry={onRetry} /></section>;
  return <section className="economic-panel forecast-operations-panel">
    <header><div><span className="workspace-kicker">PERSISTENCE & SCHEDULING</span><h3>Forecast operations</h3><p>Immutable runs · guarded latest pointer · official-release trigger</p></div><b className={`operations-health ${payload.health}`}>{payload.health.toUpperCase()}</b></header>
    {payload.warning && <div className="forecast-sample-warning"><b>INITIALISING</b><span>{payload.warning}</span></div>}
    <div className="operations-status-grid">
      <article><span>Latest accepted pointer</span><strong>{payload.latestAcceptedRunId ?? "Not populated"}</strong><small>{payload.lastAcceptedAt ? `Advanced ${shortDate(payload.lastAcceptedAt)}` : "Fallback remains served until first accepted ingestion"}</small></article>
      <article><span>Persistence</span><strong>{payload.storage.available ? "D1 + R2 ready" : "Bindings unavailable"}</strong><small>{payload.storage.d1} · {payload.storage.r2}</small></article>
      <article><span>Refresh schedule</span><strong>{payload.schedule.nextReleaseTimestamp ? shortDate(payload.schedule.nextReleaseTimestamp) : "Paused"}</strong><small>{payload.schedule.message}</small></article>
      <article><span>Acceptance failures</span><strong>{payload.consecutiveAcceptanceFailures}</strong><small>A failed refresh never replaces latest accepted</small></article>
    </div>
    <details className="forecast-detail-disclosure"><summary><span><b>Operational monitors and policies</b><small>Health signals, retention, and calendar provenance</small></span><i aria-hidden="true">+</i></summary><div className="operations-monitor-grid">{payload.monitors.map((monitor) => <article key={monitor.id} className={monitor.status}><i /><div><b>{monitor.label}</b><p>{monitor.detail}</p></div><span>{monitor.status}</span></article>)}</div>
    <div className="operations-policy-grid">
      <article><span>RETENTION</span><b>Accepted {payload.retention.acceptedDays}d · failed {payload.retention.failedDays}d · events {payload.retention.eventDays}d · draws {payload.retention.fullDrawDays}d</b><small>Latest accepted is permanently protected from automated cleanup.</small></article>
      <article><span>CALENDAR PROVENANCE</span><b>{payload.schedule.sourceName ?? "Awaiting verified calendar"}</b><small>{payload.schedule.sourceUrl ?? "The scheduler will not run from an unverified or stale calendar."}</small></article>
    </div></details>
    <details className="forecast-detail-disclosure"><summary><span><b>Persistent run history and artifacts</b><small>Immutable acceptance history and downloadable outputs</small></span><i aria-hidden="true">+</i></summary>
    {payload.runs.length ? <div className="forecast-table-wrap"><table><thead><tr><th>Run</th><th>Generated</th><th>Status</th><th>Method</th><th>Residuals</th><th>Coverage 50/80/90</th><th>Artifacts</th></tr></thead><tbody>{payload.runs.map((run) => <tr key={run.runId}><td><code>{run.runId}</code></td><td>{shortDate(run.generatedAt)}</td><td className={run.accepted ? "better" : "worse"}>{run.status.toUpperCase()}</td><td>{run.distributionMethod} v{run.distributionMethodVersion}</td><td>{run.residualCount}</td><td>{[run.coverage50, run.coverage80, run.coverage90].map((value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`).join(" · ")}</td><td className="operations-artifacts"><a href={`/api/economic-forecast/runs/${encodeURIComponent(run.runId)}/artifacts/snapshot`}>JSON</a>{run.artifacts.csv && <a href={`/api/economic-forecast/runs/${encodeURIComponent(run.runId)}/artifacts/csv`}>CSV</a>}{run.artifacts.report && <a href={`/api/economic-forecast/runs/${encodeURIComponent(run.runId)}/artifacts/report`}>Report</a>}{run.artifacts.fullDraws && <a href={`/api/economic-forecast/runs/${encodeURIComponent(run.runId)}/artifacts/draws`}>Draws</a>}</td></tr>)}</tbody></table></div> : <div className="forecast-empty-inline">No D1 run rows yet. The bundled last-known-good snapshot remains available while the first scheduled accepted run is ingested.</div>}
    </details>
    <details className="forecast-detail-disclosure"><summary><span><b>Versioned distribution methods</b><small>Active and comparison-only methods</small></span><i aria-hidden="true">+</i></summary><div className="operations-method-list">{payload.methods.map((method) => <article key={method.id}><span>{method.status}</span><div><b>{method.id} <code>v{method.version}</code></b><p>{method.description}</p></div><strong>{method.enabled ? "ACTIVE" : "COMPARISON REQUIRED"}</strong></article>)}</div></details>
  </section>;
}

function ScenarioReviewDrawer({ review, onChangeQuantile, onClose, onApply }: {
  review: CpiPdeScenarioHandoff;
  onChangeQuantile(quantile: CpiScenarioQuantile): void;
  onClose(): void;
  onApply(): void;
}) {
  const rate = (value: string | number) => `${(Number(value) * 100).toFixed(3)}%`;
  return <div className="forecast-scenario-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="forecast-scenario-drawer" role="dialog" aria-modal="true" aria-labelledby="forecast-scenario-title">
      <header><div><span className="workspace-kicker">REVIEW REQUIRED</span><h2 id="forecast-scenario-title">CPI-to-PDE scenario handoff</h2><p>{review.model} · calibrated base remains preserved</p></div><button aria-label="Close scenario review" onClick={onClose}>×</button></header>
      {!review.eligible && <div className="forecast-scenario-blocked" role="alert"><b>APPLICATION LOCKED</b>{review.blockingIssues.map((issue) => <span key={issue}>{issue}</span>)}</div>}
      <section className="forecast-scenario-source"><span><b>Forecast run</b>{review.forecastRunId}</span><span><b>Distribution</b>{review.distributionMethod} v{review.distributionMethodVersion}</span><span><b>Seed</b>{review.distributionSeed}</span><span><b>Mapping</b>{review.mappingVersion}</span></section>
      <label className="forecast-scenario-quantile"><span><b>CPI input</b><small>Select the reviewed point from the exported Python distribution.</small></span><select aria-label="CPI scenario quantile" value={review.scenarioInputs.quantile} onChange={(event) => onChangeQuantile(event.target.value as CpiScenarioQuantile)}><option value="point">Point forecast</option><option value="p10">P10 downside</option><option value="p50">P50 median</option><option value="p90">P90 upside</option></select></label>
      <section className="forecast-scenario-flow" aria-label="CPI scenario transformation">
        <article><span>1 · P-MEASURE INPUT</span><b>CPI {review.scenarioInputs.quantile.toUpperCase()}</b><strong>{percent(review.scenarioInputs.cpiMomPct)}</strong><small>P10–P90 {percent(review.scenarioInputs.cpiIntervalPct[0])} to {percent(review.scenarioInputs.cpiIntervalPct[1])}</small></article>
        <i aria-hidden="true">→</i>
        <article><span>2 · POLICY ADAPTER</span><b>Policy-rate scenario</b><strong>{rate(review.scenarioInputs.policyRateForecast)}</strong><small>{rate(review.scenarioInputs.policyRateInterval[0])} to {rate(review.scenarioInputs.policyRateInterval[1])}</small></article>
        <i aria-hidden="true">→</i>
        <article><span>3 · PDE SCENARIO SET</span><b>{review.affectedParameters.map((item) => item.id).join(", ") || "No mapping"}</b><strong>{review.affectedParameters.map((item) => rate(item.scenarioValue)).join(" · ") || "Excluded"}</strong><small>Base inputs are not overwritten until reviewed application.</small></article>
      </section>
      <section className="forecast-scenario-method"><div><b>Transformation formula</b><code>{review.adapterFormula}</code></div><div><b>Uncertainty treatment</b><p>{review.uncertaintyTreatment}</p></div><div><b>Bounds and clamping</b><p>Policy adapter {rate(review.policyRateBounds[0])} to {rate(review.policyRateBounds[1])}; raw {rate(review.rawPolicyRateForecast)}. {review.policyRateClamped ? "Policy bound applied." : "No policy bound applied."}</p></div></section>
      <section className="forecast-scenario-comparison"><header><span>Parameter</span><span>Market-calibrated base</span><span>Macro-conditioned scenario</span><span>Guard</span></header>{review.affectedParameters.map((item) => <div key={item.id}><span><b>{item.id}</b><small>{item.formula}</small></span><span>{rate(item.baseValue)}</span><span>{rate(item.scenarioValue)}</span><span>{item.measure}-measure scenario only{item.clamped ? " · clamped" : ""}</span></div>)}</section>
      <footer><button onClick={onClose}>{review.eligible ? "Cancel" : "Return to forecast controls"}</button>{review.eligible && <button className="scenario-button" onClick={onApply}>Create reviewed scenario revision</button>}</footer>
    </aside>
  </div>;
}

export interface EconomicForecastWorkspaceProps {
  snapshot: EconomicForecastSnapshot | null;
  loading: boolean;
  error: string | null;
  warning: string | null;
  source: EconomicForecastSource;
  refreshEnabled: boolean;
  refreshJob: EconomicForecastRefreshJob | null;
  scenarioReview: CpiPdeScenarioHandoff | null;
  onRefresh(): void;
  onCreateScenario(quantile: CpiScenarioQuantile): void;
  onCloseScenarioReview(): void;
  onApplyScenario(): void;
}

export function EconomicForecastWorkspace({ snapshot, loading, error, warning, source, refreshEnabled, refreshJob, scenarioReview, onRefresh, onCreateScenario, onCloseScenarioReview, onApplyScenario }: EconomicForecastWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<ForecastTab>("forecast");
  const [thresholdPct, setThresholdPct] = useState(0.3);
  const [operations, setOperations] = useState<EconomicForecastOperationsResponse | null>(null);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const loadOperations = useCallback(() => {
    if (operationsLoading) return;
    setOperationsLoading(true);
    setOperationsError(null);
    fetch("/api/economic-forecast/operations", { headers: { Accept: "application/json" } })
      .then(async (response) => { if (!response.ok) throw new Error("Operational status endpoint is unavailable."); return response.json() as Promise<EconomicForecastOperationsResponse>; })
      .then(setOperations)
      .catch((reason: unknown) => setOperationsError(reason instanceof Error ? reason.message : "Operational status unavailable."))
      .finally(() => setOperationsLoading(false));
  }, [operationsLoading]);
  const selectForecastTab = (tab: ForecastTab) => {
    setActiveTab(tab);
    if (tab !== "operations" || operations) return;
    loadOperations();
  };
  if (loading && !snapshot) return <section className="workspace-empty economic-forecast-state" aria-live="polite"><span className="workspace-kicker">ECONOMIC FORECAST</span><h2>Loading latest accepted snapshot…</h2><p>The API reads a compact cached JSON snapshot and never starts Python in this page request.</p></section>;
  if (!snapshot) return <section className="workspace-empty economic-forecast-state failed" role="alert"><span className="workspace-kicker">ECONOMIC FORECAST · UNAVAILABLE</span><h2>No last-known-good forecast</h2><p>{error ?? "The live service and bundled fallback are unavailable."}</p></section>;
  const stale = snapshot.freshness !== "current" || source !== "live";
  return (
    <section className="economic-forecast-workspace">
      <header className="economic-forecast-header"><div><span className="workspace-kicker">POINT-IN-TIME MACRO RESEARCH</span><h2>Economic Forecast <span>— CPI</span></h2><p>Validated snapshot API · Python training remains outside the browser request.</p></div><div className="economic-forecast-health"><span className={`freshness ${snapshot.freshness}`}><i /> {stale ? "STALE / FALLBACK" : "CURRENT"}</span><span><b>RUN</b>{snapshot.runId}</span></div></header>
      {(warning || stale || error) && <div className={`forecast-stale-banner ${error ? "failed" : ""}`} role={error ? "alert" : "status"}><b>{error ? "REFRESH FAILED · LAST GOOD PRESERVED" : stale ? "STALE · LAST KNOWN GOOD" : "NOTICE"}</b><span>{error ?? warning ?? snapshot.freshnessMessage}</span></div>}
      {refreshJob && <div className={`forecast-job-banner ${refreshJob.status}`} role="status"><b>{refreshJob.status.toUpperCase()}</b><span>{refreshJob.message}</span><code>{refreshJob.jobId}</code></div>}
      <nav className="economic-forecast-tabs" role="tablist" aria-label="Economic forecast views">{FORECAST_TABS.map((tab) => <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} aria-controls={`economic-forecast-${tab.id}`} className={activeTab === tab.id ? "active" : ""} onClick={() => selectForecastTab(tab.id)}>{tab.label}</button>)}</nav>
      <div id={`economic-forecast-${activeTab}`} role="tabpanel">{activeTab === "forecast" ? <ForecastSummary snapshot={snapshot} thresholdPct={thresholdPct} /> : activeTab === "distribution" ? <DistributionView snapshot={snapshot} thresholdPct={thresholdPct} onThresholdChange={setThresholdPct} /> : activeTab === "backtest" ? <BacktestView snapshot={snapshot} /> : activeTab === "drivers" ? <DriversView snapshot={snapshot} /> : activeTab === "provenance" ? <ProvenanceView snapshot={snapshot} source={source} /> : <OperationsView payload={operations} loading={operationsLoading} error={operationsError} onRetry={loadOperations} />}</div>
      <footer className="economic-forecast-actions"><p>{stale ? "Preview only: scenario creation requires accepted, current research. Refresh the evidence, then review the mapping again." : "Eligible research can be mapped for review; solver inputs are unchanged until a scenario revision is created."}</p><div><button onClick={onRefresh} disabled={!refreshEnabled || loading || refreshJob?.status === "queued" || refreshJob?.status === "running"} title={refreshEnabled ? "Start an authenticated background refresh" : "Configure the server-side forecast service to enable refresh"}>{refreshJob?.status === "queued" || refreshJob?.status === "running" ? "Refresh running…" : "Refresh forecast evidence"}</button><button className="scenario-button" onClick={() => onCreateScenario("p50")}>Preview scenario mapping</button></div></footer>
      {scenarioReview && <ScenarioReviewDrawer review={scenarioReview} onChangeQuantile={onCreateScenario} onClose={onCloseScenarioReview} onApply={onApplyScenario} />}
    </section>
  );
}
