import { createElement } from "react";

export function MissingBaseRunRecovery({ onRunMatchingBase }: { onRunMatchingBase(): void }) {
  return createElement("div", { className: "missing-base-run", role: "status" },
    createElement("strong", null, "Base run required"),
    createElement("small", null, "This scenario has no completed base run with the same definition, market snapshot, and solver settings. The action restores those base inputs and returns to Condition for approval."),
    createElement("button", { type: "button", className: "run-matching-base", onClick: onRunMatchingBase }, "Run matching base"),
  );
}
