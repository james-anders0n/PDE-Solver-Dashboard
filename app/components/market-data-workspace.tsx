"use client";

import { useState } from "react";
import { InfoPopover } from "@/app/components/info-popover";
import { ControlHelpLabel } from "@/app/components/control-help-label";
import { TechnicalTerminologyGuide } from "@/app/components/technical-terminology-guide";
import { MARKET_CONTROL_HELP, getMarketProposalHelp } from "@/app/lib/control-help";
import { displayUnit, formatEvidenceValue, formatUtcDate, formatUtcDateTime } from "@/app/lib/presentation";
import type { AppliedSnapshotHistory, MarketDataRequest, MarketSnapshot, MarketVisualSeries, ParameterProposal } from "@/app/lib/market-data";

const classificationLabels = {
  observed: "OBSERVED",
  derived: "DERIVED",
  calibrated: "CALIBRATED",
  scenario: "SCENARIO",
  proxy: "PROXY",
  manual: "MANUAL",
} as const;

function MarketLineChart({ series, label }: { series: MarketVisualSeries[]; label: string }) {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return <div className="market-chart market-chart-empty" role="img" aria-label={`${label} No plottable observations.`}>No plottable observations are available for this snapshot.</div>;
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const sx = (value: number) => 34 + ((value - xMin) / Math.max(1e-12, xMax - xMin)) * 532;
  const sy = (value: number) => 230 - ((value - yMin) / Math.max(1e-12, yMax - yMin)) * 188;
  return (
    <div className="market-chart" role="img" aria-label={label}>
      <svg viewBox="0 0 600 260" preserveAspectRatio="none" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="34" x2="566" y1={42 + line * 47} y2={42 + line * 47} className="market-grid-line" />)}
        {series.map((item, seriesIndex) => {
          const path = item.points.map((point, index) => `${index ? "L" : "M"}${sx(point.x).toFixed(2)},${sy(point.y).toFixed(2)}`).join(" ");
          return <g key={item.id} className={`market-series series-${seriesIndex % 4}`}>
            <path d={path} />
            {item.points.map((point, index) => <circle key={`${item.id}-${index}`} cx={sx(point.x)} cy={sy(point.y)} r={point.excluded ? 2 : 3.2} className={point.excluded ? "excluded" : ""} />)}
          </g>;
        })}
      </svg>
      <div className="market-chart-legend">
        {series.map((item, index) => <span key={item.id} className={`series-${index % 4}`}><i />{item.label}<small>{classificationLabels[item.classification]}</small></span>)}
      </div>
    </div>
  );
}

function BlackScholesSmileChart({ snapshot }: { snapshot: MarketSnapshot }) {
  const points = snapshot.primarySeries.flatMap((item) => item.points);
  if (points.length === 0 || !snapshot.blackScholes) {
    return <div className="market-chart market-chart-empty" role="img" aria-label="Black–Scholes implied-volatility smile has no plottable option quotes.">No option quotes passed the selected view and data-availability checks.</div>;
  }
  const xValues = points.map((point) => point.x);
  const yValues = points.flatMap((point) => [point.y, point.lower, point.upper].filter((value): value is number => Number.isFinite(value)));
  const rawXMin = Math.min(...xValues);
  const rawXMax = Math.max(...xValues);
  const rawYMin = Math.min(...yValues);
  const rawYMax = Math.max(...yValues);
  const xPad = Math.max(1, (rawXMax - rawXMin) * 0.06);
  const yPad = Math.max(0.005, (rawYMax - rawYMin) * 0.14);
  const xMin = rawXMin - xPad;
  const xMax = rawXMax + xPad;
  const yMin = Math.max(0, rawYMin - yPad);
  const yMax = rawYMax + yPad;
  const sx = (value: number) => 48 + ((value - xMin) / Math.max(1e-12, xMax - xMin)) * 510;
  const sy = (value: number) => 222 - ((value - yMin) / Math.max(1e-12, yMax - yMin)) * 178;
  const xTicks = Array.from({ length: 5 }, (_, index) => xMin + index * (xMax - xMin) / 4);
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + index * (yMax - yMin) / 4);
  const summary = points.map((point) => `${point.label ?? point.x}: ${(point.y * 100).toFixed(2)}%${point.excluded ? ` excluded: ${point.rejectionReason}` : point.selected ? " selected forward ATM" : ""}`).join("; ");
  return (
    <div className="market-chart bs-smile-chart" role="img" aria-label={`${snapshot.primaryTitle}. ${summary}`}>
      <svg viewBox="0 0 600 260" preserveAspectRatio="none" aria-hidden="true">
        {yTicks.map((tick) => <g key={`y-${tick}`}><line x1="48" x2="558" y1={sy(tick)} y2={sy(tick)} className="market-grid-line" /><text x="43" y={sy(tick) + 3} textAnchor="end" className="market-axis-label">{(tick * 100).toFixed(1)}%</text></g>)}
        {xTicks.map((tick) => <text key={`x-${tick}`} x={sx(tick)} y="242" textAnchor="middle" className="market-axis-label">{tick.toFixed(0)}</text>)}
        <text x="303" y="257" textAnchor="middle" className="market-axis-title">STRIKE K</text>
        {snapshot.blackScholes.forward >= xMin && snapshot.blackScholes.forward <= xMax && <g className="forward-marker"><line x1={sx(snapshot.blackScholes.forward)} x2={sx(snapshot.blackScholes.forward)} y1="38" y2="224" /><text x={sx(snapshot.blackScholes.forward) + 5} y="37">F {snapshot.blackScholes.forward.toFixed(2)}</text></g>}
        {snapshot.primarySeries.map((series, seriesIndex) => {
          const retained = series.points.filter((point) => !point.excluded);
          const path = retained.map((point, index) => `${index ? "L" : "M"}${sx(point.x).toFixed(2)},${sy(point.y).toFixed(2)}`).join(" ");
          return <g key={series.id} className={`market-series series-${seriesIndex % 4}`}>
            {path && <path d={path} />}
            {series.points.map((point, index) => <g key={`${series.id}-${index}`} className={`${point.excluded ? "excluded-point" : ""} ${point.selected ? "selected-point" : ""}`}>
              <title>{point.label}: midpoint IV {(point.y * 100).toFixed(3)}%{point.lower != null && point.upper != null ? `; bid/ask IV ${(point.lower * 100).toFixed(3)}%–${(point.upper * 100).toFixed(3)}%` : ""}{point.rejectionReason ? `; ${point.rejectionReason}` : ""}</title>
              {point.lower != null && point.upper != null && <><line x1={sx(point.x)} x2={sx(point.x)} y1={sy(point.lower)} y2={sy(point.upper)} className="iv-whisker" /><line x1={sx(point.x) - 3} x2={sx(point.x) + 3} y1={sy(point.lower)} y2={sy(point.lower)} className="iv-whisker" /><line x1={sx(point.x) - 3} x2={sx(point.x) + 3} y1={sy(point.upper)} y2={sy(point.upper)} className="iv-whisker" /></>}
              {point.excluded ? <><line x1={sx(point.x) - 4} x2={sx(point.x) + 4} y1={sy(point.y) - 4} y2={sy(point.y) + 4} className="excluded-cross" /><line x1={sx(point.x) - 4} x2={sx(point.x) + 4} y1={sy(point.y) + 4} y2={sy(point.y) - 4} className="excluded-cross" /></> : <circle cx={sx(point.x)} cy={sy(point.y)} r={point.selected ? 5.5 : 3.5} />}
              {point.selected && <circle cx={sx(point.x)} cy={sy(point.y)} r="9" className="atm-ring" />}
            </g>)}
          </g>;
        })}
      </svg>
      <div className="market-chart-legend">
        {snapshot.primarySeries.map((series, index) => <span key={series.id} className={`series-${index % 4}`}><i />{series.label}<small>Q · MID IV</small></span>)}
        <span className="legend-atm"><i />Forward ATM<small>|ln(K/F)|</small></span>
        <span className="legend-excluded"><i />Excluded<small>provider IV only</small></span>
      </div>
    </div>
  );
}

function BlackScholesVolatilityComparison({ snapshot }: { snapshot: MarketSnapshot }) {
  const volatility = snapshot.blackScholes?.volatility;
  if (!volatility) return <MarketLineChart series={snapshot.secondarySeries} label={`${snapshot.secondaryTitle}. ${snapshot.secondarySummary}`} />;
  const values = [
    { label: "ATM implied", value: volatility.selectedImpliedVolatility, measure: "Q", classification: "calibrated" },
    { label: "20 sessions", value: volatility.realised20, measure: "P", classification: "derived" },
    { label: "60 sessions", value: volatility.realised60, measure: "P", classification: "derived" },
    { label: "252 sessions", value: volatility.realised252, measure: "P", classification: "derived" },
  ].filter((item): item is { label: string; value: number; measure: string; classification: string } => item.value != null);
  const maximum = Math.max(...values.map((item) => item.value), 1e-8) * 1.12;
  return <div className="vol-comparison" role="img" aria-label={values.map((item) => `${item.label} ${item.measure}-measure ${(item.value * 100).toFixed(2)} percent`).join("; ")}>
    {values.map((item) => <div key={item.label} className={item.classification}>
      <span><b>{item.label}</b><small>{item.measure}-measure</small></span>
      <i><em style={{ height: `${Math.max(4, item.value / maximum * 100)}%` }} /></i>
      <strong>{(item.value * 100).toFixed(2)}%</strong>
    </div>)}
  </div>;
}

function HestonSurfaceVisual({ snapshot }: { snapshot: MarketSnapshot }) {
  const [view, setView] = useState<"heatmap" | "surface">("heatmap");
  const series = snapshot.primarySeries;
  const points = series.flatMap((item) => item.points);
  if (!snapshot.heston || !points.length) return <div className="market-chart market-chart-empty">No surface instruments are available.</div>;
  const retainedValues = points.filter((point) => !point.excluded).map((point) => point.y);
  const minimum = Math.min(...retainedValues);
  const maximum = Math.max(...retainedValues);
  const colour = (value: number, excluded?: boolean) => excluded
    ? "repeating-linear-gradient(135deg, rgba(255,98,104,.18) 0 4px, rgba(255,98,104,.04) 4px 8px)"
    : `hsl(${205 - (value - minimum) / Math.max(1e-8, maximum - minimum) * 165} 72% 46% / .78)`;
  const excluded = snapshot.heston.instruments.filter((item) => item.excluded);
  const exclusionCounts = [...new Set(excluded.map((item) => item.rejectionReason ?? "Excluded"))]
    .map((reason) => `${reason}: ${excluded.filter((item) => (item.rejectionReason ?? "Excluded") === reason).length}`).join("; ");
  return <div className={`heston-surface-visual ${view}`}>
    <div className="surface-view-toggle" aria-label="Volatility surface view">
      <button className={view === "heatmap" ? "active" : ""} onClick={() => setView("heatmap")}>Heatmap</button>
      <button className={view === "surface" ? "active" : ""} onClick={() => setView("surface")}>Desktop 3D</button>
    </div>
    <div className="heston-heatmap" role="img" aria-label={`${snapshot.primaryTitle}. ${series.map((row) => `${row.label}: ${row.points.length} points`).join("; ")}. Excluded summary: ${exclusionCounts || "none"}.`}>
      {series.map((row) => <div className="heston-heatmap-row" key={row.id}>
        <b>{row.label}</b>
        <div>{[...row.points].sort((a, b) => a.x - b.x).map((point, index) => <span
          key={`${row.id}-${index}`}
          className={point.excluded ? "excluded" : ""}
          style={{ background: colour(point.y, point.excluded), height: view === "surface" ? `${30 + (point.y - minimum) / Math.max(1e-8, maximum - minimum) * 58}px` : undefined }}
          title={`${point.label}: x=${point.x.toFixed(4)}, IV=${(point.y * 100).toFixed(3)}%${point.rejectionReason ? `; ${point.rejectionReason}` : ""}`}
        ><i>{point.x.toFixed(2)}</i><em>{(point.y * 100).toFixed(1)}%</em></span>)}</div>
      </div>)}
    </div>
    <div className="heston-colour-legend"><span>{(minimum * 100).toFixed(1)}% IV</span><i /><span>{(maximum * 100).toFixed(1)}% IV</span><small>Forward log-moneyness x = ln(K/F)</small></div>
    <details className="excluded-summary"><summary>{excluded.length} excluded instruments · accessible summary</summary><p>{exclusionCounts || "No exclusions."}</p></details>
  </div>;
}

function HestonResidualVisual({ snapshot }: { snapshot: MarketSnapshot }) {
  const result = snapshot.heston?.calibration;
  if (!result) return <div className="market-chart market-chart-empty heston-residual-empty"><b>Calibration not run</b><span>The prepared surface and seeds are unchanged. Run calibration to create market-minus-model residuals.</span></div>;
  const maximum = Math.max(...result.residuals.map((item) => Math.abs(item.error)), 1e-8);
  const colour = (value: number) => value >= 0
    ? `hsl(166 68% 43% / ${0.2 + 0.75 * Math.abs(value) / maximum})`
    : `hsl(4 78% 58% / ${0.2 + 0.75 * Math.abs(value) / maximum})`;
  return <div className="heston-residual-visual">
    <div className="heston-heatmap residual" role="img" aria-label={result.expirySummaries.map((item) => `${item.expiration} weighted RMSE ${item.weightedRmse}`).join("; ")}>
      {result.expirySummaries.map((summary) => <div className="heston-heatmap-row" key={summary.expiration}>
        <b>{summary.expiration}</b>
        <div>{result.residuals.filter((item) => item.expiration === summary.expiration).sort((a, b) => a.logMoneyness - b.logMoneyness).map((item) => <span key={item.contractSymbol} style={{ background: colour(item.error) }} title={`${item.contractSymbol}: market minus model ${item.error.toExponential(4)}`}><i>{item.logMoneyness.toFixed(2)}</i><em>{item.error.toExponential(1)}</em></span>)}</div>
      </div>)}
    </div>
    <div className="expiry-summary-list">{result.expirySummaries.map((item) => <span key={item.expiration}><b>{item.expiration}</b><small>{item.instruments} instruments</small><em>RMSE {item.weightedRmse.toExponential(2)}</em><em>MAX {item.maximumError.toExponential(2)}</em></span>)}</div>
  </div>;
}

function VasicekHistoryVisual({ snapshot }: { snapshot: MarketSnapshot }) {
  const details = snapshot.vasicek;
  if (!details) return <MarketLineChart series={snapshot.primarySeries} label={`${snapshot.primaryTitle}. ${snapshot.primarySummary}`} />;
  return <div className="vasicek-history-visual">
    <MarketLineChart series={snapshot.primarySeries} label={`${snapshot.primaryTitle}. ${snapshot.primarySummary}. ${details.removedObservations.map((item) => `${item.date} removed: ${item.reason}`).join("; ")}`} />
    <div className="vasicek-window-band"><span><b>FIT WINDOW</b>{details.pEstimate.window[0]}</span><i /><span>{details.pEstimate.window[1]}</span></div>
    <details className="excluded-summary"><summary>{details.removedObservations.length} removed observations · explicit policy record</summary>
      {details.removedObservations.length ? details.removedObservations.map((item) => <p key={item.date}><b>{item.date}</b> {(item.value * 100).toFixed(4)}% · {item.reason}</p>) : <p>No observations were removed.</p>}
    </details>
  </div>;
}

function VasicekDiagnostics({ snapshot }: { snapshot: MarketSnapshot }) {
  const details = snapshot.vasicek;
  if (!details) return <MarketLineChart series={snapshot.secondarySeries} label={`${snapshot.secondaryTitle}. ${snapshot.secondarySummary}`} />;
  const estimate = details.pEstimate;
  const residuals = estimate.residuals;
  const residualStd = Math.max(estimate.residualDiagnostics.standardDeviation, 1e-15);
  const bins = Array.from({ length: 13 }, (_, index) => ({ centre: -3 + index * 0.5, count: 0 }));
  residuals.forEach((value) => {
    const z = Math.max(-3.25, Math.min(3.25, value / residualStd));
    bins[Math.max(0, Math.min(bins.length - 1, Math.round((z + 3) / 0.5)))].count += 1;
  });
  const maximum = Math.max(...bins.map((item) => item.count), 1);
  const intervals = [
    ["aᴾ", estimate.intervals.meanReversion],
    ["bᴾ", estimate.intervals.longRunRate],
    ["σᵣᴾ", estimate.intervals.rateVolatility],
  ] as const;
  const proxySeries = snapshot.secondarySeries.filter((series) => series.classification === "proxy");
  return <div className="vasicek-diagnostics-visual">
    <div className="vasicek-residual-histogram" role="img" aria-label={`Standardized OU residual distribution. Lag one autocorrelation ${estimate.residualDiagnostics.lag1Autocorrelation.toFixed(4)}. Jarque Bera ${estimate.residualDiagnostics.jarqueBera.toFixed(3)}.`}>
      {bins.map((bin) => <span key={bin.centre}><i style={{ height: `${Math.max(2, bin.count / maximum * 100)}%` }} /><small>{bin.centre.toFixed(1)}</small></span>)}
    </div>
    <div className="vasicek-intervals" aria-label="Historical parameter confidence intervals">
      {intervals.map(([label, interval]) => <span key={label}><b>{label}</b><strong>{interval.estimate.toFixed(6)}</strong><small>95% [{interval.lower.toFixed(6)}, {interval.upper.toFixed(6)}]</small></span>)}
    </div>
    <div className="vasicek-residual-stats"><span><b>MEAN</b>{estimate.residualDiagnostics.mean.toExponential(2)}</span><span><b>LAG-1 ACF</b>{estimate.residualDiagnostics.lag1Autocorrelation.toFixed(4)}</span><span><b>JARQUE–BERA</b>{estimate.residualDiagnostics.jarqueBera.toFixed(3)}</span></div>
    {proxySeries.length > 0 && <><h4>Treasury ETF validation overlays · PROXY</h4><MarketLineChart series={proxySeries} label="Normalized SHY, IEF and TLT validation overlays. ETF shares are not zero-coupon bonds." /></>}
  </div>;
}

function HullWhiteCurveVisual({ snapshot }: { snapshot: MarketSnapshot }) {
  const [view, setView] = useState<"yield" | "discount" | "forward">("yield");
  const series = view === "yield"
    ? snapshot.primarySeries.filter((item) => item.id === "raw-yield" || item.id === "yield")
    : view === "discount"
      ? snapshot.primarySeries.filter((item) => item.id === "raw-discount" || item.id === "discount")
      : snapshot.primarySeries.filter((item) => item.id === "forward");
  return <div className="hull-white-curve-visual">
    <div className="surface-view-toggle curve-view-toggle" aria-label="Curve view">
      {(["yield", "discount", "forward"] as const).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{item === "yield" ? "Yield" : item === "discount" ? "Discount" : "Forward"}</button>)}
    </div>
    <MarketLineChart series={series} label={`${view} curve. ${snapshot.primarySummary}`} />
    <div className="curve-status-strip"><b>PROXY · NOT OIS</b><span>{snapshot.hullWhite?.mode === "bootstrap" ? "Documented Treasury bootstrap" : "Continuous-zero approximation"}</span><span>Natural cubic log-discount interpolation</span></div>
  </div>;
}

function HullWhitePillarTable({ snapshot }: { snapshot: MarketSnapshot }) {
  const details = snapshot.hullWhite;
  if (!details) return null;
  return <section className="market-panel hull-white-pillar-panel" aria-label="Hull–White immutable curve pillar table">
    <header><div><span>IMMUTABLE CURVE SNAPSHOT</span><h3>Pillars and reproduction</h3></div><b>{details.pillars.length} pillars</b></header>
    <div className="hull-white-pillar-table" role="table">
      <div className="hull-white-pillar-row head" role="row"><span>Tenor</span><span>Raw quote</span><span>Quote date</span><span>Normalized</span><span>Discount</span><span>Fit error</span></div>
      {details.pillars.map((pillar) => <details key={pillar.seriesId} className="hull-white-pillar-row" role="row">
        <summary>
          <span><b>{pillar.tenorLabel}</b><small>{pillar.seriesId}</small></span>
          <span>{pillar.rawQuote.toFixed(3)}%</span>
          <span>{pillar.quoteDate}</span>
          <span>{(pillar.normalizedRate * 100).toFixed(4)}%</span>
          <span>{pillar.discount.toFixed(8)}</span>
          <span>{(pillar.reproductionError * 10_000).toExponential(2)} bp</span>
        </summary>
        <div><span><b>Instrument</b>{pillar.constructionInstrument}</span><span><b>Convention</b>{pillar.dayCount} · {pillar.compounding}</span><span><b>Vintage</b>{pillar.realtimeStart} → {pillar.realtimeEnd}</span>{pillar.adjustment && <strong>{pillar.adjustment}</strong>}</div>
      </details>)}
    </div>
  </section>;
}

function HullWhiteEtfProxyCard({ snapshot }: { snapshot: MarketSnapshot }) {
  const proxies = snapshot.hullWhite?.etfOptionProxies ?? [];
  if (!proxies.length) return null;
  return <section className="market-panel hull-white-etf-card" aria-label="Treasury ETF option scenario proxies">
    <header><div><span>OPTIONAL AMBER SCENARIO</span><h3>Treasury ETF option information</h3></div><b>PROXY · NOT SWAPTION</b></header>
    <p>These observations may inform a rate-volatility scenario only. They never calibrate Hull–White σᵣ and remain separate from the curve.</p>
    <div>{proxies.map((proxy) => <span key={proxy.symbol}><b>{proxy.symbol}</b><strong>{(proxy.impliedVolatility * 100).toFixed(2)}% IV</strong><small>{proxy.contractSymbol} · K {proxy.strike} · OI {proxy.openInterest}</small></span>)}</div>
  </section>;
}

function MertonOpportunityHistory({ snapshot }: { snapshot: MarketSnapshot }) {
  const [view, setView] = useState<"adjusted-history" | "rolling-mean" | "rolling-volatility" | "regime-timeline">("adjusted-history");
  const series = snapshot.primarySeries.filter((item) => item.id === view);
  const labels = { "adjusted-history": "Adjusted history", "rolling-mean": "Rolling μ", "rolling-volatility": "Rolling σ", "regime-timeline": "Regime timeline" } as const;
  return <div className="merton-opportunity-history">
    <div className="surface-view-toggle opportunity-view-toggle" aria-label="Opportunity-set history view">
      {(Object.keys(labels) as Array<keyof typeof labels>).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{labels[item]}</button>)}
    </div>
    <MarketLineChart series={series} label={`${labels[view]}. ${snapshot.primarySummary}`} />
    <div className="opportunity-measure-strip"><b>P-MEASURE OPPORTUNITY SET</b><span>Adjusted total returns</span><span>VIX = regime signal, not asset σ</span></div>
  </div>;
}

function MertonAllocationView({
  snapshot,
}: {
  snapshot: MarketSnapshot;
}) {
  const details = snapshot.mertonOpportunity;
  const [wealth, setWealth] = useState(details?.previewControls.wealth ?? 100);
  const [riskAversion, setRiskAversion] = useState(details?.previewControls.riskAversion ?? 3);
  if (!details) return <MarketLineChart series={snapshot.secondarySeries} label={`${snapshot.secondaryTitle}. ${snapshot.secondarySummary}`} />;
  const previews = details.allocationPreviews.map((preview) => {
    const unconstrained = (preview.expectedReturn - preview.rate) * wealth / (Math.max(riskAversion, 0.05) * preview.volatility ** 2);
    const applied = Math.max(details.previewControls.controlMin, Math.min(details.previewControls.controlMax, unconstrained));
    return { ...preview, unconstrainedAllocation: unconstrained, appliedAllocation: applied, binding: unconstrained < details.previewControls.controlMin ? "lower" as const : unconstrained > details.previewControls.controlMax ? "upper" as const : "none" as const };
  });
  const absoluteMaximum = Math.max(...previews.map((item) => Math.abs(item.appliedAllocation)), 1);
  return <div className="merton-allocation-view">
    <div className="opportunity-sensitivity-controls" aria-label="Allocation preview sensitivity controls">
      <div><span><ControlHelpLabel label="Preview wealth" help={MARKET_CONTROL_HELP.previewWealth} /><b>{wealth.toFixed(0)}</b></span><input aria-label="Preview wealth" type="range" min="10" max="500" step="5" value={wealth} onChange={(event) => setWealth(Number(event.target.value))} /></div>
      <div><span><ControlHelpLabel label="Preview risk aversion" help={MARKET_CONTROL_HELP.previewRiskAversion} /><b>{riskAversion.toFixed(1)}</b></span><input aria-label="Preview risk aversion" type="range" min="0.5" max="10" step="0.1" value={riskAversion} onChange={(event) => setRiskAversion(Number(event.target.value))} /></div>
      <small>Preview only · does not change HJB controls, run the PDE, or start Monte Carlo</small>
    </div>
    <div className="opportunity-allocation-list" role="img" aria-label={previews.map((item) => `${item.label} allocation ${item.appliedAllocation.toFixed(2)}${item.binding === "none" ? "" : ` ${item.binding} bound binding`}`).join("; ")}>
      {previews.map((item) => <article key={item.id} className={item.binding !== "none" ? "binding" : ""}>
        <header><span><b>{item.label}</b><small>{item.probability == null ? "ESTIMATED BASE" : `${(item.probability * 100).toFixed(1)}% probability`}</small></span><strong>{item.appliedAllocation.toFixed(2)}</strong></header>
        <div className="allocation-track"><i style={{ width: `${Math.abs(item.appliedAllocation) / absoluteMaximum * 100}%` }} /></div>
        <p>μ {(item.expectedReturn * 100).toFixed(2)}% · σ {(item.volatility * 100).toFixed(2)}% · r {(item.rate * 100).toFixed(2)}% · μ−r {(item.excessReturn * 100).toFixed(2)}%</p>
        <footer><span>{item.binding === "none" ? `Uncertainty ${item.allocationInterval[0].toFixed(1)} to ${item.allocationInterval[1].toFixed(1)}` : `${item.binding.toUpperCase()} CONTROL BOUND BINDS`}</span></footer>
      </article>)}
    </div>
  </div>;
}

interface MarketDataWorkspaceProps {
  request: MarketDataRequest;
  snapshot: MarketSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedIds: ReadonlySet<string>;
  lastApplied: AppliedSnapshotHistory | null;
  calibrating?: boolean;
  onToggleProposal(id: string): void;
  onRunCalibration?(): void;
  onCancelCalibration?(): void;
  onSaveHistoricalScenario?(): void;
  historicalScenarioStatus?: string;
  onApply(): void;
  onRestore(): void;
}

function MarketProposalRow({ proposal, snapshot, selected, onToggle }: { proposal: ParameterProposal; snapshot: MarketSnapshot; selected: boolean; onToggle(id: string): void }) {
  const unit = proposal.provenance.unit;
  return <details className={`mapping-row ${proposal.classification} ${!proposal.applicable ? "disabled" : ""}`}>
    <summary>
      <input
        type="checkbox"
        aria-label={`Apply proposed ${proposal.label}`}
        checked={selected}
        disabled={!proposal.applicable || Boolean(snapshot.heston && proposal.calibrationRole === "calibrated") || Boolean(snapshot.hullWhite && (proposal.id === "curveId" || proposal.id === "shortRate"))}
        onClick={(event) => event.stopPropagation()}
        onChange={() => onToggle(proposal.id)}
      />
      <span><b><ControlHelpLabel label={proposal.label} help={getMarketProposalHelp(snapshot.model, proposal)} /> <i>{proposal.symbol}</i></b><small>{formatEvidenceValue(proposal.currentValue, unit)} <em>→</em> {formatEvidenceValue(proposal.proposedValue, unit)}</small></span>
      <span className={`classification ${proposal.classification}`}>{snapshot.vasicek || snapshot.mertonOpportunity ? `${proposal.provenance.measure} · ` : ""}{proposal.calibrationRole === "seed" ? "SEED" : classificationLabels[proposal.classification]}</span>
    </summary>
    <div className="mapping-provenance">
      {proposal.warning && <strong>{proposal.warning}</strong>}
      {proposal.bounds && <span><b>Bounds</b>{formatEvidenceValue(proposal.bounds[0], unit)} to {formatEvidenceValue(proposal.bounds[1], unit)}{proposal.calibrationRole ? ` · ${proposal.calibrationRole}` : ""}</span>}
      <span><b>Provider</b>{proposal.provenance.provider} · {proposal.provenance.sourceIdentifiers.join(", ")}</span>
      <span><b>Observed</b>{formatUtcDateTime(proposal.provenance.observationTimestamp)}</span>
      <span><b>Available</b>{formatUtcDateTime(proposal.provenance.availableTimestamp)}{proposal.provenance.vintage ? ` · vintage ${proposal.provenance.vintage}` : ""}</span>
      <span><b>Transformation</b>{proposal.provenance.formula}</span>
      <span><b>Interpretation</b>{proposal.provenance.financialInterpretation}</span>
      <span><b>Convention</b>{displayUnit(unit) || "native unit"} · {proposal.provenance.compounding}</span>
      <span><b>Freshness</b>{proposal.provenance.stalenessPolicy}</span>
      <span className="expert-raw-value"><b>Precise raw values</b><code>{proposal.currentValue} → {proposal.proposedValue} [{unit}]</code></span>
    </div>
  </details>;
}

export function MarketDataWorkspace({ request, snapshot, loading, error, selectedIds, lastApplied, calibrating = false, onToggleProposal, onRunCalibration, onCancelCalibration, onSaveHistoricalScenario, historicalScenarioStatus, onApply, onRestore }: MarketDataWorkspaceProps) {
  if (!snapshot) {
    return (
      <section className="workspace-empty market-empty">
        <span className="workspace-kicker">MARKET DATA · {request.model.toUpperCase()}</span>
        <h2>{loading ? "Fetching and validating providers…" : "Prepare a market snapshot"}</h2>
        <p>Use the compact controls in the sidebar to select a source, instrument and as-of date. Fetching creates a reviewable preview and never changes solver inputs.</p>
        {error && <div className="market-error" role="alert"><b>Provider request failed</b><span>{error}</span><small>The last successful snapshot, if any, is retained.</small></div>}
        <div className="workflow-steps" aria-label="Market data workflow"><span className="active">1 Fetch</span><span>2 Validate</span><span>3 Preview</span><span>4 Apply</span></div>
      </section>
    );
  }

  const canApply = selectedIds.size > 0 && snapshot.validationIssues.length === 0
    && (!snapshot.heston || Boolean(snapshot.heston.calibration))
    && (!snapshot.vasicek || snapshot.vasicek.requestedMeasureMode === "q-curve" && Boolean(snapshot.vasicek.qCalibration));
  const changedProposals = snapshot.proposals.filter((proposal) => selectedIds.has(proposal.id) || proposal.currentValue !== proposal.proposedValue);
  return (
    <div className="market-workspace">
      <header className="market-header">
        <div>
          <span className="workspace-kicker">MARKET DATA · {snapshot.workspaceLabel.toUpperCase()}</span>
          <h2>{snapshot.instrument} <span>· {snapshot.currency}</span></h2>
          <p>As of {formatUtcDate(snapshot.asOfDate)} · snapshot {snapshot.id}</p>
        </div>
        <div className="market-health" aria-label="Provider health">
          <span className={`freshness ${snapshot.freshness}`}>{snapshot.freshness.toUpperCase()}</span>
          {snapshot.providerHealth.map((health) => <span key={health.provider} className={health.state}><b>{health.provider}</b>{health.message}</span>)}
        </div>
      </header>

      <div className="workflow-steps" aria-label="Market data workflow"><span className="complete">1 Fetch</span><span className="complete">2 Validate</span><span className="active">3 Preview</span><span>4 Apply</span></div>
      <p className="market-freshness">{snapshot.freshnessMessage}</p>
      {snapshot.blackScholes && <div className="bs-snapshot-context" aria-label="Black–Scholes equity snapshot context">
        <span><b>SPOT TIME</b>{formatUtcDateTime(snapshot.blackScholes.spotTimestamp)}</span>
        <span><b>EXPIRATION</b>{formatUtcDate(snapshot.blackScholes.expiration)}</span>
        <span><b>FORWARD</b>{snapshot.blackScholes.forward.toFixed(4)}</span>
        <span><b>DIVIDEND</b>{snapshot.blackScholes.dividend.selectedMethod.toUpperCase()}</span>
        <span><b>RATE</b>{snapshot.blackScholes.rate.mode === "treasury-proxy" ? snapshot.blackScholes.rate.sourceSeries.join(" → ") : "MANUAL"}</span>
      </div>}
      {snapshot.heston && <div className="bs-snapshot-context heston-snapshot-context" aria-label="Heston volatility surface context">
        <span><b>SPOT TIME</b>{formatUtcDateTime(snapshot.heston.spotTimestamp)}</span>
        <span><b>SURFACE</b>{snapshot.heston.surfaceId}</span>
        <span><b>EXPIRIES</b>{snapshot.heston.retainedExpirations.length}</span>
        <span><b>OBJECTIVE</b>{snapshot.heston.calibrationSettings.objective.toUpperCase()}</span>
        <span><b>STATE</b>{calibrating ? "CALIBRATING" : snapshot.heston.calibration ? "CALIBRATED" : "SEEDS ONLY"}</span>
      </div>}
      {snapshot.vasicek && <div className="bs-snapshot-context vasicek-snapshot-context" aria-label="Vasicek rate-history fit context">
        <span><b>SERIES</b>{snapshot.vasicek.series}</span>
        <span><b>VINTAGE</b>{snapshot.vasicek.vintage}</span>
        <span><b>SAMPLING</b>{snapshot.vasicek.pEstimate.sampling.toUpperCase()}</span>
        <span><b>ESTIMATOR</b>{snapshot.vasicek.pEstimate.estimatorVersion}</span>
        <span><b>MEASURE MODE</b>{snapshot.vasicek.requestedMeasureMode === "historical-p" ? "P SCENARIO" : snapshot.vasicek.qCalibration ? "Q CALIBRATED" : "Q UNAVAILABLE"}</span>
      </div>}
      {snapshot.vasicek && <div className="vasicek-measure-explainer"><b>P history ≠ Q pricing</b><span>The time-series OU fit estimates physical-measure dynamics. Saving it creates an immutable scenario and does not change the Q solver base. Only a documented cross-sectional curve calibration may apply a, b and σᵣ as Q parameters.</span></div>}
      {snapshot.hullWhite && <div className="bs-snapshot-context hull-white-snapshot-context" aria-label="Hull–White curve snapshot context">
        <span><b>CURVE ID</b>{snapshot.hullWhite.curve.id}</span>
        <span><b>MODE</b>{snapshot.hullWhite.mode.toUpperCase()}</span>
        <span><b>FRONT ANCHOR</b>{snapshot.hullWhite.frontSeries}</span>
        <span><b>PILLARS</b>{snapshot.hullWhite.pillars.length}</span>
        <span><b>STATUS</b>PROXY · NOT OIS</span>
      </div>}
      {snapshot.mertonOpportunity && <div className="bs-snapshot-context merton-opportunity-context" aria-label="Merton HJB investment opportunity set context">
        <span><b>MEASURE</b>P · CONTROL</span>
        <span><b>HISTORY</b>{snapshot.mertonOpportunity.historySessionsRetained} sessions</span>
        <span><b>ESTIMATOR</b>{snapshot.mertonOpportunity.returnEstimates.selected.toUpperCase()}</span>
        <span><b>RATE</b>{snapshot.mertonOpportunity.opportunityRate.seriesId}{snapshot.mertonOpportunity.opportunityRate.proxy ? " · PROXY" : ""}</span>
        <span><b>BRIDGE</b>{snapshot.mertonOpportunity.mappingVersion}</span>
      </div>}
      {error && <div className="market-error" role="alert"><b>Latest refresh failed</b><span>{error}</span><small>This displayed snapshot is the last successful version.</small></div>}
      {snapshot.validationIssues.length > 0 && <div className="market-error" role="alert"><b>Snapshot cannot be applied</b>{snapshot.validationIssues.map((issue) => <span key={issue}>{issue}</span>)}</div>}
      {snapshot.warnings.length > 0 && <div className="market-warning" role="status"><b>Review required</b>{snapshot.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}

      <div className="market-main-grid">
        <section className="market-panel market-primary">
          <header><div><span>PRIMARY MODEL VISUAL</span><h3>{snapshot.primaryTitle}</h3></div><InfoPopover label={snapshot.primaryTitle}><p>{snapshot.primarySummary}</p></InfoPopover></header>
          {snapshot.model === "Black–Scholes" ? <BlackScholesSmileChart snapshot={snapshot} /> : snapshot.model === "Heston" ? <HestonSurfaceVisual snapshot={snapshot} /> : snapshot.model === "Vasicek" ? <VasicekHistoryVisual snapshot={snapshot} /> : snapshot.model === "Hull–White" ? <HullWhiteCurveVisual snapshot={snapshot} /> : snapshot.model === "HJB" ? <MertonOpportunityHistory snapshot={snapshot} /> : <MarketLineChart series={snapshot.primarySeries} label={`${snapshot.workspaceLabel}: ${snapshot.primaryTitle}. ${snapshot.primarySummary}`} />}
        </section>

        <section className="market-panel mapping-panel" aria-label="Changed parameter mapping">
          <header><div><span>PARAMETER MAPPING</span><h3>Changed parameters</h3></div><b>{selectedIds.size} selected{snapshot.heston?.calibration ? ` · Feller ${snapshot.heston.calibration.fellerRatio >= 1 ? "PASS" : "DIAGNOSTIC"}` : ""}</b></header>
          <div className="mapping-list">
            {changedProposals.map((proposal) => <MarketProposalRow key={proposal.id} proposal={proposal} snapshot={snapshot} selected={selectedIds.has(proposal.id)} onToggle={onToggleProposal} />)}
            {!changedProposals.length && <p className="market-no-changes">No parameter values differ from the active base.</p>}
          </div>
          <details className="market-evidence-disclosure"><summary><span><b>All mappings and detailed provenance</b><small>{snapshot.proposals.length} parameter mappings · precise raw values retained</small></span><i aria-hidden="true">+</i></summary><div className="mapping-list">{snapshot.proposals.map((proposal) => <MarketProposalRow key={proposal.id} proposal={proposal} snapshot={snapshot} selected={selectedIds.has(proposal.id)} onToggle={onToggleProposal} />)}</div></details>
          <div className="mapping-actions">
            {snapshot.heston && (calibrating
              ? <button className="cancel-calibration-button" onClick={onCancelCalibration}>Cancel calibration</button>
              : <button className="run-calibration-button" onClick={onRunCalibration} disabled={snapshot.validationIssues.length > 0}>Run calibration</button>)}
            {snapshot.vasicek?.requestedMeasureMode === "historical-p"
              ? <button className="apply-market-button vasicek-scenario-button" onClick={onSaveHistoricalScenario}>Save P historical scenario</button>
              : <button className="apply-market-button" onClick={onApply} disabled={!canApply}>Apply {selectedIds.size} changes to {snapshot.measure} base</button>}
            {lastApplied && <button className="restore-market-button" onClick={onRestore}>Restore previous inputs</button>}
          </div>
          {snapshot.vasicek && historicalScenarioStatus && <p className="vasicek-scenario-status" role="status">{historicalScenarioStatus}</p>}
        </section>
      </div>

      <div className="market-evidence-disclosures">
        <details className="market-evidence-disclosure"><summary><span><b>Model diagnostics and residuals</b><small>{snapshot.secondaryTitle}</small></span><i aria-hidden="true">+</i></summary><section className="market-panel">
          <header><div><span>SECONDARY DIAGNOSTIC</span><h3>{snapshot.secondaryTitle}</h3></div><InfoPopover label={snapshot.secondaryTitle}><p>{snapshot.secondarySummary}</p></InfoPopover></header>
          {snapshot.model === "Black–Scholes" ? <BlackScholesVolatilityComparison snapshot={snapshot} /> : snapshot.model === "Heston" ? <HestonResidualVisual snapshot={snapshot} /> : snapshot.model === "Vasicek" ? <VasicekDiagnostics snapshot={snapshot} /> : snapshot.model === "HJB" ? <MertonAllocationView snapshot={snapshot} /> : <MarketLineChart series={snapshot.secondarySeries} label={`${snapshot.secondaryTitle}. ${snapshot.secondarySummary}`} />}
        </section></details>
        <details className="market-evidence-disclosure"><summary><span><b>Raw observations and operational diagnostics</b><small>Data quality, timestamps, source identifiers, and expert raw values</small></span><i aria-hidden="true">+</i></summary><section className="market-panel market-diagnostics">
          <header><div><span>DATA QUALITY</span><h3>Validation and provenance</h3></div></header>
          <div>{snapshot.diagnostics.map((item) => <span key={item.label}><b>{item.label}</b>{item.value}</span>)}</div>
          <div className="market-observation-list">{snapshot.observations.map((item) => <p key={`${item.provider}-${item.identifier}`}><b>{item.provider} · {item.identifier}</b><span>{formatEvidenceValue(item.value, item.unit)} · observed {formatUtcDateTime(item.observationTimestamp)} · available {formatUtcDateTime(item.availableTimestamp)}{item.vintage ? ` · vintage ${item.vintage}` : ""}</span><code>Raw {String(item.value)} [{item.unit}]</code></p>)}</div>
          <TechnicalTerminologyGuide />
        </section></details>
      </div>

      {snapshot.hullWhite && <details className="market-evidence-disclosure"><summary><span><b>Curve pillars and proxy instruments</b><small>Immutable reproduction table and ETF proxy evidence</small></span><i aria-hidden="true">+</i></summary><div className="hull-white-detail-grid"><HullWhitePillarTable snapshot={snapshot} /><HullWhiteEtfProxyCard snapshot={snapshot} /></div></details>}

      {lastApplied && <div className="market-applied-banner"><span>Snapshot {lastApplied.snapshot.id} was applied without starting a solver. Continue with the Solve stage when the case is ready.</span></div>}
    </div>
  );
}
