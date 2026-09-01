"use client";

import { useEffect, useMemo, useRef } from "react";
import type { MertonMonteCarloResult, SampleSummary, StatePathSummary } from "@/app/lib/monte-carlo";
import { Math as Formula } from "@/app/components/math";

interface MertonPolicyMonteCarloResultsProps {
  result: MertonMonteCarloResult;
  maturity: number;
  riskAversion: number;
  controlMin: number;
  controlMax: number;
}

const scientific = (value: number) => value.toExponential(6);
const compact = (value: number) => {
  if ((Math.abs(value) > 0 && Math.abs(value) < 0.001) || Math.abs(value) >= 10_000) return value.toExponential(2);
  return value.toFixed(Math.abs(value) < 10 ? 3 : 2);
};

function series(summary: StatePathSummary, level: number): number[] {
  return summary.quantiles[String(level)] ?? summary.meanPath;
}

function summaryQuantile(summary: SampleSummary, level: number): number {
  return summary.quantiles[String(level)] ?? summary.mean;
}

function useResponsiveCanvas(
  ref: React.RefObject<HTMLCanvasElement | null>,
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void,
) {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const render = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(context, bounds.width, bounds.height);
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [ref, draw]);
}

function HjbPathChart({
  summary,
  label,
  theoretical,
  bounds,
}: {
  summary: StatePathSummary;
  label: string;
  theoretical?: number[];
  bounds?: readonly [number, number];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(() => (context: CanvasRenderingContext2D, width: number, height: number) => {
    context.clearRect(0, 0, width, height);
    const pad = { left: 54, right: 18, top: 18, bottom: 32 };
    const chartWidth = Math.max(1, width - pad.left - pad.right);
    const chartHeight = Math.max(1, height - pad.top - pad.bottom);
    const q05 = series(summary, 0.05);
    const q25 = series(summary, 0.25);
    const q50 = series(summary, 0.5);
    const q75 = series(summary, 0.75);
    const q95 = series(summary, 0.95);
    const values = [
      ...summary.displayedPaths.flat(), ...q05, ...q95, ...summary.meanPath,
      ...(theoretical ?? []), ...(bounds ?? []),
    ].filter(Number.isFinite);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    const extra = Math.max((maximum - minimum) * 0.08, 1e-7);
    minimum -= extra;
    maximum += extra;
    const x = (index: number) => pad.left + index / Math.max(1, summary.time.length - 1) * chartWidth;
    const y = (value: number) => pad.top + (maximum - value) / Math.max(1e-14, maximum - minimum) * chartHeight;

    context.font = "9px Geist Mono, monospace";
    for (let index = 0; index <= 4; index += 1) {
      const value = maximum - (maximum - minimum) * index / 4;
      const gridY = pad.top + chartHeight * index / 4;
      context.strokeStyle = "rgba(118,139,163,.15)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(pad.left, gridY);
      context.lineTo(width - pad.right, gridY);
      context.stroke();
      context.fillStyle = "#64748a";
      context.textAlign = "right";
      context.fillText(compact(value), pad.left - 7, gridY + 3);
    }
    const band = (lower: number[], upper: number[], fill: string) => {
      context.beginPath();
      upper.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
      for (let index = lower.length - 1; index >= 0; index -= 1) context.lineTo(x(index), y(lower[index]));
      context.closePath();
      context.fillStyle = fill;
      context.fill();
    };
    band(q05, q95, "rgba(75,201,190,.10)");
    band(q25, q75, "rgba(75,201,190,.18)");
    summary.displayedPaths.forEach((path) => {
      context.beginPath();
      path.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
      context.strokeStyle = "rgba(113,149,172,.13)";
      context.lineWidth = 0.8;
      context.stroke();
    });
    const line = (valuesToDraw: number[], color: string, lineWidth: number, dash: number[] = []) => {
      context.beginPath();
      valuesToDraw.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.setLineDash(dash);
      context.stroke();
      context.setLineDash([]);
    };
    line(q50, "rgba(151,225,217,.72)", 1, [2, 4]);
    line(summary.meanPath, "#55d5c9", 2.2);
    if (theoretical) line(theoretical, "#f4b85b", 1.8, [6, 5]);
    bounds?.forEach((bound) => line(summary.time.map(() => bound), "#ef8f72", 1.2, [7, 4]));
    context.fillStyle = "#718197";
    context.textAlign = "left";
    context.fillText("0", pad.left, height - 10);
    context.textAlign = "right";
    context.fillText(`${summary.time.at(-1)?.toFixed(2) ?? "0"}y`, width - pad.right, height - 10);
  }, [summary, theoretical, bounds]);
  useResponsiveCanvas(ref, draw);
  return <canvas ref={ref} className="mc-chart-canvas" role="img" aria-label={`${label}: capped trajectories, sample mean, median, and 5 to 95 percent and 25 to 75 percent quantile bands${theoretical ? ", with unconstrained theoretical mean" : ""}${bounds ? ", with both control bounds" : ""}`} />;
}

function TerminalWealthChart({ summary }: { summary: SampleSummary }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(() => (context: CanvasRenderingContext2D, width: number, height: number) => {
    context.clearRect(0, 0, width, height);
    const left = 50;
    const right = width - 20;
    const centreY = height / 2;
    const minimum = summary.minimum;
    const maximum = summary.maximum;
    const span = Math.max(1e-12, maximum - minimum);
    const x = (value: number) => left + (value - minimum) / span * Math.max(1, right - left);
    const q05 = summaryQuantile(summary, 0.05);
    const q25 = summaryQuantile(summary, 0.25);
    const q50 = summaryQuantile(summary, 0.5);
    const q75 = summaryQuantile(summary, 0.75);
    const q95 = summaryQuantile(summary, 0.95);
    context.font = "9px Geist Mono, monospace";
    context.fillStyle = "#8d9caf";
    context.fillText("TERMINAL WEALTH QUANTILE DISTRIBUTION", left, 24);
    context.strokeStyle = "rgba(118,139,163,.28)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x(minimum), centreY);
    context.lineTo(x(maximum), centreY);
    context.stroke();
    context.fillStyle = "rgba(76,205,193,.22)";
    context.fillRect(x(q05), centreY - 14, Math.max(1, x(q95) - x(q05)), 28);
    context.fillStyle = "rgba(76,205,193,.45)";
    context.fillRect(x(q25), centreY - 20, Math.max(1, x(q75) - x(q25)), 40);
    const marker = (value: number, color: string, text: string, offset: number) => {
      context.strokeStyle = color;
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(x(value), centreY - 27);
      context.lineTo(x(value), centreY + 27);
      context.stroke();
      context.fillStyle = color;
      context.textAlign = "center";
      context.fillText(text, x(value), centreY + offset);
    };
    marker(q50, "#9de4dd", "MEDIAN", 44);
    marker(summary.mean, "#f4b85b", "MEAN", -36);
    context.fillStyle = "#718197";
    context.textAlign = "left";
    context.fillText(compact(minimum), left, height - 18);
    context.textAlign = "right";
    context.fillText(compact(maximum), right, height - 18);
  }, [summary]);
  useResponsiveCanvas(ref, draw);
  return <canvas ref={ref} className="mc-chart-canvas terminal" role="img" aria-label="Terminal wealth distribution showing the full range, 5 to 95 percent and 25 to 75 percent intervals, median, and mean" />;
}

export function MertonPolicyMonteCarloResults({
  result,
  maturity,
  riskAversion,
  controlMin,
  controlMax,
}: MertonPolicyMonteCarloResultsProps) {
  const estimate = result.expectedUtility;
  const diagnostics = result.policyDiagnostics;
  return (
    <section className="mc-results" aria-label="Merton HJB policy simulation results">
      <header className="mc-results-header">
        <div><span className="card-label"><i /> P-measure policy evaluation</span><h2>Merton controlled-wealth simulation</h2><p>The completed Howard policy is interpolated over wealth and time-to-maturity, then evaluated on independent forward wealth trajectories.</p></div>
        <span className="mc-scheme">feedback policy · Euler–Maruyama · seed {result.config.seed}</span>
      </header>

      <section className="mc-metrics" aria-label="Expected utility simulation statistics">
        <article><span>Expected terminal utility</span><strong>{scientific(estimate.mean)}</strong><small>sample <Formula math={String.raw`\mathbb{E}_P[U(W_T)]`} /></small></article>
        <article><span>Standard error</span><strong>{estimate.standardError.toExponential(3)}</strong><small>independent trajectories</small></article>
        <article><span>95% confidence interval</span><strong>{scientific(estimate.confidence95[0])}–{scientific(estimate.confidence95[1])}</strong><small>sampling uncertainty</small></article>
        <article><span>HJB value</span><strong>{scientific(result.hjbValue)}</strong><small><Formula math={String.raw`J(W_0,t=0)`} /></small></article>
      </section>

      <section className="mc-chart-grid">
        <article className="mc-card mc-wealth-card"><header><div><span>Controlled wealth trajectories</span><h3>Wealth, sample mean and quantile bands</h3></div><small>{result.wealth.displayedPaths.length} of {result.simulatedPaths.toLocaleString()} shown</small></header><div className="mc-path-canvas-wrap"><HjbPathChart summary={result.wealth} theoretical={result.theoreticalUnconstrainedWealthMeanPath} label="Controlled wealth trajectories" /></div><div className="mc-inline-legend" aria-label="Wealth trajectory legend"><span className="paths">Capped trajectories</span><span className="bands">5–95% · 25–75%</span><span className="mean">Sample mean</span>{result.theoreticalUnconstrainedWealthMeanPath && <span className="theory">Unconstrained <Formula math={String.raw`\mathbb{E}_P[W_t]`} /></span>}</div></article>
        <article className="mc-card mc-policy-card"><header><div><span>Interpolated dollar control</span><h3>Policy activity through calendar time</h3></div><small><Formula math={String.raw`\pi_{\min}\leq\pi\leq\pi_{\max}`} /></small></header><div className="mc-path-canvas-wrap"><HjbPathChart summary={result.policy} bounds={[controlMin, controlMax]} label="Interpolated dollar-control trajectories" /></div><div className="mc-inline-legend" aria-label="Policy trajectory legend"><span className="paths">Applied controls</span><span className="bands">5–95% · 25–75%</span><span className="mean">Sample mean</span><span className="barrier">Control bounds</span></div></article>
      </section>

      <section className="mc-chart-grid">
        <article className="mc-card mc-terminal-card"><header><div><span>Terminal wealth</span><h3><Formula math="W_T" /> distribution</h3></div><small>{result.terminalWealth.count.toLocaleString()} trajectories</small></header><div className="mc-variance-canvas-wrap"><TerminalWealthChart summary={result.terminalWealth} /></div></article>
        <article className="mc-card mc-policy-activity-card"><header><div><span>Policy constraints</span><h3>Applied-control diagnostics</h3></div><small>bounded feedback evaluation</small></header><div className="mc-diagnostics mc-policy-diagnostics" aria-label="Policy-bound activity diagnostics"><span><b>Applied range</b>{compact(diagnostics.minimumAppliedPolicy)} to {compact(diagnostics.maximumAppliedPolicy)}</span><span><b>Lower bound activity</b>{(diagnostics.lowerBoundActivityFraction * 100).toFixed(3)}%</span><span><b>Upper bound activity</b>{(diagnostics.upperBoundActivityFraction * 100).toFixed(3)}%</span><span><b>Positivity corrections</b>{diagnostics.nonPositiveWealthCorrections.toLocaleString()}</span></div></article>
      </section>

      <section className="mc-explanation" aria-label="Merton policy evaluation conventions">
        <div><span>Objective</span><strong><Formula math={String.raw`\mathbb{E}_P[U(W_T)]`} /></strong><p>CRRA terminal utility with <Formula math={String.raw`\gamma=${compact(riskAversion)}`} /> and no consumption.</p></div>
        <div><span>Time mapping</span><strong><Formula math={String.raw`\tau=T-t`} /></strong><p>Each calendar-time evaluation interpolates the captured HJB layers in time-to-maturity.</p></div>
        <div><span>Policy interpolation</span><strong>linear in <Formula math={String.raw`W\text{ and }\tau`} /></strong><p>Every applied dollar control is clamped to <Formula math={String.raw`[${compact(controlMin)},${compact(controlMax)}]`} />.</p></div>
        <div><span>Comparison convention</span><strong><Formula math={String.raw`\widehat{\mathbb{E}_P[U(W_T)]}-J(W_0,0)`} /></strong><p>The difference includes sampling, forward time-step, policy interpolation, HJB grid, and domain effects.</p></div>
      </section>

      <section className="mc-comparisons" aria-label="Expected utility comparisons">
        <header><span>Control-solution cross-check</span><h3>Forward policy evaluation against HJB values</h3></header>
        <div><span>Simulated <Formula math={String.raw`\mathbb{E}_P[U(W_T)]`} /></span><strong>{scientific(estimate.mean)}</strong><small>95% CI {scientific(estimate.confidence95[0])}–{scientific(estimate.confidence95[1])}</small></div>
        <div><span>Numerical HJB</span><strong>{scientific(result.hjbValue)}</strong><small>simulation − HJB {result.valueDifference >= 0 ? "+" : ""}{scientific(result.valueDifference)}</small></div>
        <div><span>Unconstrained closed form</span><strong>{scientific(result.analyticValue)}</strong><small>simulation − analytic {result.analyticDifference >= 0 ? "+" : ""}{scientific(result.analyticDifference)}</small></div>
      </section>

      <section className="mc-run-meta" aria-label="Merton policy simulation metadata"><span><b>Measure</b>P · real-world dynamics</span><span><b>Horizon</b>{compact(maturity)} years</span><span><b>Paths</b>{result.simulatedPaths.toLocaleString()}</span><span><b>Simulation steps</b>{result.config.timeSteps}</span><span><b>Seed</b>{result.config.seed}</span><span><b>Scheme</b>{result.config.scheme}</span><span><b>Below-domain observations</b>{diagnostics.belowDomainObservations}</span><span><b>Above-domain observations</b>{diagnostics.aboveDomainObservations}</span><span><b>Runtime</b>{Math.round(result.runtimeMs)} ms</span></section>
    </section>
  );
}
