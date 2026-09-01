"use client";

import type { ParameterUncertaintyResult } from "@/app/lib/parameter-uncertainty";

interface ParameterUncertaintyResultsProps {
  result: ParameterUncertaintyResult | null;
  running: boolean;
  progress: number;
  stage: string;
  error: string | null;
  cacheHit: boolean;
  lockedReason: string | null;
  budget: string;
  onBudgetChange(value: string): void;
  onRunOrCancel(): void;
}

const output = (value: number) => Number.isFinite(value) ? value.toFixed(6) : "Unavailable";

export function ParameterUncertaintyResults({ result, running, progress, stage, error, cacheHit, lockedReason, budget, onBudgetChange, onRunOrCancel }: ParameterUncertaintyResultsProps) {
  const maximumCount = Math.max(...(result?.histogram.map((bin) => bin.count) ?? [1]));
  return <section className="parameter-uncertainty-panel" aria-label="PDE parameter uncertainty propagation">
    <header><div><span className="workspace-kicker">PARAMETER-UNCERTAINTY PROPAGATION</span><h3>CPI-conditioned deterministic PDE outputs</h3><p>Neither a risk-neutral price-path simulation nor a market-calibrated price distribution.</p></div><b>NOT PATH MC</b></header>
    <div className="parameter-uncertainty-controls">
      <label><span><b>Sample budget</b><small>Full budget is compared with its first half for stability.</small></span><select value={budget} disabled={running} onChange={(event) => onBudgetChange(event.target.value)}><option value="32">32 mapped solves</option><option value="64">64 mapped solves</option><option value="128">128 mapped solves</option><option value="256">256 mapped solves</option></select></label>
      <div><span><b>Propagation seed</b><small>Fixed and exported</small></span><code>20260824</code></div>
      <button onClick={onRunOrCancel} disabled={Boolean(lockedReason) && !running}>{running ? "Cancel propagation" : result ? "Re-run identical propagation" : "Run parameter propagation"}</button>
    </div>
    {lockedReason && <div className="parameter-uncertainty-locked"><b>LOCKED</b><span>{lockedReason}</span></div>}
    {(running || stage) && <div className="parameter-uncertainty-progress" role="status"><span><b>{cacheHit ? "CACHE" : running ? `${progress}%` : "STATUS"}</b>{stage}</span><i><em style={{ width: `${running ? progress : result ? 100 : 0}%` }} /></i></div>}
    {error && <div className="parameter-uncertainty-error" role="alert"><b>PROPAGATION FAILED</b><span>{error}</span></div>}
    {result ? <>
      <div className="parameter-uncertainty-audit"><span><b>Source run</b>{result.forecastRunId}</span><span><b>Distribution</b>{result.sourceDistributionMethod} v{result.sourceDistributionVersion}</span><span><b>Seeds</b>source {result.sourceDistributionSeed} · propagation {result.propagationSeed}</span><span><b>Mapping</b>{result.mappingVersion}</span><span><b>Dependence</b>{result.dependenceMethod}</span><span><b>Budget</b>{result.sampleBudget} deterministic solves</span></div>
      <div className="parameter-output-summary"><article><span>Mean {result.outputLabel}</span><strong>{output(result.summary.mean)}</strong></article><article><span>P10–P90</span><strong>{output(result.summary.p10)}–{output(result.summary.p90)}</strong></article><article><span>Standard deviation</span><strong>{output(result.summary.standardDeviation)}</strong></article><article className={result.stability.stable ? "accepted" : "review"}><span>Budget stability</span><strong>{result.stability.stable ? "PASS" : "REVIEW"}</strong><small>{result.stability.smallerBudget}→{result.stability.largerBudget}; mean Δ {output(result.stability.meanAbsoluteChange)}</small></article></div>
      <div className="parameter-output-histogram" role="img" aria-label={`${result.outputLabel} distribution from CPI parameter uncertainty`}><div className="parameter-output-bars">{result.histogram.map((bin, index) => <span key={`${bin.lower}-${index}`} title={`${output(bin.lower)} to ${output(bin.upper)}: ${bin.count}`}><i style={{ height: `${bin.count / maximumCount * 100}%` }} /></span>)}</div><div className="parameter-output-axis"><span>{output(result.summary.minimum)}</span><b>{result.outputLabel}</b><span>{output(result.summary.maximum)}</span></div></div>
      <div className="parameter-propagation-gates"><article><b>Deterministic convergence gate</b><span>{result.convergenceGate.accepted ? "Passed" : "Review"}</span><small>Point error {result.convergenceGate.pointwiseError.toExponential(2)} · max norm {result.convergenceGate.maxNormError.toExponential(2)} · domain Δ {result.convergenceGate.domainExpansionDelta.toExponential(2)}</small></article><article><b>Sample-budget gate</b><span>{result.stability.stable ? "Stable" : "Increase or review"}</span><small>Mean and median changes must remain below {result.stability.tolerance.toExponential(2)}.</small></article></div>
      <details className="parameter-trace-table"><summary>Trace every CPI sample to its deterministic PDE result</summary><div><table><thead><tr><th>#</th><th>CPI outcome</th><th>Policy rate</th><th>Mapped parameter</th><th>Deterministic output</th><th>Trace ID</th></tr></thead><tbody>{result.traces.map((trace) => <tr key={trace.traceId}><td>{trace.sampleIndex + 1}</td><td>{trace.cpiOutcomePct.toFixed(4)}%</td><td>{(trace.policyRateScenario * 100).toFixed(4)}%</td><td>{trace.targetParameter}={trace.mappedParameterValue.toFixed(6)}{trace.mappingClamped ? " · clamped" : ""}</td><td>{output(trace.deterministicOutput)}</td><td><code>{trace.traceId}</code></td></tr>)}</tbody></table></div></details>
      <p className="parameter-uncertainty-caption">{result.classification} · {result.method} v{result.methodVersion}. Each compact-histogram CPI sample passes through the recorded adapter and one deterministic PDE solve. {result.disclaimer}</p>
    </> : <div className="parameter-uncertainty-empty"><b>No propagated output distribution yet</b><span>The existing Monte Carlo tab remains reserved for price, rate, variance or controlled-wealth paths.</span></div>}
  </section>;
}
