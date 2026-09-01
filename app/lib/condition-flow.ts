import type { Measure } from "./pde-spec.ts";

export type ConditionPrimaryActionKind =
  | "apply-market"
  | "open-market-controls"
  | "approve-inputs"
  | "continue-to-solve";

export interface ConditionPrimaryAction {
  kind: ConditionPrimaryActionKind;
  label: string;
}

export function isPendingBaseApplication(input: {
  hasSnapshot: boolean;
  appliedMarketSnapshot: boolean;
  compatibilityIssueCount: number;
}): boolean {
  return input.hasSnapshot && !input.appliedMarketSnapshot && input.compatibilityIssueCount === 0;
}

export function deriveConditionPrimaryAction(input: {
  hasUnappliedSnapshot: boolean;
  canApplyMarket: boolean;
  selectedChangeCount: number;
  requiredMeasure: Measure;
  conditioningApproved: boolean;
}): ConditionPrimaryAction {
  if (input.hasUnappliedSnapshot) {
    return input.canApplyMarket
      ? { kind: "apply-market", label: `Apply ${input.selectedChangeCount} changes to ${input.requiredMeasure} base` }
      : { kind: "open-market-controls", label: "Open market-data controls" };
  }
  return input.conditioningApproved
    ? { kind: "continue-to-solve", label: "Continue to Solve" }
    : { kind: "approve-inputs", label: "Approve market base" };
}
