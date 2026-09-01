"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { CaseReadiness, CaseStageState } from "@/app/lib/case-state";
import { CaseStatusSummary } from "@/app/components/case-status-summary";
import type { ContractSpec, ModelKey, OptionSide } from "@/app/lib/pde-spec";

export type CaseStage = "define" | "condition" | "solve" | "decide";

const STAGES: Array<{ id: CaseStage; index: string; label: string; purpose: string }> = [
  { id: "define", index: "01", label: "Define", purpose: "Problem" },
  { id: "condition", index: "02", label: "Condition", purpose: "Inputs" },
  { id: "solve", index: "03", label: "Solve", purpose: "Compute" },
  { id: "decide", index: "04", label: "Decide", purpose: "Answer" },
];

const statusFor = (stage: CaseStage, readiness: CaseReadiness): CaseStageState => {
  return readiness.status.stages[stage];
};

export function CaseWorkbenchChrome({ activeStage, readiness, summary, onSelectStage }: {
  activeStage: CaseStage;
  readiness: CaseReadiness;
  summary: {
    caseLabel: string;
    definition: string;
    market: string;
    scenario: string;
  };
  onSelectStage(stage: CaseStage): void;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keyTarget = event.key === "Home" ? 0
      : event.key === "End" ? STAGES.length - 1
        : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % STAGES.length
          : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + STAGES.length) % STAGES.length
            : null;
    if (keyTarget === null) return;
    event.preventDefault();
    buttonRefs.current[keyTarget]?.focus();
  };

  return <>
    <nav className="case-stage-rail" aria-label="Case workflow">
      {STAGES.map((stage, index) => {
        const status = statusFor(stage.id, readiness);
        const active = activeStage === stage.id;
        return <button
          key={stage.id}
          ref={(node) => { buttonRefs.current[index] = node; }}
          type="button"
          className={`${active ? "active" : ""} ${status}`}
          aria-current={active ? "step" : undefined}
          aria-label={`${stage.label}: ${stage.purpose}. Status ${status}.`}
          onClick={() => onSelectStage(stage.id)}
          onKeyDown={(event) => moveFocus(event, index)}
        >
          <span className="case-stage-index">{stage.index}</span>
          <span className="case-stage-copy"><b>{stage.label}</b><small>{stage.purpose}</small></span>
          <i aria-hidden="true" />
          <em>{status}</em>
        </button>;
      })}
    </nav>
    <CaseStatusSummary status={readiness.status} />
    <aside className="case-summary-strip" aria-label={`${summary.caseLabel} summary`}>
      <span className="case-summary-identity case-summary-desktop"><small>Current case</small><strong>{summary.caseLabel}</strong></span>
      <span className="case-summary-desktop"><small>Definition</small><b>{summary.definition}</b></span>
      <span className="case-summary-desktop"><small>Market base</small><b>{summary.market}</b></span>
      <span className="case-summary-desktop"><small>Scenario</small><b>{summary.scenario}</b></span>
      <div className="case-summary-mobile">
        <span><small>Current case</small><strong>{summary.caseLabel}</strong><b>{summary.definition}</b></span>
        <details><summary>View case details</summary><div><span><small>Definition</small><b>{summary.definition}</b></span><span><small>Market base</small><b>{summary.market}</b></span><span><small>Scenario</small><b>{summary.scenario}</b></span></div></details>
      </div>
    </aside>
  </>;
}

export function CaseDefinitionWorkspace({
  caseName,
  instrument,
  valuationDate,
  model,
  models,
  contractId,
  contracts,
  side,
  optionSides,
  measure,
  measureMeaning,
  objective,
  issues,
  confirmedAt,
  consequence,
  canSave,
  onChangeCaseName,
  onChangeInstrument,
  onChangeValuationDate,
  onChangeModel,
  onChangeContract,
  onChangeSide,
  onChangeObjective,
  onSave,
}: {
  caseName: string;
  instrument: string;
  valuationDate: string;
  model: ModelKey;
  models: ReadonlyArray<{ id: ModelKey; description: string; measure: string }>;
  contractId: string;
  contracts: readonly ContractSpec[];
  side: OptionSide | null;
  optionSides?: readonly OptionSide[];
  measure: string;
  measureMeaning: string;
  objective: string;
  issues: readonly string[];
  confirmedAt: string | null;
  consequence: string;
  canSave: boolean;
  onChangeCaseName(value: string): void;
  onChangeInstrument(value: string): void;
  onChangeValuationDate(value: string): void;
  onChangeModel(value: ModelKey): void;
  onChangeContract(value: string): void;
  onChangeSide(value: OptionSide): void;
  onChangeObjective(value: string): void;
  onSave(): void;
}) {
  return <section className="case-definition-workspace" aria-labelledby="define-case-title">
    <header>
      <div><span className="workspace-kicker">STAGE 01 · PROBLEM DEFINITION</span><h2 id="define-case-title">Define the problem</h2><p>Name the case, choose its governing specification, and state the decision objective before conditioning inputs.</p></div>
      <span className={`definition-confirmation ${confirmedAt ? "confirmed" : "draft"}`}><i />{confirmedAt ? "Definition saved" : "Draft · save required"}</span>
    </header>
    <form className="case-definition-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <label><span>Case name</span><input aria-label="Case name" value={caseName} onChange={(event) => onChangeCaseName(event.target.value)} /></label>
      <label><span>Instrument or series</span><input aria-label="Case instrument" value={instrument} onChange={(event) => onChangeInstrument(event.target.value)} /></label>
      <label><span>Valuation date</span><input aria-label="Case valuation date" type="date" value={valuationDate} onChange={(event) => onChangeValuationDate(event.target.value)} /></label>
      <label><span>Governing model</span><select aria-label="Case governing model" value={model} onChange={(event) => onChangeModel(event.target.value as ModelKey)}>{models.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.measure} · {item.description}</option>)}</select></label>
      <label><span>Contract</span><select aria-label="Case contract" value={contractId} onChange={(event) => onChangeContract(event.target.value)}>{contracts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {optionSides?.length ? <fieldset><legend>Option side</legend><div>{optionSides.map((item) => <button type="button" key={item} aria-pressed={side === item} className={side === item ? "active" : ""} onClick={() => onChangeSide(item)}>{item}</button>)}</div></fieldset> : <div className="definition-not-applicable"><span>Option side</span><b>Not applicable</b></div>}
      <label className="definition-objective"><span>Objective</span><textarea aria-label="Case objective" rows={3} value={objective} onChange={(event) => onChangeObjective(event.target.value)} /></label>
      <article className="definition-measure-summary" aria-label="Objective and measure summary"><span>Required measure</span><strong>{measure}-measure</strong><p>{measureMeaning}</p></article>
      <div className="definition-consequence" role="status"><b>What changes</b><span>{consequence}</span></div>
      {issues.length > 0 && <div className="definition-issues" role="alert"><b>Definition needs attention</b><ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
      <div className="definition-save"><span>{confirmedAt ? `Saved ${new Date(confirmedAt).toLocaleString("en-AU")}` : "Defaults do not complete this stage until the definition is saved."}</span><button type="submit" disabled={!canSave}>{confirmedAt ? "Save updated definition" : "Save definition"}</button></div>
    </form>
  </section>;
}

export function StageViewHeader({ kicker, title, description, children }: {
  kicker: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return <header className="stage-view-header">
    <div><span className="workspace-kicker">{kicker}</span><h2>{title}</h2><p>{description}</p></div>
    {children && <div className="stage-view-switcher">{children}</div>}
  </header>;
}

export function CaseNextActionBar({ stage, status, message, actionLabel, disabled = false, running = false, onAction }: {
  stage: CaseStage;
  status: CaseStageState;
  message: string;
  actionLabel: string;
  disabled?: boolean;
  running?: boolean;
  onAction(): void;
}) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const update = () => setCompact(window.scrollY > 180);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return <footer className={`case-next-action ${status} ${compact ? "scrolled" : ""}`} aria-label="Case next action">
    <div><span>Next action · {stage}</span><p><i className={running ? "pulse" : ""} />{message}</p></div>
    <button type="button" className={running ? "cancel" : ""} disabled={disabled} onClick={onAction}>{actionLabel}<b aria-hidden="true">→</b></button>
  </footer>;
}
