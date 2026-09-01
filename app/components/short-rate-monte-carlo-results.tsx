"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ShortRateMonteCarloResult, StatePathSummary } from "@/app/lib/monte-carlo";
import { Math as Formula } from "@/app/components/math";

interface ShortRateMonteCarloResultsProps {
  result: ShortRateMonteCarloResult;
  contract: "zero-coupon-bond" | "bond-option";
  maturity: number;
  bondMaturity?: number;
  strike?: number;
  pdeValue: number;
  benchmarkValue: number;
  benchmarkLabel: string;
}

const number = (value: number) => new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 6,
  maximumFractionDigits: 6,
}).format(value);

const compact = (value: number) => {
  if ((Math.abs(value) > 0 && Math.abs(value) < 0.001) || Math.abs(value) >= 10_000) return value.toExponential(2);
  return value.toFixed(Math.abs(value) < 1 ? 4 : 2);
};

function quantile(summary: StatePathSummary, level: number) {
  return summary.quantiles[String(level)] ?? summary.meanPath;
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

function RatePathChart({
  summary,
  theoretical,
  label,
}: {
  summary: StatePathSummary;
  theoretical: number[];
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(() => (context: CanvasRenderingContext2D, width: number, height: number) => {
    context.clearRect(0, 0, width, height);
    const pad = { left: 54, right: 18, top: 18, bottom: 32 };
    const chartWidth = Math.max(1, width - pad.left - pad.right);
    const chartHeight = Math.max(1, height - pad.top - pad.bottom);
    const q05 = quantile(summary, 0.05);
    const q25 = quantile(summary, 0.25);
    const q50 = quantile(summary, 0.5);
    const q75 = quantile(summary, 0.75);
    const q95 = quantile(summary, 0.95);
    const values = [...summary.displayedPaths.flat(), ...q05, ...q95, ...summary.meanPath, ...theoretical].filter(Number.isFinite);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    const extra = Math.max((maximum - minimum) * 0.08, 1e-5);
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
    if (minimum < 0 && maximum > 0) {
      context.strokeStyle = "rgba(239,143,114,.35)";
      context.setLineDash([3, 5]);
      context.beginPath();
      context.moveTo(pad.left, y(0));
      context.lineTo(width - pad.right, y(0));
      context.stroke();
      context.setLineDash([]);
    }
    const band = (lower: number[], upper: number[], fill: string) => {
      context.beginPath();
      upper.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
      for (let index = lower.length - 1; index >= 0; index -= 1) context.lineTo(x(index), y(lower[index]));
      context.closePath();
      context.fillStyle = fill;
      context.fill();
    };
    band(q05, q95, "rgba(75, 201, 190, .10)");
    band(q25, q75, "rgba(75, 201, 190, .18)");
    summary.displayedPaths.forEach((path) => {
      context.beginPath();
      path.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
      context.strokeStyle = "rgba(113, 149, 172, .12)";
      context.lineWidth = 0.8;
      context.stroke();
    });
    const line = (valuesToDraw: number[], color: string, widthToDraw: number, dash: number[] = []) => {
      context.beginPath();
      valuesToDraw.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
      context.strokeStyle = color;
      context.lineWidth = widthToDraw;
      context.setLineDash(dash);
      context.stroke();
      context.setLineDash([]);
    };
    line(q50, "rgba(151,225,217,.72)", 1, [2, 4]);
    line(summary.meanPath, "#55d5c9", 2.2);
    line(theoretical, "#f4b85b", 1.8, [6, 5]);
    context.fillStyle = "#718197";
    context.textAlign = "left";
    context.fillText("0", pad.left, height - 10);
    context.textAlign = "right";
    context.fillText(`${summary.time.at(-1)?.toFixed(2) ?? "0"}y`, width - pad.right, height - 10);
  }, [summary, theoretical]);
  useResponsiveCanvas(ref, draw);

  return <canvas ref={ref} className="mc-chart-canvas" role="img" aria-label={`${label}: capped paths, sample mean, theoretical mean, median, and 5 to 95 percent and 25 to 75 percent quantile bands`} />;
}

export function ShortRateMonteCarloResults({
  result,
  contract,
  maturity,
  bondMaturity,
  strike,
  pdeValue,
  benchmarkValue,
  benchmarkLabel,
}: ShortRateMonteCarloResultsProps) {
  const value = result.discountedValue;
  const isBondOption = contract === "bond-option";
  const maximumCurveZ = Math.max(0, ...(result.curveReproduction ?? []).map((point) => Math.abs(point.standardizedError)));
  const deltaFromPde = value.mean - pdeValue;
  const deltaFromBenchmark = value.mean - benchmarkValue;

  return (
    <section className="mc-results" aria-label={`${result.model} short-rate Monte Carlo results`}>
      <header className="mc-results-header">
        <div>
          <span className="card-label"><i /> Q-measure rate simulation</span>
          <h2>{result.model} exact-Gaussian short-rate Monte Carlo</h2>
          <p>{result.shortRate.displayedPaths.length} of {result.simulatedPaths.toLocaleString()} paths displayed. Rates and interval discount integrals use their exact joint Gaussian transition.</p>
        </div>
        <span className="mc-scheme">exact rate + integral · seed {result.config.seed}</span>
      </header>

      <section className="mc-metrics" aria-label="Short-rate Monte Carlo price statistics">
        <article><span>Monte Carlo value</span><strong>{number(value.mean)}</strong><small>pathwise discounted Q-payoff</small></article>
        <article><span>Standard error</span><strong>{value.standardError.toExponential(3)}</strong><small>independent paths</small></article>
        <article><span>95% confidence interval</span><strong>{number(value.confidence95[0])}–{number(value.confidence95[1])}</strong><small>normal approximation</small></article>
        <article><span><Formula math={String.raw`\mathbb{E}[D(0,T)]`} /></span><strong>{number(result.discountFactor.mean)}</strong><small>sample discount-factor mean</small></article>
      </section>

      <section className="mc-chart-grid">
        <article className="mc-card mc-rate-card">
          <header><div><span>{result.model} short-rate paths</span><h3>Rates, sample mean and quantile bands</h3></div><small>negative rates retained</small></header>
          <div className="mc-path-canvas-wrap"><RatePathChart summary={result.shortRate} theoretical={result.theoreticalShortRateMeanPath} label={`${result.model} short-rate paths`} /></div>
          <div className="mc-inline-legend" aria-label="Short-rate path chart legend"><span className="paths">Capped paths</span><span className="bands">5–95% · 25–75%</span><span className="mean">Sample mean</span><span className="theory">Theoretical <Formula math={String.raw`\mathbb{E}_Q[r_t]`} /></span></div>
        </article>
        <article className="mc-card mc-discount-card">
          <header><div><span>Pathwise discount factors</span><h3><Formula math={String.raw`D(0,t)=\exp\!\left(-\int_0^t r_s\,\mathrm{d}s\right)`} display /></h3></div><small>joint Gaussian integral</small></header>
          <div className="mc-path-canvas-wrap"><RatePathChart summary={result.discountFactorPath} theoretical={result.theoreticalDiscountFactorMeanPath} label="Pathwise discount factors" /></div>
          <div className="mc-inline-legend" aria-label="Discount-factor chart legend"><span className="paths">Capped factors</span><span className="bands">5–95% · 25–75%</span><span className="mean">Sample mean</span><span className="theory">Theoretical <Formula math={String.raw`\mathbb{E}_Q[D(0,t)]`} /></span></div>
        </article>
      </section>

      <section className="mc-explanation" aria-label="Short-rate Monte Carlo quantity definitions">
        <div><span>Terminal short rate</span><strong><Formula math={String.raw`\overline{r_T}=${compact(result.terminalShortRate.mean)}`} /></strong><p>The finite-sample rate mean; the rate distribution is Gaussian and may be negative.</p></div>
        <div><span>Integrated short rate</span><strong><Formula math={String.raw`\overline{\int_0^T r_t\,\mathrm{d}t}=${compact(result.integratedShortRate.mean)}`} /></strong><p>Sampled jointly with each rate transition, not reconstructed by a time-grid quadrature.</p></div>
        <div><span>Terminal payoff</span><strong><Formula math={String.raw`\overline{\operatorname{payoff}}=${number(result.terminalPayoff.mean)}`} /></strong><p>{isBondOption ? "The positive part of the analytic T-to-S discount bond less strike." : "Unit notional paid at bond maturity."}</p></div>
        <div><span>Discounted path value</span><strong><Formula math={String.raw`\overline{D\times\operatorname{payoff}}=${number(result.discountedPathValue.mean)}`} /></strong><p>This pathwise product—not payoff at a mean rate—is the pricing estimator.</p></div>
      </section>

      {result.model === "Hull–White" && (
        <article className="mc-card mc-curve-card">
          <header><div><span>Frozen input curve</span><h3>Hull–White curve-reproduction diagnostics</h3></div><small>{String(result.diagnostics.curveId)}</small></header>
          <div className="mc-diagnostics" aria-label="Hull–White Monte Carlo curve diagnostics">
            <span><b>Drift convention</b><Formula math={String.raw`\mathrm{d}r=[\vartheta(t)-ar]\,\mathrm{d}t+\sigma_r\,\mathrm{d}W_t^Q`} /></span>
            <span><b>Matched pillars</b>{result.curveReproduction?.length ?? 0}</span>
            <span><b>Maximum |z|</b>{compact(maximumCurveZ)}</span>
            <span><b>Curve source</b>exact run snapshot</span>
          </div>
        </article>
      )}

      <section className="mc-comparisons" aria-label="Short-rate pricing comparisons">
        <header><span>Pricing cross-check</span><h3>Monte Carlo against deterministic references</h3></header>
        <div><span>Monte Carlo</span><strong>{number(value.mean)}</strong><small>95% CI {number(value.confidence95[0])}–{number(value.confidence95[1])}</small></div>
        <div><span>PDE</span><strong>{number(pdeValue)}</strong><small>MC − PDE {deltaFromPde >= 0 ? "+" : ""}{number(deltaFromPde)}</small></div>
        <div><span>Affine analytic</span><strong>{number(benchmarkValue)}</strong><small>{benchmarkLabel} · MC − reference {deltaFromBenchmark >= 0 ? "+" : ""}{number(deltaFromBenchmark)}</small></div>
      </section>

      <section className="mc-run-meta" aria-label="Short-rate Monte Carlo run metadata">
        <span><b>Measure</b>Q · risk-neutral pricing</span><span><b>Contract</b>{isBondOption ? "bond option" : "zero-coupon bond"}</span>
        <span><b>Claim maturity</b>{compact(maturity)} years</span>{isBondOption && <span><b>Bond maturity</b>{compact(bondMaturity ?? 0)} years</span>}{isBondOption && <span><b>Strike</b>{compact(strike ?? 0)}</span>}
        <span><b>Paths</b>{result.simulatedPaths.toLocaleString()}</span><span><b>Simulation steps</b>{result.config.timeSteps}</span><span><b>Seed</b>{result.config.seed}</span><span><b>Scheme</b>{result.config.scheme}</span><span><b>Runtime</b>{Math.round(result.runtimeMs)} ms</span>
      </section>
    </section>
  );
}
