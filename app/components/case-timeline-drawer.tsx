"use client";

import { useEffect, useMemo, useState } from "react";
import type { Case } from "@/app/lib/case-state";
import { buildCaseTimeline, CaseChangePreview, TimelineCheckpointContent } from "@/app/lib/case-history-presentation";

export function CaseTimelineDrawer({
  open,
  caseState,
  onClose,
  onRestore,
  onBranch,
}: {
  open: boolean;
  caseState: Case;
  onClose(): void;
  onRestore(revisionId: string): void;
  onBranch(revisionId: string): void;
}) {
  const checkpoints = useMemo(() => buildCaseTimeline(caseState), [caseState]);
  const [selectedId, setSelectedId] = useState(`current-${caseState.id}`);
  const selected = checkpoints.find((checkpoint) => checkpoint.id === selectedId) ?? checkpoints[0];

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  const run = selected.core.latestRun;
  return <div className="case-timeline-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <aside className="case-timeline-drawer" role="dialog" aria-modal="true" aria-label="Case timeline">
      <header>
        <div><span className="workspace-kicker">ONE CASE · COMPLETE LINEAGE</span><h2>Case timeline</h2><p>Inspect, restore or branch any saved checkpoint without leaving the workflow.</p></div>
        <button type="button" onClick={onClose} aria-label="Close case timeline">×</button>
      </header>

      <div className="case-timeline-layout">
        <ol className="case-timeline-list">
          {checkpoints.map((checkpoint) => <li key={checkpoint.id} className={`${checkpoint.event} ${checkpoint.current ? "current" : ""}`}>
            <button type="button" className={selected.id === checkpoint.id ? "active" : ""} onClick={() => setSelectedId(checkpoint.id)} aria-pressed={selected.id === checkpoint.id}>
              <i aria-hidden="true" />
              <TimelineCheckpointContent checkpoint={checkpoint} />
            </button>
          </li>)}
        </ol>

        <section className="case-timeline-inspector" aria-live="polite">
          <header>
            <div><span>{selected.current ? "CURRENT STATE" : "SAVED CHECKPOINT"}</span><h3>{selected.title}</h3><p>{selected.reason}</p></div>
            {!selected.current && <div>
              <button type="button" aria-label="Restore revision with previewed changes" onClick={() => onRestore(selected.id)}>Restore these changes</button>
              <button type="button" className="primary" aria-label="Branch from here with previewed changes" onClick={() => onBranch(selected.id)}>Branch with these changes</button>
            </div>}
          </header>

          {!selected.current && <CaseChangePreview current={caseState.core} target={selected.core} />}

          <div className="timeline-inspector-summary">
            <article><span>Definition</span><b>{selected.core.definition.instrument} · {selected.core.definition.contractLabel}</b><small>{selected.core.definition.model} · {selected.core.definition.measure}-measure</small></article>
            <article><span>Market base</span><b>{selected.core.marketBase.source === "snapshot" ? "Applied snapshot" : "Manual base"}</b><small>{selected.core.marketBase.snapshotId ?? selected.core.marketBase.asOfDate}</small></article>
            <article><span>Scenario</span><b>{selected.core.economicScenario?.scenarioId ?? "Base only"}</b><small>{selected.core.economicScenario ? `${selected.core.economicScenario.scenarioMeasure}-measure branch` : "No macro overlay"}</small></article>
            <article><span>Result</span><b>{run?.status ?? "Not run"}</b><small>{run?.summary?.primaryValue == null ? "No completed value" : `Value ${run.summary.primaryValue.toFixed(4)}`}</small></article>
          </div>

          <details open>
            <summary><span><b>Problem and conditioning</b><small>Definition, market base and branch identity</small></span><i>+</i></summary>
            <div className="timeline-detail-grid">
              <span><small>Case name</small><b>{selected.core.definition.caseName}</b></span>
              <span><small>Valuation date</small><b>{selected.core.definition.valuationDate}</b></span>
              <span><small>Objective</small><b>{selected.core.definition.objective}</b></span>
              <span><small>Definition saved</small><b>{selected.core.definition.confirmedAt ?? "Not yet"}</b></span>
              <span><small>Condition approved</small><b>{selected.core.conditionApproval?.approvedAt ?? "Not yet"}</b></span>
              <span><small>Approved input fingerprint</small><b>{selected.core.conditionApproval?.inputFingerprint ?? "—"}</b></span>
              <span><small>Market timestamp</small><b>{selected.core.marketBase.asOfDate}</b></span>
              <span><small>Market application</small><b>{selected.core.marketBase.applicationId ?? "Manual"}</b></span>
              {selected.core.economicScenario && <><span><small>Scenario mapping</small><b>{selected.core.economicScenario.mappingId}</b></span><span><small>Mapping version</small><b>{selected.core.economicScenario.mappingVersion}</b></span></>}
            </div>
          </details>
          <details>
            <summary><span><b>Solver and run evidence</b><small>Execution settings and immutable run identity</small></span><i>+</i></summary>
            <div className="timeline-detail-grid">
              <span><small>Scheme</small><b>{selected.core.solverConfiguration.scheme}</b></span>
              <span><small>Grid</small><b>{selected.core.solverConfiguration.spaceSteps} × {selected.core.solverConfiguration.timeSteps}</b></span>
              <span><small>Run ID</small><b>{run?.id ?? "Not run"}</b></span>
              <span><small>Execution</small><b>{run?.execution ?? "—"}</b></span>
              <span><small>Acceptance</small><b>{run?.summary?.accepted == null ? "Not assessed" : run.summary.accepted ? "Passed" : "Review"}</b></span>
              <span><small>Input fingerprint</small><b>{run?.inputFingerprint.combined ?? "—"}</b></span>
            </div>
          </details>
        </section>
      </div>
    </aside>
  </div>;
}
