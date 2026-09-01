import { createElement } from "react";

import type { CaseStatusSystem } from "../lib/case-state.ts";

const h = createElement;

function statusItem(label: string, value: string, state: string) {
  return h("span", { className: `case-status-item ${state}` },
    h("small", null, label),
    h("b", null, value),
  );
}

export function CaseStatusSummary({ status }: { status: CaseStatusSystem }) {
  return h("section", { className: "case-status-system", "aria-label": "Workflow and result status" },
    status.sampleResultLoaded
      ? h("div", { className: "sample-result-notice", role: "status" },
          h("b", null, "Sample result loaded"),
          h("span", null, "This bundled output is an example, not a result created in this session."),
        )
      : null,
    h("div", { className: "case-status-values" },
      statusItem("Result freshness", status.labels.resultFreshness, status.resultFreshness),
      statusItem("Workflow progress", status.labels.workflowProgress, status.workflowProgress),
      statusItem("Numerical acceptance", status.labels.numericalAcceptance, status.numericalAcceptance),
    ),
    h("details", { className: "case-status-legend" },
      h("summary", null, "Status guide"),
      h("dl", null,
        h("div", null,
          h("dt", null, "Result freshness"),
          h("dd", null, "Current matches the exact displayed inputs; stale belongs to earlier inputs; no result means no completed output exists."),
        ),
        h("div", null,
          h("dt", null, "Workflow progress"),
          h("dd", null, "Tracks whether the four-stage case flow has started, is underway, or is complete."),
        ),
        h("div", null,
          h("dt", null, "Numerical acceptance"),
          h("dd", null, "Passed met the numerical gates; review needs inspection; failed did not produce a usable result; not evaluated has no completed assessment."),
        ),
      ),
    ),
  );
}
