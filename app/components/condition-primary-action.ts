import { createElement } from "react";
import type { ConditionPrimaryAction as ConditionPrimaryActionValue } from "../lib/condition-flow.ts";

export function ConditionPrimaryAction({ action, onAction }: {
  action: ConditionPrimaryActionValue;
  onAction(): void;
}) {
  return createElement("button", {
    type: "button",
    "data-condition-action": action.kind,
    onClick: onAction,
  }, action.label);
}
