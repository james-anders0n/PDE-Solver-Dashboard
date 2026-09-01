import type { CaseDefinition } from "./case-state.ts";
import { MODEL_KEYS, MODEL_SPECS, type ModelKey } from "./pde-spec.ts";

export function createDefaultCaseDefinition(options: {
  model: ModelKey;
  instrument: string;
  valuationDate: string;
  caseName?: string;
}): CaseDefinition {
  const model = MODEL_SPECS[options.model];
  const contract = model.contracts[0];
  return {
    caseName: options.caseName ?? `${options.instrument} · ${contract.label}`,
    instrument: options.instrument,
    valuationDate: options.valuationDate,
    model: options.model,
    contractId: contract.id,
    contractLabel: contract.label,
    side: contract.optionSides?.[0] ?? null,
    measure: model.measure,
    objective: contract.summary,
    confirmedAt: null,
  };
}

export function validateCaseDefinition(definition: CaseDefinition): string[] {
  const issues: string[] = [];
  if (!definition.caseName.trim()) issues.push("Enter a case name.");
  if (!definition.instrument.trim()) issues.push("Select an instrument.");
  if (!definition.valuationDate.trim()) {
    issues.push("Select a valuation date.");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(definition.valuationDate)
    || Number.isNaN(Date.parse(`${definition.valuationDate}T00:00:00Z`))) {
    issues.push("Enter a valid valuation date.");
  }
  if (!MODEL_KEYS.includes(definition.model)) {
    issues.push("Select a supported governing model.");
    return issues;
  }
  const model = MODEL_SPECS[definition.model];
  const contract = model.contracts.find((candidate) => candidate.id === definition.contractId);
  if (!contract) {
    issues.push(`Select a contract compatible with ${definition.model}.`);
  } else if (contract.optionSides?.length) {
    if (!definition.side || !contract.optionSides.includes(definition.side)) {
      issues.push(`Select an option side compatible with ${contract.label}.`);
    }
  } else if (definition.side !== null) {
    issues.push(`${contract.label} does not use an option side.`);
  }
  if (definition.measure !== model.measure) issues.push(`${definition.model} requires the ${model.measure}-measure.`);
  if (!definition.objective.trim()) issues.push("Define the case objective.");
  if (!definition.confirmedAt) issues.push("Save the problem definition before continuing.");
  else if (Number.isNaN(Date.parse(definition.confirmedAt))) issues.push("The problem-definition confirmation timestamp is invalid.");
  return issues;
}
