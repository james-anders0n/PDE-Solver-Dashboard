"use client";

import { type ReactNode, useState } from "react";
import type { CaseDefinition, CaseEconomicScenario, CaseSolverRun, CaseStatusSystem } from "@/app/lib/case-state";
import { supportsListedOptionValuation, type OptionValuationAssessment } from "@/app/lib/option-valuation-assessment";
import { DownloadFeedbackNotice, type DownloadArtifact, type DownloadFeedback } from "@/app/components/download-feedback";
import { MissingBaseRunRecovery } from "@/app/components/missing-base-run-recovery";

export interface DecideMetric {
  label: string;
  value: string;
  detail?: string;
}

export interface DecideEvidenceSection {
  title: string;
  summary: string;
  metrics: DecideMetric[];
}

interface DecideWorkspaceProps {
  children?: ReactNode;
  valuationAssessment: OptionValuationAssessment;
  onReviewValuationEvidence: () => void;
  definition: CaseDefinition;
  scenario: CaseEconomicScenario | null;
  run: CaseSolverRun | null;
  status: CaseStatusSystem;
  staleReasons: string[];
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
  baseValue: string | null;
  scenarioValue: string | null;
  scenarioDelta: string | null;
  reliability: DecideMetric[];
  uncertainty: DecideMetric[];
  sensitivities: DecideMetric[];
  evidence: DecideEvidenceSection[];
  resultsAvailable: boolean;
  onDownloadManifest: () => DownloadArtifact;
  onDownloadResults: () => DownloadArtifact;
  onRunMatchingBase: () => void;
  onReturnToSolve: () => void;
}

export function DecideWorkspace({
  children,
  valuationAssessment,
  onReviewValuationEvidence,
  definition,
  scenario,
  run,
  status,
  staleReasons,
  primaryLabel,
  primaryValue,
  secondaryLabel,
  secondaryValue,
  baseValue,
  scenarioValue,
  scenarioDelta,
  reliability,
  uncertainty,
  sensitivities,
  evidence,
  resultsAvailable,
  onDownloadManifest,
  onDownloadResults,
  onRunMatchingBase,
  onReturnToSolve,
}: DecideWorkspaceProps) {
  const [downloadFeedback, setDownloadFeedback] = useState<DownloadFeedback | null>(null);
  const download = (createArtifact: () => DownloadArtifact, expected: DownloadArtifact) => {
    try {
      setDownloadFeedback({ status: "success", ...createArtifact() });
    } catch (error) {
      setDownloadFeedback({
        status: "error",
        ...expected,
        message: error instanceof Error ? error.message : "The browser could not create the download.",
      });
    }
  };
  const completed = run?.status === "completed" && run.summary;
  if (!completed) {
    return <section className="decide-empty-state">
      <span className="card-label"><i /> Decision output</span>
      <h2>No completed result for this case</h2>
      <p>Configure and run the case before making a decision. Failed or cancelled attempts remain available in the case record.</p>
      <button type="button" onClick={onReturnToSolve}>Return to Solve <span>→</span></button>
    </section>;
  }

  const stale = status.resultFreshness === "stale";
  const currency = (valuationAssessment.quote ?? valuationAssessment.suggestedQuote)?.currency ?? "USD";
  const money = (value: number | null) => value == null ? "—" : new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);

  return <div className="decide-workspace">
    {supportsListedOptionValuation(definition.model) && <section className={`decide-valuation-assessment ${valuationAssessment.stance}`} aria-labelledby="valuation-assessment-title">
      <header>
        <div>
          <span className="card-label"><i /> Long-entry relative valuation</span>
          <h2 id="valuation-assessment-title">{valuationAssessment.label}</h2>
          <p>{valuationAssessment.summary}</p>
        </div>
        <span className="decide-valuation-measure">{definition.measure}-measure model comparison</span>
      </header>
      <div className="decide-valuation-metrics" aria-label="Valuation assessment inputs">
        <span><small>Model value</small><b>{money(valuationAssessment.modelValue)}</b></span>
        <span><small>Executable ask</small><b>{money(valuationAssessment.quote?.ask ?? null)}</b></span>
        <span><small>Quoted spread</small><b>{money(valuationAssessment.spread)}</b></span>
        <span><small>Model edge at ask</small><b>{money(valuationAssessment.grossEdge)}</b></span>
        <span><small>Required buffer</small><b>{money(valuationAssessment.requiredBuffer)}</b></span>
        <span><small>Adjusted edge range</small><b>{valuationAssessment.edgeRange ? `${money(valuationAssessment.edgeRange[0])} to ${money(valuationAssessment.edgeRange[1])}` : "—"}</b></span>
      </div>
      <footer>
        <div>
          {valuationAssessment.quote
            ? <><b>{valuationAssessment.quote.contractSymbol}</b><span>{valuationAssessment.quote.side} · K {valuationAssessment.quote.strike} · {valuationAssessment.quote.expiration} · quote {new Date(valuationAssessment.quote.quoteTimestamp).toLocaleString("en-AU", { timeZone: "UTC", timeZoneName: "short" })}</span></>
            : valuationAssessment.suggestedQuote
              ? <><b>Representative quoted contract available in Solve</b><span>{valuationAssessment.suggestedQuote.contractSymbol} · {valuationAssessment.suggestedQuote.side} · K {valuationAssessment.suggestedQuote.strike} · {valuationAssessment.suggestedQuote.expiration}</span><span>Return to Solve to apply it. This changes strike and maturity, then requires Condition approval and a new solver run.</span></>
              : <><b>No like-for-like quote attached</b><span>Return to Condition to load and apply matching market evidence.</span></>}
          <small>Relative valuation only—not a return forecast or trading recommendation. Brokerage fees are not configured and remain excluded.</small>
        </div>
        {valuationAssessment.stance === "insufficient-evidence" && (valuationAssessment.suggestedQuote
          ? <button type="button" onClick={onReturnToSolve}>Return to Solve <span>→</span></button>
          : <button type="button" onClick={onReviewValuationEvidence}>Review required evidence <span>→</span></button>)}
      </footer>
      {valuationAssessment.reasons.length > 1 && <details>
        <summary>Why the assessment is unavailable</summary>
        <ul>{valuationAssessment.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      </details>}
    </section>}

    {stale && <section className="decide-stale-notice" role="status">
      <div><b>Previous result retained</b><span>This answer no longer represents the current case inputs.</span></div>
      <ul>{staleReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <button type="button" onClick={onReturnToSolve}>Update in Solve <span>→</span></button>
    </section>}

    <section className={`decide-answer-card ${stale ? "stale" : status.numericalAcceptance}`}>
      <header>
        <div>
          <span className="card-label"><i /> {status.sampleResultLoaded ? "Sample result loaded" : "Completed decision run"}</span>
          <h2>{definition.instrument} · {definition.contractLabel}</h2>
          <p>{definition.model} · {definition.measure}-measure · {scenario ? `Macro branch ${scenario.scenarioId}` : "Calibrated base"}</p>
        </div>
        <div className="decide-status-pills" aria-label="Result freshness and numerical acceptance">
          <span className={`decide-status-pill ${status.resultFreshness}`}><small>Result freshness</small><b>{status.labels.resultFreshness}</b></span>
          <span className={`decide-status-pill ${status.numericalAcceptance}`}><small>Numerical acceptance</small><b>{status.labels.numericalAcceptance}</b></span>
        </div>
      </header>

      <div className="decide-primary-answer">
        <div>
          <span>{primaryLabel}</span>
          <strong>{primaryValue}</strong>
          <small>{secondaryLabel} · {secondaryValue}</small>
        </div>
        <div className="decide-downloads" aria-label="Completed run downloads">
          <span>Completed {run.completedAt ? new Date(run.completedAt).toLocaleString("en-AU") : "—"}</span>
          {resultsAvailable && <button type="button" onClick={() => download(onDownloadResults, { filename: `pde-results-${run.id}.csv`, fileType: "CSV" })}>Results CSV <b>↓</b></button>}
          <button type="button" onClick={() => download(onDownloadManifest, { filename: `pde-run-manifest-${run.id}.json`, fileType: "JSON" })}>Run manifest <b>↓</b></button>
          <DownloadFeedbackNotice feedback={downloadFeedback} />
        </div>
      </div>

      <div className="decide-comparison" aria-label="Base versus scenario comparison">
        <article>
          <span>Base</span>
          {scenario && baseValue == null
            ? <MissingBaseRunRecovery onRunMatchingBase={onRunMatchingBase} />
            : <><strong>{baseValue ?? primaryValue}</strong><small>Calibrated market inputs</small></>}
        </article>
        <i aria-hidden="true">→</i>
        <article className={scenario ? "scenario" : "not-applied"}>
          <span>{scenario ? "Scenario" : "Scenario not applied"}</span>
          <strong>{scenario ? scenarioValue ?? primaryValue : "Base retained"}</strong>
          <small>{scenario ? `${scenario.scenarioId}${scenarioDelta ? ` · ${scenarioDelta}` : ""}` : "No macro overlay entered this run"}</small>
        </article>
      </div>

      <div className="decide-reliability" aria-label="Result reliability">
        {reliability.map((item) => <article key={item.label}>
          <span>{item.label}</span><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}
        </article>)}
      </div>
    </section>

    {(uncertainty.length > 0 || sensitivities.length > 0) && <section className="decide-interpretation-grid">
      {uncertainty.length > 0 && <article className="decide-interpretation-card">
        <header><span>Uncertainty</span><h3>How wide is the answer?</h3></header>
        <div>{uncertainty.map((item) => <span key={item.label}><small>{item.label}</small><b>{item.value}</b>{item.detail && <em>{item.detail}</em>}</span>)}</div>
      </article>}
      {sensitivities.length > 0 && <article className="decide-interpretation-card">
        <header><span>Sensitivities</span><h3>What moves the answer?</h3></header>
        <div>{sensitivities.map((item) => <span key={item.label}><small>{item.label}</small><b>{item.value}</b>{item.detail && <em>{item.detail}</em>}</span>)}</div>
      </article>}
    </section>}

    {children}

    {evidence.length > 0 && <section className="decide-evidence">
      <header><span className="card-label"><i /> Technical evidence</span><p>Expand only when you need to audit or reproduce the decision.</p></header>
      {evidence.map((section) => <details key={section.title}>
        <summary><span><b>{section.title}</b><small>{section.summary}</small></span><i>+</i></summary>
        <div>{section.metrics.map((item) => <span key={`${section.title}-${item.label}`}><small>{item.label}</small><b>{item.value}</b>{item.detail && <em>{item.detail}</em>}</span>)}</div>
      </details>)}
    </section>}
  </div>;
}
