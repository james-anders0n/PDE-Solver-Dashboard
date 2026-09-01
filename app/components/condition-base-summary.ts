import { createElement as h } from "react";
import type { CaseMarketBase } from "../lib/case-state.ts";
import type { ConditionBasePresentation } from "../lib/condition-presentation.ts";

const displayTime = (value: string | null | undefined) => {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : `${parsed.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
};

export function ConditionBaseSummary({
  presentation,
  marketBase,
  active,
}: {
  presentation: ConditionBasePresentation;
  marketBase: CaseMarketBase;
  active: boolean;
}) {
  return h("article", {
    "data-model": presentation.model,
    "data-required-measure": presentation.requiredMeasure,
  },
  h("span", { className: `measure-badge ${presentation.badgeClass}` }, presentation.badge),
  h("div", null,
    h("span", { className: "condition-measure-title" },
      h("b", null, presentation.title),
      h("button", { type: "button", className: "condition-measure-help", "aria-label": `Show explanation for ${presentation.title}` }, "i"),
    ),
    h("p", { className: "condition-measure-details" }, presentation.description),
    h("small", null, `${marketBase.source.toUpperCase()} · ${marketBase.snapshotId ?? "no snapshot"} · ${displayTime(marketBase.appliedAt ?? marketBase.asOfDate)}`),
  ),
  h("strong", null, active ? "BASE ACTIVE" : "BASE REVIEW"));
}
