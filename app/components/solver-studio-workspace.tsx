"use client";

import { Math as Formula, symbolTex } from "@/app/components/math";
import { ControlHelpLabel } from "@/app/components/control-help-label";
import { TechnicalTerminologyGuide } from "@/app/components/technical-terminology-guide";
import type { CaseStatusSystem } from "@/app/lib/case-state";
import { getSolverParameterHelp, SOLVER_CONTROL_HELP } from "@/app/lib/control-help";
import type { GridKind } from "@/app/lib/pde-engine";
import type { ModelKey, ParameterSpec } from "@/app/lib/pde-spec";
import type { OptionQuoteEvidence } from "@/app/lib/option-valuation-assessment";
import { decimalToPercentInput, percentInputToDecimal } from "@/app/lib/presentation";

interface SolverStudioWorkspaceProps {
  model: ModelKey;
  contract: string;
  contractLabel: string;
  equation: string;
  measure: string;
  parameterSpecs: readonly ParameterSpec[];
  parameters: Record<string, string>;
  barrierType: string;
  scheme: string;
  schemeOptions: ReadonlyArray<{ id: string; label: string }>;
  gridKind: GridKind;
  spaceSteps: string;
  varianceSteps: string;
  timeSteps: string;
  isHeston: boolean;
  isShortRate: boolean;
  isHjb: boolean;
  monteCarloEligible: boolean;
  monteCarloEnabled: boolean;
  monteCarloPaths: string;
  monteCarloTimeSteps: string;
  monteCarloSeed: string;
  validationIssues: readonly string[];
  warnings: readonly string[];
  solverError: string | null;
  solverAvailable: boolean;
  running: boolean;
  progress: number;
  workerStage: string;
  lastExecution: "fixture" | "worker" | "cache";
  status: CaseStatusSystem;
  tolerance: { pointwiseAbsolute: number; maxNorm?: number; observedOrder?: number; note: string };
  quotedContract: OptionQuoteEvidence | null;
  quotedContractIsExact: boolean;
  onChangeBarrierType(value: string): void;
  onChangeParameter(id: string, value: string): void;
  onChangeScheme(value: string): void;
  onChangeGridKind(value: GridKind): void;
  onChangeSpaceSteps(value: string): void;
  onChangeVarianceSteps(value: string): void;
  onChangeTimeSteps(value: string): void;
  onToggleMonteCarlo(enabled: boolean): void;
  onChangeMonteCarloPaths(value: string): void;
  onChangeMonteCarloTimeSteps(value: string): void;
  onChangeMonteCarloSeed(value: string): void;
  onUseQuotedContract(): void;
  onReturnToCondition(): void;
  onRun(): void;
  onCancel(): void;
}

const fieldIssues = (id: string, symbol: string, issues: readonly string[]) => issues.filter((issue) => {
  if (issue.startsWith(`${symbol} `) || issue.includes(`${symbol}=`)) return true;
  if (["maturity", "bondMaturity"].includes(id) && issue.startsWith("Bond maturity")) return true;
  if (["spot", "barrier"].includes(id) && (issue.toLowerCase().includes("barrier") || issue.includes("Barrier H"))) return true;
  if (["controlMin", "controlMax"].includes(id) && (issue.includes("πmin") || issue.includes("πmax") || issue.includes("control interval"))) return true;
  return id === "riskAversion" && issue.includes("γ=1");
});

const numericalIssues = (kind: "space" | "variance" | "time", issues: readonly string[]) => issues.filter((issue) => {
  if (kind === "space") return /space steps|spot steps|wealth steps|rate steps/i.test(issue);
  if (kind === "variance") return /variance steps/i.test(issue);
  return /^Time steps/i.test(issue);
});

const monteCarloIssues = (kind: "paths" | "steps" | "seed", issues: readonly string[]) => issues.filter((issue) => {
  if (kind === "paths") return /Monte Carlo path|path count/i.test(issue);
  if (kind === "steps") return /Monte Carlo simulation steps/i.test(issue);
  return /Monte Carlo seed/i.test(issue);
});

function InlineIssues({ issues, id }: { issues: readonly string[]; id: string }) {
  if (!issues.length) return null;
  return <span className="solve-field-errors" id={id} role="alert">{issues.map((issue) => <small key={issue}>{issue}</small>)}</span>;
}

export function SolverStudioWorkspace(props: SolverStudioWorkspaceProps) {
  const {
    model, contract, contractLabel, equation, measure, parameterSpecs, parameters,
    barrierType, scheme, schemeOptions, gridKind, spaceSteps, varianceSteps,
    timeSteps, isHeston, isShortRate, isHjb, monteCarloEligible, monteCarloEnabled,
    monteCarloPaths, monteCarloTimeSteps, monteCarloSeed, validationIssues, warnings,
    solverError, solverAvailable, running, progress, workerStage, lastExecution, status, tolerance,
  } = props;
  const conditioningRequiresApproval = status.stages.condition !== "complete";
  const blocked = validationIssues.length > 0 || !solverAvailable || conditioningRequiresApproval;
  const readinessLabel = status.labels.solverState;
  const readinessClass = readinessLabel.toLowerCase().replaceAll(" ", "-");
  const stateStepsLabel = isHeston ? "Spot steps (Mₛ)" : isHjb ? "Wealth steps (M)" : isShortRate ? "Rate steps (M)" : "State steps (M)";
  const stateStepsHelp = isHeston ? SOLVER_CONTROL_HELP.spotSteps : isHjb ? SOLVER_CONTROL_HELP.wealthSteps : SOLVER_CONTROL_HELP.stateSteps;
  const spatialGridLabel = isHeston ? "Tensor S–v fitted nonuniform" : isShortRate ? "Current-rate-fitted nonuniform" : isHjb ? "Initial-wealth-fitted nonuniform" : "Strike-fitted nonuniform";
  const equationSummary = isHjb
    ? "Chooses the bounded investment allocation that maximises expected lifetime utility as wealth changes."
    : isHeston
      ? "Prices the contract while both the underlying price and its stochastic variance evolve."
      : isShortRate
        ? "Values the rate contract as the short rate evolves and future cash flows are discounted."
        : "Prices the contract by balancing time decay, diffusion, carry, and the terminal payoff.";
  const quotedContract = props.quotedContract;
  const quoteMoney = (value: number) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: quotedContract?.currency ?? "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);

  return <section className="solver-execution-surface" aria-labelledby="solve-surface-title">
    <header className="solve-surface-header">
      <div><span className="workspace-kicker">SOLVE · CONFIGURE & EXECUTE</span><h2 id="solve-surface-title">Run the current case</h2><p>Essential inputs are visible here. Numerical method, verification and simulation settings stay under Advanced.</p></div>
      <div className="solve-model-identity"><span>{model}</span><b>{contractLabel}</b><small>{measure}-measure</small></div>
    </header>

    <section className="solve-equation-summary" aria-label="Current governing problem"><div><span>Governing problem</span><b>{model} · {contractLabel}</b><p>{equationSummary}</p></div><div className="solve-equation-notation" tabIndex={0} aria-label="Scrollable mathematical notation"><Formula math={equation} display label={`${model} governing equation`} /></div></section>

    <section className="solve-essential" aria-labelledby="solve-essential-title">
      <header><div><span className="workspace-kicker">ESSENTIAL SETTINGS</span><h3 id="solve-essential-title">Contract and model inputs</h3></div><small>{parameterSpecs.length} active inputs · irrelevant controls hidden</small></header>
      {quotedContract && <aside className={`solve-quoted-contract ${props.quotedContractIsExact ? "aligned" : "available"}`} aria-label="Quoted contract alignment">
        <div>
          <span>{quotedContract.sourceMode === "fixture" ? "SAMPLE QUOTE EVIDENCE" : "MARKET QUOTE EVIDENCE"}</span>
          <b>{props.quotedContractIsExact ? "Exact quoted contract aligned" : quotedContract.sourceMode === "fixture" ? "Sample quoted contract available" : "Quoted market contract available"}</b>
          <small>{quotedContract.contractSymbol} · {quotedContract.side} · K {quotedContract.strike} · {quotedContract.expiration} · bid {quoteMoney(quotedContract.bid)} / ask {quoteMoney(quotedContract.ask)}</small>
          {!props.quotedContractIsExact && <em>Using this changes strike and maturity. The case stays in Solve and the previous result becomes stale.</em>}
        </div>
        {!props.quotedContractIsExact && <button type="button" onClick={props.onUseQuotedContract}>Use representative quoted contract<span>→</span></button>}
      </aside>}
      {contract === "barrier" && <div className="solve-contract-detail"><label className="solve-select-field"><ControlHelpLabel label="Barrier direction" help={SOLVER_CONTROL_HELP.barrierType} /><select aria-label="Barrier direction" value={barrierType} onChange={(event) => props.onChangeBarrierType(event.target.value)}><option>Up & out</option><option>Down & out</option></select></label></div>}
      <div className="solve-parameter-grid">
        {parameterSpecs.map((spec) => {
          const issues = fieldIssues(spec.id, spec.symbol, validationIssues);
          const issueId = `solve-${spec.id}-issues`;
          const isText = spec.id === "curveId";
          const isPercent = spec.unit === "dec";
          const rawValue = parameters[spec.id] ?? spec.defaultValue;
          return <label className={`solve-input-field ${issues.length ? "invalid" : ""} ${isText ? "wide" : ""}`} key={spec.id}>
            <span><ControlHelpLabel label={spec.label} help={getSolverParameterHelp(model, spec)} /><Formula math={symbolTex(spec.symbol)} label={spec.symbol} /></span>
            <span className="input-shell"><input aria-label={`${spec.label} (${spec.symbol})${isPercent ? " in percent" : ""}`} aria-invalid={issues.length > 0} aria-describedby={issues.length ? issueId : undefined} inputMode={isText ? "text" : "decimal"} value={isPercent ? decimalToPercentInput(rawValue) : rawValue} onChange={(event) => props.onChangeParameter(spec.id, isPercent ? percentInputToDecimal(event.target.value) : event.target.value)} />{spec.unit && <small>{isPercent ? "%" : spec.unit}</small>}</span>
            {isPercent && <details className="solve-raw-value"><summary>Inspect precise raw value</summary><code>{rawValue} [decimal]</code></details>}
            <InlineIssues id={issueId} issues={issues} />
            <em>{spec.source}</em>
          </label>;
        })}
      </div>
      {warnings.length > 0 && <div className="solve-warning" role="status"><b>Diagnostic warning</b>{warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
    </section>

    <details className="solve-advanced">
      <summary><span><b>Advanced execution settings</b><small>Scheme · grid · convergence · {monteCarloEligible ? "Monte Carlo" : "model verification"}</small></span><i aria-hidden="true">+</i></summary>
      <div className="solve-advanced-content">
        <section aria-labelledby="solve-method-title"><header><span>01</span><div><h3 id="solve-method-title">Scheme</h3><p>Model-compatible numerical method only.</p></div></header><label className="solve-select-field"><ControlHelpLabel label="Finite-difference scheme" help={SOLVER_CONTROL_HELP.scheme} /><select aria-label="Finite-difference scheme" value={scheme} disabled={!solverAvailable} onChange={(event) => props.onChangeScheme(event.target.value)}>{schemeOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><TechnicalTerminologyGuide schemeOptions={schemeOptions} /></section>
        <section aria-labelledby="solve-grid-title"><header><span>02</span><div><h3 id="solve-grid-title">Grid</h3><p>{isHeston ? "Two-dimensional spot and variance mesh." : "State and time resolution."}</p></div></header><div className="solve-grid-fields">
          <label className={numericalIssues("space", validationIssues).length ? "invalid" : ""}><ControlHelpLabel label={stateStepsLabel} help={stateStepsHelp} /><input aria-label={stateStepsLabel} inputMode="numeric" value={spaceSteps} onChange={(event) => props.onChangeSpaceSteps(event.target.value)} /><InlineIssues id="solve-space-issues" issues={numericalIssues("space", validationIssues)} /></label>
          {isHeston && <label className={numericalIssues("variance", validationIssues).length ? "invalid" : ""}><ControlHelpLabel label="Variance steps (Mᵥ)" help={SOLVER_CONTROL_HELP.varianceSteps} /><input aria-label="Variance steps (Mᵥ)" inputMode="numeric" value={varianceSteps} onChange={(event) => props.onChangeVarianceSteps(event.target.value)} /><InlineIssues id="solve-variance-issues" issues={numericalIssues("variance", validationIssues)} /></label>}
          <label className={numericalIssues("time", validationIssues).length ? "invalid" : ""}><ControlHelpLabel label="Time steps (N)" help={SOLVER_CONTROL_HELP.timeSteps} /><input aria-label="Time steps (N)" inputMode="numeric" value={timeSteps} onChange={(event) => props.onChangeTimeSteps(event.target.value)} /><InlineIssues id="solve-time-issues" issues={numericalIssues("time", validationIssues)} /></label>
          <label><ControlHelpLabel label="Spatial grid" help={SOLVER_CONTROL_HELP.spatialGrid} /><select aria-label="Spatial grid type" value={gridKind} onChange={(event) => props.onChangeGridKind(event.target.value as GridKind)}><option value="nonuniform">{spatialGridLabel}</option><option value="uniform">Uniform</option></select></label>
        </div></section>
        <section aria-labelledby="solve-convergence-title"><header><span>03</span><div><h3 id="solve-convergence-title">Convergence verification</h3><p>Runs automatically with the case; no second action required.</p></div></header><div className="solve-convergence-plan"><span><b>Point tolerance</b>{tolerance.pointwiseAbsolute.toExponential(0)}</span><span><b>Max norm</b>{tolerance.maxNorm?.toExponential(0) ?? "n/a"}</span><span><b>Observed order</b>{tolerance.observedOrder ?? "diagnostic"}</span><p>{tolerance.note}</p></div></section>
        {monteCarloEligible && <section aria-labelledby="solve-mc-title"><header><span>04</span><div><h3 id="solve-mc-title">Monte Carlo</h3><p>Optional model-matched simulation in the same worker job.</p></div></header><label className="solve-mc-toggle"><span><ControlHelpLabel label="Run with PDE solve" help={SOLVER_CONTROL_HELP.monteCarloEnabled} /><small>Off by default</small></span><input type="checkbox" role="switch" aria-label="Enable Monte Carlo simulation" checked={monteCarloEnabled} onChange={(event) => props.onToggleMonteCarlo(event.target.checked)} /></label>{monteCarloEnabled && <div className="solve-grid-fields mc"><label className={monteCarloIssues("paths", validationIssues).length ? "invalid" : ""}><ControlHelpLabel label="Number of paths" help={SOLVER_CONTROL_HELP.monteCarloPaths} /><input aria-label="Monte Carlo number of paths" inputMode="numeric" value={monteCarloPaths} onChange={(event) => props.onChangeMonteCarloPaths(event.target.value)} /><InlineIssues id="solve-mc-path-issues" issues={monteCarloIssues("paths", validationIssues)} /></label><label className={monteCarloIssues("steps", validationIssues).length ? "invalid" : ""}><ControlHelpLabel label="Simulation time steps" help={SOLVER_CONTROL_HELP.monteCarloTimeSteps} /><input aria-label="Monte Carlo simulation time steps" inputMode="numeric" value={monteCarloTimeSteps} onChange={(event) => props.onChangeMonteCarloTimeSteps(event.target.value)} /><InlineIssues id="solve-mc-step-issues" issues={monteCarloIssues("steps", validationIssues)} /></label><label className={monteCarloIssues("seed", validationIssues).length ? "invalid" : ""}><ControlHelpLabel label="Random seed" help={SOLVER_CONTROL_HELP.monteCarloSeed} /><input aria-label="Monte Carlo random seed" inputMode="numeric" value={monteCarloSeed} onChange={(event) => props.onChangeMonteCarloSeed(event.target.value)} /><InlineIssues id="solve-mc-seed-issues" issues={monteCarloIssues("seed", validationIssues)} /></label></div>}</section>}
      </div>
    </details>

    <section className={`solve-readiness ${readinessClass}`} aria-labelledby="solve-readiness-title">
      <header><div><span className="workspace-kicker">EXECUTION READINESS</span><h3 id="solve-readiness-title">{status.runActivity === "running" ? workerStage : readinessLabel}</h3></div><strong>{readinessLabel.toUpperCase()}</strong></header>
      <div className="solve-readiness-meta"><span><b>Model</b>{model} · {measure}</span><span><b>Grid</b>{isHeston ? `${spaceSteps} × ${varianceSteps} × ${timeSteps}` : `${spaceSteps} × ${timeSteps}`}</span><span><b>Execution</b>{monteCarloEnabled && monteCarloEligible ? "PDE + Monte Carlo" : "PDE + convergence"}</span><span><b>Last source</b>{lastExecution}</span></div>
      {validationIssues.length > 0 && <p role="alert">{validationIssues.length} validation {validationIssues.length === 1 ? "issue blocks" : "issues block"} execution. Each issue is shown beside its affected input.</p>}
      {solverError && <p className="error" role="alert">{solverError}</p>}
      {running && <div className="solve-execution-progress"><span><b>{progress}%</b>{workerStage}</span><i><b style={{ width: `${progress}%` }} /></i></div>}
      {!running && conditioningRequiresApproval
        ? <button type="button" className="review-conditioning" onClick={props.onReturnToCondition}><span>Return to Condition to approve market base</span><b>→</b></button>
        : <button type="button" className={running ? "cancel" : ""} onClick={running ? props.onCancel : props.onRun} disabled={!running && blocked}><span>{running ? "Cancel run" : solverAvailable ? "Run case" : "Solver unavailable"}</span><b>{running ? `${progress}%` : "⌘ ↵"}</b></button>}
      {!running && !blocked && <small>{status.resultFreshness === "current" ? "Run again only after changing the case or execution settings." : "Queues one background worker job. Identical configurations may be restored from cache."}</small>}
    </section>
  </section>;
}
