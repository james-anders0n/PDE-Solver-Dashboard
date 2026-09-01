import { createElement } from "react";

export function EvidenceApplyStatus({ message }: { message: string | null }) {
  if (!message) return null;
  return createElement("div", { className: "condition-apply-completion", role: "status", tabIndex: -1 },
    createElement("b", null, "Applied — returned to Condition"),
    createElement("span", null, message),
  );
}

