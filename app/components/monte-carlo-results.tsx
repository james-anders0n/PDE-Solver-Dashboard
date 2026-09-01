"use client";

import { useEffect, useMemo, useRef } from "react";
import type {
  EquityMonteCarloResult,
  SampleSummary,
  StatePathSummary,
} from "@/app/lib/monte-carlo";
import { Math as Formula } from "@/app/components/math";

type EquitySide = "Call" | "Put";
type EquityContract = "european" | "digital" | "barrier";

interface MonteCarloResultsProps {
  result: EquityMonteCarloResult;
  spot: number;
  strike: number;
  maturity: number;
  rate: number;
  dividend: number;
  side: EquitySide;
  contract: EquityContract;
  barrier?: number;
  barrierDirection?: "up-and-out" | "down-and-out";
  pdeValue: number;
  benchmarkValue: number;
  benchmarkLabel: string;
}

const money = (value: number) => new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
}).format(value);

const compact = (value: number) => {
  if (Math.abs(value) >= 10_000 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)) return value.toExponential(2);
  return value.toFixed(Math.abs(value) < 1 ? 4 : 2);
};

function useResponsiveCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
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
  }, [canvasRef, draw]);
}

function quantileSeries(summary: StatePathSummary, level: number): number[] {
  return summary.quantiles[String(level)] ?? summary.meanPath;
}

function quantileValue(summary: SampleSummary, level: number): number {
  return summary.quantiles[String(level)] ?? summary.mean;
}

function PathBandChart({
  summary,
  label,
  theoretical,
  strike,
  barrier,
}: {
  summary: StatePathSummary;
  label: string;
  theoretical?: number[];
  strike?: number;
  barrier?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(() => (context: CanvasRenderingContext2D, width: number, height: number) => {
    context.clearRect(0, 0, width, height);
    const pad = { left: 50, right: 18, top: 18, bottom: 32 };
    const chartWidth = Math.max(1, width - pad.left - pad.right);
    const chartHeight = Math.max(1, height - pad.top - pad.bottom);
    const q05 = quantileSeries(summary, 0.05);
    const q25 = quantileSeries(summary, 0.25);
    const q50 = quantileSeries(summary, 0.5);
    const q75 = quantileSeries(summary, 0.75);
    const q95 = quantileSeries(summary, 0.95);
    const values = [
      ...summary.displayedPaths.flat(),
      ...q05,
      ...q95,
      ...summary.meanPath,
      ...(theoretical ?? []),
      ...(strike == null ? [] : [strike]),
      ...(barrier == null ? [] : [barrier]),
    ].filter(Number.isFinite);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    const padding = Math.max((maximum - minimum) * 0.08, Math.abs(maximum) * 0.01, 1e-5);
    minimum -= padding;
    maximum += padding;
    const x = (index: number) => pad.left + (index / Math.max(1, summary.time.length - 1)) * chartWidth;
    const y = (value: number) => pad.top + ((maximum - value) / Math.max(1e-14, maximum - minimum)) * chartHeight;

    context.font = "9px Geist Mono, monospace";
    context.lineWidth = 1;
    for (let gridIndex = 0; gridIndex <= 4; gridIndex += 1) {
      const value = maximum - (maximum - minimum) * gridIndex / 4;
      const gridY = pad.top + chartHeight * gridIndex / 4;
      context.strokeStyle = "rgba(118,139,163,.15)";
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
    band(q05, q95, "rgba(75, 201, 190, .10)");
    band(q25, q75, "rgba(75, 201, 190, .18)");

    summary.displayedPaths.forEach((path) => {
      context.beginPath();
      path.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
      context.strokeStyle = "rgba(113, 149, 172, .12)";
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
    line(q50, "rgba(151, 225, 217, .72)", 1, [2, 4]);
    line(summary.meanPath, "#55d5c9", 2.2);
    if (theoretical) line(theoretical, "#f4b85b", 1.8, [6, 5]);
    if (strike != null) line(summary.time.map(() => strike), "#c895dc", 1.2, [3, 5]);
    if (barrier != null) line(summary.time.map(() => barrier), "#ef8f72", 1.4, [8, 4]);

    context.fillStyle = "#718197";
    context.textAlign = "left";
    context.fillText("0", pad.left, height - 10);
    context.textAlign = "right";
    context.fillText(`${summary.time.at(-1)?.toFixed(2) ?? "0"}y`, width - pad.right, height - 10);
  }, [summary, theoretical, strike, barrier]);
  useResponsiveCanvas(ref, draw);

  return (
    <canvas
      ref={ref}
      className="mc-chart-canvas"
      role="img"
      aria-label={`${label}: capped sample paths, sample mean, 5 to 95 percent and 25 to 75 percent quantile bands${theoretical ? ", theoretical expected stock curve" : ""}${strike == null ? "" : ", strike"}${barrier == null ? "" : ", and continuous knock-out barrier"}`}
    />
  );
}

function TerminalDistributionChart({
  terminal,
  payoffSummary,
  strike,
  theoreticalMean,
  side,
  contract,
}: {
  terminal: SampleSummary;
  payoffSummary: SampleSummary;
  strike: number;
  theoreticalMean: number;
  side: EquitySide;
  contract: EquityContract;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(() => (context: CanvasRenderingContext2D, width: number, height: number) => {
    context.clearRect(0, 0, width, height);
    const left = 48;
    const right = width - 18;
    const chartWidth = Math.max(1, right - left);
    const q05 = quantileValue(terminal, 0.05);
    const q25 = quantileValue(terminal, 0.25);
    const q50 = quantileValue(terminal, 0.5);
    const q75 = quantileValue(terminal, 0.75);
    const q95 = quantileValue(terminal, 0.95);
    const minimum = Math.min(terminal.minimum, strike, theoreticalMean);
    const maximum = Math.max(terminal.maximum, strike, theoreticalMean);
    const span = Math.max(1e-12, maximum - minimum);
    const x = (value: number) => left + (value - minimum) / span * chartWidth;
    const distributionY = 82;

    context.font = "9px Geist Mono, monospace";
    context.fillStyle = "#8d9caf";
    context.textAlign = "left";
    context.fillText("TERMINAL STOCK QUANTILE DISTRIBUTION", left, 18);
    context.strokeStyle = "rgba(118,139,163,.28)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x(terminal.minimum), distributionY);
    context.lineTo(x(terminal.maximum), distributionY);
    context.stroke();
    context.fillStyle = "rgba(76, 205, 193, .22)";
    context.fillRect(x(q05), distributionY - 13, Math.max(1, x(q95) - x(q05)), 26);
    context.fillStyle = "rgba(76, 205, 193, .43)";
    context.fillRect(x(q25), distributionY - 18, Math.max(1, x(q75) - x(q25)), 36);
    context.strokeStyle = "#9de4dd";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x(q50), distributionY - 22);
    context.lineTo(x(q50), distributionY + 22);
    context.stroke();

    const marker = (value: number, color: string, text: string, yOffset: number) => {
      context.strokeStyle = color;
      context.lineWidth = 1.2;
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(x(value), 34);
      context.lineTo(x(value), height - 28);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = color;
      context.textAlign = "center";
      context.fillText(text, x(value), yOffset);
    };
    marker(strike, "#c895dc", "K", 32);
    marker(theoreticalMean, "#f4b85b", "THEORY E[Sₜ]", 132);
    marker(terminal.mean, "#55d5c9", "SAMPLE MEAN", 144);

    const payoffTop = 176;
    const payoffBottom = height - 28;
    const payoffMaximum = Math.max(1, payoffSummary.maximum, side === "Call" ? maximum - strike : strike - minimum);
    const payoffY = (value: number) => payoffBottom - Math.max(0, value) / payoffMaximum * Math.max(1, payoffBottom - payoffTop);
    context.fillStyle = "#8d9caf";
    context.textAlign = "left";
    context.fillText(contract === "barrier" ? "SURVIVAL-CONDITIONAL PAYOFF" : "PAYOFF FUNCTION AND EXPECTED PAYOFF", left, payoffTop - 12);
    context.strokeStyle = "rgba(118,139,163,.18)";
    context.beginPath();
    context.moveTo(left, payoffBottom);
    context.lineTo(right, payoffBottom);
    context.stroke();
    context.strokeStyle = "#62cbc3";
    context.lineWidth = 2;
    context.beginPath();
    const steps = contract === "digital" ? 160 : 80;
    for (let index = 0; index <= steps; index += 1) {
      const stock = minimum + span * index / steps;
      const payoff = contract === "digital"
        ? Number(side === "Call" ? stock > strike : stock < strike)
        : side === "Call" ? Math.max(stock - strike, 0) : Math.max(strike - stock, 0);
      if (index === 0) context.moveTo(x(stock), payoffY(payoff));
      else context.lineTo(x(stock), payoffY(payoff));
    }
    context.stroke();
    context.strokeStyle = "#f4b85b";
    context.setLineDash([6, 5]);
    context.beginPath();
    context.moveTo(left, payoffY(payoffSummary.mean));
    context.lineTo(right, payoffY(payoffSummary.mean));
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#f4b85b";
    context.textAlign = "right";
    context.fillText(`E[payoff] ${compact(payoffSummary.mean)}`, right, payoffY(payoffSummary.mean) - 5);
  }, [terminal, payoffSummary, strike, theoreticalMean, side, contract]);
  useResponsiveCanvas(ref, draw);

  return (
    <canvas
      ref={ref}
      className="mc-chart-canvas terminal"
      role="img"
      aria-label={`Terminal stock quantile distribution and ${contract === "barrier" ? "survival-conditional intrinsic payoff view" : "payoff function"}, marking strike, theoretical expected stock, finite-sample stock mean, and expected payoff`}
    />
  );
}

export function MonteCarloResults({
  result,
  spot,
  strike,
  maturity,
  rate,
  dividend,
  side,
  contract,
  barrier,
  barrierDirection,
  pdeValue,
  benchmarkValue,
  benchmarkLabel,
}: MonteCarloResultsProps) {
  const theoreticalStock = result.stock.time.map((time) => spot * Math.exp((rate - dividend) * time));
  const theoreticalTerminal = theoreticalStock.at(-1) ?? spot;
  const payoffAtExpectedStock = contract === "digital"
    ? Number(side === "Call" ? theoreticalTerminal > strike : theoreticalTerminal < strike)
    : side === "Call" ? Math.max(theoreticalTerminal - strike, 0) : Math.max(strike - theoreticalTerminal, 0);
  const value = result.payoff.discountedValue;
  const isBarrier = result.model === "Black–Scholes" && contract === "barrier";
  const pathLabel = result.model === "Heston" ? "Heston stock paths" : isBarrier ? "GBM barrier paths" : "GBM paths";
  const benchmarkKind = result.model === "Heston" ? "Semi-analytic" : "Analytic";
  const deltaFromPde = value.mean - pdeValue;
  const deltaFromBenchmark = value.mean - benchmarkValue;
  const monitoringMethod = String(result.diagnostics.monitoring ?? "terminal-only");
  const bridgePayoffMethod = String(result.diagnostics.payoffMethod ?? "terminal payoff");
  const meanSurvivalWeight = Number(result.diagnostics.meanSurvivalWeight ?? 1);
  const endpointOnlyValue = Number(result.diagnostics.discreteMonitoringValue ?? value.mean);
  const monitoringBiasEstimate = Number(result.diagnostics.monitoringBiasEstimate ?? 0);

  return (
    <section className="mc-results" aria-label={`${result.model} Monte Carlo results`}>
      <header className="mc-results-header">
        <div>
          <span className="card-label"><i /> Q-measure simulation</span>
          <h2>{result.model === "Heston" ? "Heston Monte Carlo paths" : isBarrier ? "Black–Scholes continuous barrier GBM paths" : "Black–Scholes GBM Monte Carlo paths"}</h2>
          <p>{result.stock.displayedPaths.length} of {result.simulatedPaths.toLocaleString()} simulated paths displayed. Every simulated path contributes to the statistics.{isBarrier ? " Brownian-bridge conditional survival weights correct monitoring between exact GBM time-step endpoints." : ""}</p>
        </div>
        <span className="mc-scheme">{result.config.scheme} · {result.config.varianceReduction ?? "no variance reduction"} · seed {result.config.seed}</span>
      </header>

      <section className="mc-metrics" aria-label="Monte Carlo price statistics">
        <article><span>Monte Carlo value</span><strong>{money(value.mean)}</strong><small>discounted Q-expectation</small></article>
        <article><span>Standard error</span><strong>{value.standardError.toExponential(3)}</strong><small>sampling uncertainty</small></article>
        <article><span>95% confidence interval</span><strong>{money(value.confidence95[0])}–{money(value.confidence95[1])}</strong><small>normal approximation</small></article>
        <article><span>Expected payoff</span><strong>{money(result.payoff.undiscountedPayoff.mean)}</strong><small>{isBarrier ? "survival-weighted, undiscounted" : <>undiscounted <Formula math={String.raw`\mathbb{E}[\operatorname{payoff}(S_T)]`} /></>}</small></article>
      </section>

      <section className="mc-chart-grid">
        <article className="mc-card mc-path-card">
          <header><div><span>{pathLabel}</span><h3>Paths, sample mean and quantile bands</h3></div><small>{result.stock.displayedPaths.length} of {result.simulatedPaths.toLocaleString()} shown</small></header>
          <div className="mc-path-canvas-wrap"><PathBandChart summary={result.stock} label={pathLabel} theoretical={theoreticalStock} strike={strike} barrier={isBarrier ? barrier : undefined} /></div>
          <div className="mc-inline-legend" aria-label="Stock path chart legend">
            <span className="paths">Capped paths</span><span className="bands">5–95% · 25–75%</span><span className="mean">Sample mean</span><span className="theory">Theoretical <Formula math={String.raw`\mathbb{E}_Q[S_t]`} /></span><span className="strike">Strike <Formula math="K" /></span>{isBarrier && <span className="barrier">Barrier <Formula math="H" /></span>}
          </div>
        </article>

        <article className="mc-card mc-terminal-card">
          <header><div><span>Terminal distribution</span><h3><Formula math="S_T" /> distribution and payoff view</h3></div><small>{result.payoff.terminalStock.count.toLocaleString()} samples</small></header>
          <div className="mc-terminal-canvas-wrap"><TerminalDistributionChart terminal={result.payoff.terminalStock} payoffSummary={result.payoff.undiscountedPayoff} strike={strike} theoreticalMean={theoreticalTerminal} side={side} contract={contract} /></div>
        </article>
      </section>

      {result.model === "Heston" && (
        <article className="mc-card mc-variance-card">
          <header><div><span>Heston variance paths</span><h3>Variance sample mean and quantile bands</h3></div><small>{result.varianceDiagnostics.treatment}</small></header>
          <div className="mc-variance-canvas-wrap"><PathBandChart summary={result.variance} label="Heston variance paths" /></div>
          <div className="mc-diagnostics" aria-label="Heston variance diagnostics">
            <span><b>Non-negative treatment</b>{result.varianceDiagnostics.treatment}</span>
            <span><b>Corrected steps</b>{(result.varianceDiagnostics.correctionFraction * 100).toFixed(3)}%</span>
            <span><b>Corrected paths</b>{(result.varianceDiagnostics.correctedPathFraction * 100).toFixed(2)}%</span>
            <span><b>Returned minimum v</b>{compact(result.varianceDiagnostics.minimumReturnedVariance)}</span>
          </div>
        </article>
      )}

      {isBarrier && (
        <article className="mc-card mc-barrier-card">
          <header><div><span>Contract-specific method</span><h3>Continuous knock-out monitoring</h3></div><small>{barrierDirection === "down-and-out" ? "Down & out" : "Up & out"} · <Formula math={`H=${money(barrier ?? Number(result.diagnostics.barrier))}`} /></small></header>
          <div className="mc-diagnostics" aria-label="Barrier monitoring diagnostics">
            <span><b>Monitoring</b>{monitoringMethod} · Brownian bridge</span>
            <span><b>Mean survival weight</b>{(meanSurvivalWeight * 100).toFixed(3)}%</span>
            <span><b>Endpoint-only value</b>{money(endpointOnlyValue)}</span>
            <span><b>Monitoring bias estimate</b>{monitoringBiasEstimate >= 0 ? "+" : ""}{money(monitoringBiasEstimate)}</span>
          </div>
        </article>
      )}

      <section className="mc-explanation" aria-label="Monte Carlo expectation definitions">
        <div>
          <span>Theoretical expectation</span>
          <strong><Formula math={String.raw`\mathbb{E}_Q[S_T]=${money(theoreticalTerminal)}`} /></strong>
          <p>Model-implied from <Formula math={String.raw`S_0,r,q\text{ and }T`} />. The dashed curve is not a simulated path.</p>
        </div>
        <div>
          <span>Finite-sample mean</span>
          <strong><Formula math={String.raw`\overline{S_T}=${money(result.payoff.terminalStock.mean)}`} /></strong>
          <p>The average terminal stock across this seeded run; sampling and Heston time-discretisation can move it from theory.</p>
        </div>
        <div>
          <span>Expected payoff</span>
          <strong><Formula math={String.raw`\mathbb{E}[\operatorname{payoff}(S_T)]=${money(result.payoff.undiscountedPayoff.mean)}`} /></strong>
          <p>{isBarrier ? "The terminal intrinsic payoff multiplied by the Brownian-bridge conditional survival weight, averaged across paths." : "The pathwise payoff average used for the Monte Carlo option value."}</p>
        </div>
        <div>
          <span>Payoff at expected stock</span>
          <strong><Formula math={String.raw`\operatorname{payoff}\!\left(\mathbb{E}[S_T]\right)=${money(payoffAtExpectedStock)}`} /></strong>
          <p>{isBarrier ? "A conditional terminal intrinsic reference only: it ignores path survival and is not a barrier-value estimator." : "A visual reference only. For nonlinear payoffs it is generally not equal to E[payoff(Sₜ)]."}</p>
        </div>
      </section>

      <section className="mc-comparisons" aria-label="Monte Carlo pricing comparisons">
        <header><span>Pricing cross-check</span><h3>Monte Carlo against deterministic references</h3></header>
        <div><span>Monte Carlo</span><strong>{money(value.mean)}</strong><small>95% CI {money(value.confidence95[0])}–{money(value.confidence95[1])}</small></div>
        <div><span>PDE</span><strong>{money(pdeValue)}</strong><small>MC − PDE {deltaFromPde >= 0 ? "+" : ""}{money(deltaFromPde)}</small></div>
        <div><span>{benchmarkKind}</span><strong>{money(benchmarkValue)}</strong><small>{benchmarkLabel} · MC − reference {deltaFromBenchmark >= 0 ? "+" : ""}{money(deltaFromBenchmark)}</small></div>
      </section>

      <section className="mc-run-meta" aria-label="Monte Carlo run metadata">
        <span><b>Measure</b>Q · risk-neutral pricing</span>
        <span><b>Maturity</b>{compact(maturity)} years</span>
        <span><b>Paths</b>{result.simulatedPaths.toLocaleString()}</span>
        <span><b>Simulation steps</b>{result.config.timeSteps}</span>
        <span><b>Seed</b>{result.config.seed}</span>
        <span><b>Scheme</b>{result.config.scheme}</span>
        <span><b>Variance reduction</b>{result.config.varianceReduction ?? "none"}</span>
        {isBarrier && <span><b>Contract method</b>{bridgePayoffMethod}</span>}
        {isBarrier && <span><b>Monitoring</b>{monitoringMethod}</span>}
        <span><b>Runtime</b>{Math.round(result.runtimeMs)} ms</span>
      </section>
    </section>
  );
}
