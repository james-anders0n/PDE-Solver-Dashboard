"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { checkModelSnapshotCompatibility, isCaseConditioningApproved, type Case } from "@/app/lib/case-state";
import { getConditionBasePresentation } from "@/app/lib/condition-presentation";
import type { MarketSnapshot } from "@/app/lib/market-data";
import { MODEL_SPECS, type ParameterValidationIssue } from "@/app/lib/pde-spec";
import { ConditionBaseSummary } from "@/app/components/condition-base-summary";
import { ConditionPrimaryAction } from "@/app/components/condition-primary-action";
import { EvidenceApplyStatus } from "@/app/components/evidence-apply-status";
import { TechnicalTerminologyGuide } from "@/app/components/technical-terminology-guide";
import { deriveConditionPrimaryAction, isPendingBaseApplication } from "@/app/lib/condition-flow";
import { formatEvidenceValue, formatUtcDateTime } from "@/app/lib/presentation";

const parameterLabel = (id: string) => id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
const displayValue = (value: string | number | undefined, unit?: string) => formatEvidenceValue(value, unit);

interface ConditionWorkbenchProps {
  caseState: Case;
  marketSnapshot: MarketSnapshot | null;
  selectedMarketParameterIds: ReadonlySet<string>;
  validationIssues: ParameterValidationIssue[];
  marketEvidence: ReactNode;
  onOpenMarketControls(): void;
  onApplyMarket(): void;
  onApprove(): void;
  onContinue(): void;
}

export function ConditionWorkbench({
  caseState,
  marketSnapshot,
  selectedMarketParameterIds,
  validationIssues,
  marketEvidence,
  onOpenMarketControls,
  onApplyMarket,
  onApprove,
  onContinue,
}: ConditionWorkbenchProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [applyCompletion, setApplyCompletion] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const evidenceDrawerRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousAppliedRef = useRef(false);
  const { marketBase, solverConfiguration } = caseState.core;
  const basePresentation = getConditionBasePresentation(caseState.core.definition.model, marketSnapshot?.measure ?? null);
  const snapshotCompatibilityIssues = checkModelSnapshotCompatibility(caseState.core.definition, marketSnapshot);
  const historicalVasicekEvidence = caseState.core.definition.model === "Vasicek"
    && marketSnapshot?.model === "Vasicek"
    && marketSnapshot.measure === "P";
  const evidenceCompatibilityIssues = historicalVasicekEvidence ? [] : snapshotCompatibilityIssues;
  const appliedMarketSnapshot = marketSnapshot?.id === marketBase.snapshotId && snapshotCompatibilityIssues.length === 0;
  const conditioningApproved = isCaseConditioningApproved(caseState.core);

  const closeEvidence = useCallback(() => {
    setEvidenceOpen(false);
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!evidenceOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEvidence();
      }
      if (event.key === "Tab") {
        const focusable = [...(evidenceDrawerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])') ?? [])];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeEvidence, evidenceOpen]);

  useEffect(() => {
    const newlyApplied = appliedMarketSnapshot && !previousAppliedRef.current;
    previousAppliedRef.current = appliedMarketSnapshot;
    if (!newlyApplied || !evidenceOpen) return;
    setApplyCompletion(`Snapshot ${marketBase.snapshotId ?? "manual base"} is now the active ${basePresentation.requiredMeasure}-measure base. Solver execution has not started.`);
    closeEvidence();
  }, [appliedMarketSnapshot, basePresentation.requiredMeasure, closeEvidence, evidenceOpen, marketBase.snapshotId]);

  const rows = useMemo(() => Object.entries(solverConfiguration.parameters).map(([id, solverValue]) => {
    const proposal = marketSnapshot?.proposals.find((candidate) => candidate.id === id);
    const baseValue = marketBase.parameters[id] ?? solverValue;
    return {
      id,
      label: proposal?.label ?? parameterLabel(id),
      baseValue,
      conditionedValue: solverValue,
      changed: String(baseValue) !== String(solverValue),
      classification: proposal?.classification ?? (marketBase.source === "manual" ? "manual" : "case input"),
      baseMeasure: proposal?.provenance.measure ?? marketBase.measure,
      observedAt: proposal?.provenance.observationTimestamp ?? marketBase.asOfDate,
      availableAt: proposal?.provenance.availableTimestamp ?? marketBase.appliedAt,
      lineage: proposal?.provenance.formula ?? (marketBase.source === "snapshot" ? `Snapshot ${marketBase.snapshotId}` : "Direct case control"),
      validationIssues: validationIssues.filter((issue) => issue.fieldId === id),
      unit: proposal?.provenance.unit ?? MODEL_SPECS[caseState.core.definition.model].parameters.find((parameter) => parameter.id === id)?.unit,
    };
  }), [caseState.core.definition.model, marketBase, marketSnapshot, solverConfiguration.parameters, validationIssues]);

  const openEvidence = (trigger?: HTMLElement) => {
    returnFocusRef.current = trigger ?? document.activeElement as HTMLElement | null;
    setEvidenceOpen(true);
  };
  const canApplyMarket = Boolean(marketSnapshot
    && selectedMarketParameterIds.size > 0
    && marketSnapshot.validationIssues.length === 0
    && snapshotCompatibilityIssues.length === 0);
  const primaryAction = deriveConditionPrimaryAction({
    hasUnappliedSnapshot: isPendingBaseApplication({
      hasSnapshot: Boolean(marketSnapshot),
      appliedMarketSnapshot,
      compatibilityIssueCount: snapshotCompatibilityIssues.length,
    }),
    canApplyMarket,
    selectedChangeCount: selectedMarketParameterIds.size,
    requiredMeasure: basePresentation.requiredMeasure,
    conditioningApproved,
  });
  const primaryActionHandlers = {
    "apply-market": onApplyMarket,
    "open-market-controls": onOpenMarketControls,
    "approve-inputs": onApprove,
    "continue-to-solve": onContinue,
  } satisfies Record<typeof primaryAction.kind, () => void>;

  return <section className="condition-workbench" aria-labelledby="condition-title">
    <header className="condition-header">
      <div><span className="workspace-kicker">CONDITION · MARKET APPROVAL</span><h2 id="condition-title">Approve the market base</h2><p>Review and approve the evidence-backed market base once. Contract and numerical controls remain editable in Solve.</p></div>
    </header>

    <ol className="condition-dependency-flow" aria-label="Conditioning dependency flow">
      <li className="complete"><span>1</span><div><b>Choose source</b><small>{marketSnapshot?.sourceMode ?? (marketBase.source === "manual" ? "Manual inputs" : "Source required")}</small></div></li>
      <li className={marketSnapshot || marketBase.source === "manual" ? "complete" : "pending"}><span>2</span><div><b>Fetch or enter evidence</b><small>{marketSnapshot ? `${marketSnapshot.observations.length} observations` : basePresentation.manualBaseLabel}</small></div></li>
      <li className={rows.length > 0 ? "complete" : "pending"}><span>3</span><div><b>Review mappings</b><small>{rows.length} exact input mappings</small></div></li>
      <li className={appliedMarketSnapshot || marketBase.source === "manual" ? "complete" : "pending"}><span>4</span><div><b>Apply market base</b><small>{marketBase.snapshotId ?? "Manual base"}</small></div></li>
      <li className={conditioningApproved ? "complete" : "pending"}><span>5</span><div><b>Approve market base</b><small>{conditioningApproved ? formatUtcDateTime(caseState.core.conditionApproval?.approvedAt) : "Approval not recorded"}</small></div></li>
    </ol>

    <div className="condition-measure-guards single">
      <ConditionBaseSummary presentation={basePresentation} marketBase={marketBase} active={appliedMarketSnapshot || marketBase.source === "manual"} />
    </div>

    <TechnicalTerminologyGuide />

    {(evidenceCompatibilityIssues.length || marketSnapshot?.warnings.length) ? <div className="condition-notice" role="status"><b>Evidence requires attention</b><span>{evidenceCompatibilityIssues.join(" ") || marketSnapshot?.warnings.join(" ")}</span></div> : null}
    <EvidenceApplyStatus message={applyCompletion} />

    <details className="condition-ledger">
      <summary><div><span className="workspace-kicker">SOLVER INPUT LEDGER</span><h3>Market base and current solver values</h3></div><div className="condition-ledger-summary-meta"><div className="condition-ledger-legend"><span><i className="base" /> {basePresentation.requiredMeasure} base</span></div><span className="condition-ledger-toggle" aria-hidden="true"><span className="when-closed">Open ledger</span><span className="when-open">Close ledger</span><i>⌄</i></span></div></summary>
      <div className="condition-ledger-table" role="table" aria-label="Market base and current solver values">
        <div className="condition-ledger-row head" role="row"><span>Input</span><span>Market base</span><span>Current value</span><span>Classification & measure</span><span>Timestamp & mapping lineage</span></div>
        {rows.map((row) => <div className={`condition-ledger-row ${row.changed ? "changed" : ""} ${row.validationIssues.length ? "invalid" : ""}`} role="row" key={row.id}>
          <span className="condition-cell-input" role="cell" data-label="Input"><b>{row.label}</b><code>{row.id}</code>{row.validationIssues.map((issue) => <small className="condition-field-error" role="alert" key={issue.message}>{issue.message}</small>)}</span>
          <span className="condition-cell-base" role="cell" data-label="Market base"><strong>{displayValue(row.baseValue, row.unit)}</strong><small>{basePresentation.storedBaseLabel}</small></span>
          <span className="condition-cell-approved" role="cell" data-label="Approved value"><strong>{displayValue(row.conditionedValue, row.unit)}</strong><small>{row.changed ? "Edited solver value" : "Same as base"}</small></span>
          <span className="condition-cell-measure" role="cell" data-label="Measure and classification"><b className={`classification ${row.classification}`}>{row.classification}</b><small>{row.baseMeasure}-measure</small></span>
          <span className="condition-cell-lineage condition-lineage-desktop" role="cell"><small>Observed {formatUtcDateTime(row.observedAt)}</small><small>Available {formatUtcDateTime(row.availableAt)}</small><button type="button" onClick={(event) => openEvidence(event.currentTarget)}>{row.lineage}</button></span>
          <details className="condition-lineage-mobile"><summary>View lineage</summary><div><small>Observed {formatUtcDateTime(row.observedAt)}</small><small>Available {formatUtcDateTime(row.availableAt)}</small><button type="button" onClick={(event) => openEvidence(event.currentTarget)}>{row.lineage}</button></div></details>
        </div>)}
      </div>
    </details>

    <div className="condition-approval-grid single">
      <section className="condition-approval-card">
        <header><div><span className="workspace-kicker">BASE APPROVAL</span><h3>{basePresentation.approvalLabel}</h3></div><span className={`approval-state ${appliedMarketSnapshot || marketBase.source === "manual" ? "approved" : "review"}`}>{appliedMarketSnapshot || marketBase.source === "manual" ? "APPROVED" : "REVIEW"}</span></header>
        <p>{marketSnapshot ? `${marketSnapshot.instrument} · ${marketSnapshot.measure}-measure · ${marketSnapshot.freshness}` : "No fetched snapshot. The current manual base remains visible in the ledger."}</p>
        <footer><button type="button" onClick={(event) => openEvidence(event.currentTarget)}>Review market evidence and lineage</button><button type="button" onClick={onOpenMarketControls}>Open market-data controls</button></footer>
      </section>
    </div>

    <div className="condition-approval-summary" role="status"><span><i className={conditioningApproved ? "ready" : "review"} /><b>{conditioningApproved ? "Market base approved" : "Market-base approval has not been recorded"}</b><small>Approval records the selected evidence and market base. It remains valid while you refine contract and numerical controls in Solve.</small></span><ConditionPrimaryAction action={primaryAction} onAction={primaryActionHandlers[primaryAction.kind]} /></div>

    {evidenceOpen && <div className="condition-evidence-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEvidence(); }}><aside ref={evidenceDrawerRef} className="condition-evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="condition-evidence-title" aria-describedby="condition-evidence-description"><header><div><span className="workspace-kicker">MARKET EVIDENCE & LINEAGE</span><h2 id="condition-evidence-title">Trace the market evidence</h2><p id="condition-evidence-description">Review status, the primary visual, changed parameters, blocking warnings and the exact market-base application.</p></div><button ref={closeButtonRef} type="button" aria-label="Close evidence and lineage" onClick={closeEvidence}>×</button></header><div className="condition-evidence-content">{marketEvidence}</div></aside></div>}
  </section>;
}
