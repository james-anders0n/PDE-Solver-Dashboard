import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEconomicBridge,
  DEFAULT_ECONOMIC_BRIDGE_INPUT,
  EconomicBridgeValidationError,
  validateEconomicBridgeInput,
  type EconomicBridgeInput,
} from "../app/lib/economic-bridge.ts";

const cloneDefault = (): EconomicBridgeInput => structuredClone(DEFAULT_ECONOMIC_BRIDGE_INPUT);

test("the published point-in-time fixture is valid and fully traceable", () => {
  const input = cloneDefault();
  assert.deepEqual(validateEconomicBridgeInput(input), []);
  const result = buildEconomicBridge(input, "HJB", {
    expectedReturn: 0.06,
    volatility: 0.18,
    rate: 0.03,
    riskAversion: 3,
  });

  assert.equal(result.audit.lookAheadChecked, true);
  assert.equal(result.audit.probabilitySum, 1);
  assert.equal(result.scenarios.length, 3);
  assert.deepEqual(result.calibratedParameters, {
    expectedReturn: 0.06,
    volatility: 0.18,
    rate: 0.03,
    riskAversion: 3,
  });
  for (const scenario of result.scenarios) {
    assert.equal(scenario.transformations.length, input.forecasts.length);
    assert.ok(scenario.probabilityProvenance.sourceModelVersion.includes("Regime Classifier"));
    for (const transformation of scenario.transformations) {
      assert.ok(transformation.formula.length > 0);
      assert.ok(transformation.financialInterpretation.length > 0);
      assert.ok(transformation.availableTimestamp <= input.runAsOfTimestamp);
      assert.equal(transformation.mappingVersion, "macro-to-pde 1.0.0");
    }
  }

  const baseline = result.scenarios.find((scenario) => scenario.id === "baseline")!;
  assert.equal(baseline.parameters.expectedReturn, 0.08);
  assert.equal(baseline.parameters.volatility, 0.2);
  assert.equal(baseline.parameters.rate, 0.035);
  assert.equal(result.calibratedParameters.expectedReturn, 0.06, "scenario mapping must not mutate the calibrated set");
});

test("pricing bridges exclude forecast equity drift and retain calibrated parameters", () => {
  const result = buildEconomicBridge(cloneDefault(), "Heston", {
    rate: 0.045,
    v0: 0.07,
    kappa: 1.7,
    theta: 0.05,
    xi: 0.4,
    rho: -0.6,
  });
  const baseline = result.scenarios.find((scenario) => scenario.id === "baseline")!;
  const equityReturn = baseline.transformations.find((item) => item.sourceInputId === "equity-return-12m")!;
  const volatility = baseline.transformations.find((item) => item.sourceInputId === "equity-volatility-12m")!;

  assert.equal(equityReturn.targetSet, "excluded");
  assert.equal(equityReturn.targetParameter, null);
  assert.match(equityReturn.financialInterpretation, /cannot replace the risk-neutral drift/i);
  assert.equal(volatility.targetParameter, "v0");
  assert.ok(Math.abs(Number(baseline.parameters.v0) - 0.04) < 1e-14);
  assert.equal(result.calibratedParameters.v0, 0.07);
  assert.equal(result.calibratedParameters.rate, 0.045);
});

test("look-ahead leakage and invalid probability or uncertainty combinations are rejected", () => {
  const input = cloneDefault();
  input.forecasts[0].availableTimestamp = "2026-08-21T00:00:00Z";
  input.forecasts[1].uncertainty = { ...input.forecasts[1].uncertainty, lower: 0.25 };
  input.regimes[0].probability = 0.7;
  input.regimes[1].volatilityMultiplier = 0;
  const issues = validateEconomicBridgeInput(input);

  assert.ok(issues.some((issue) => /look-ahead leakage/i.test(issue)));
  assert.ok(issues.some((issue) => /point forecast must lie inside/i.test(issue)));
  assert.ok(issues.some((issue) => /probabilities must sum to one/i.test(issue)));
  assert.ok(issues.some((issue) => /volatility multiplier must be positive/i.test(issue)));
  assert.throws(
    () => buildEconomicBridge(input, "HJB", {}),
    (error: unknown) => error instanceof EconomicBridgeValidationError && error.issues.length >= 4,
  );
});

test("constrained mappings enforce the executable parameter domains", () => {
  const input = cloneDefault();
  const returnForecast = input.forecasts.find((forecast) => forecast.variable === "equity-return")!;
  returnForecast.value = 10;
  returnForecast.uncertainty.lower = 5;
  returnForecast.uncertainty.upper = 12;
  const result = buildEconomicBridge(input, "HJB", { expectedReturn: 0.08 });
  const baselineReturn = result.scenarios[0].transformations.find((item) => item.targetParameter === "expectedReturn")!;

  assert.equal(baselineReturn.rawMappedValue, 10);
  assert.equal(baselineReturn.mappedValue, 2);
  assert.equal(baselineReturn.constrained, true);
  assert.deepEqual(baselineReturn.mappedInterval, [2, 2]);
});

