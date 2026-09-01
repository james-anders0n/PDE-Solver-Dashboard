import { MODEL_SPECS, type Measure, type ModelKey } from "./pde-spec.ts";

export interface ConditionBasePresentation {
  model: ModelKey;
  requiredMeasure: Measure;
  badge: string;
  badgeClass: "q" | "p" | "mixed";
  title: string;
  description: string;
  dependencyLabel: string;
  manualBaseLabel: string;
  storedBaseLabel: string;
  approvalLabel: string;
  scenarioGuardText: string;
}

export function getConditionBasePresentation(model: ModelKey, evidenceMeasure: Measure | null): ConditionBasePresentation {
  const requiredMeasure = MODEL_SPECS[model].measure;
  if (model === "HJB") {
    return {
      model,
      requiredMeasure,
      badge: "P",
      badgeClass: "p",
      title: "P-measure opportunity set",
      description: "Real-world return, volatility and funding inputs remain an auditable opportunity set for this decision branch.",
      dependencyLabel: "Opportunity set",
      manualBaseLabel: "Manual P opportunity set",
      storedBaseLabel: "Stored P opportunity set",
      approvalLabel: "Opportunity-set evidence",
      scenarioGuardText: "A physical-measure forecast is mapped into a separate decision branch; it never replaces the approved P opportunity set.",
    };
  }
  if (model === "Vasicek" && evidenceMeasure === "P") {
    return {
      model,
      requiredMeasure,
      badge: "P / Q",
      badgeClass: "mixed",
      title: "P historical scenario versus Q pricing base",
      description: "Historical P estimates may be saved as scenarios; only a documented Q calibration or manual Q inputs can enter the pricing base.",
      dependencyLabel: "Q pricing base",
      manualBaseLabel: "Manual Q pricing base",
      storedBaseLabel: "Stored Q pricing base",
      approvalLabel: "Historical P evidence and Q base",
      scenarioGuardText: "Historical P dynamics remain a separate scenario; they never overwrite the approved Q pricing base.",
    };
  }
  return {
    model,
    requiredMeasure,
    badge: "Q",
    badgeClass: "q",
    title: "Q-measure pricing base",
    description: "Risk-neutral pricing inputs remain an immutable, auditable base set for this branch.",
    dependencyLabel: "Q pricing base",
    manualBaseLabel: "Manual Q pricing base",
    storedBaseLabel: "Stored Q pricing base",
    approvalLabel: model === "Vasicek" ? "Q-calibration evidence" : "Market evidence",
    scenarioGuardText: "A physical-measure forecast is mapped into a separate solver-input branch; it never replaces the approved Q pricing base.",
  };
}
