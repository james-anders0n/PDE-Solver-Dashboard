import assert from "node:assert/strict";
import test from "node:test";

import { EconomicBridgeValidationError } from "../app/lib/economic-bridge.ts";
import {
  CPI_POLICY_ADAPTER_VERSION,
  createCpiPdeScenarioHandoff,
} from "../app/lib/economic-forecast/cpi-scenario.ts";
import { ECONOMIC_FORECAST_FIXTURE } from "../app/lib/economic-forecast/fixtures.ts";

const acceptedSnapshot = () => ({
  ...structuredClone(ECONOMIC_FORECAST_FIXTURE),
  status: "accepted" as const,
  freshness: "current" as const,
  distribution: {
    ...structuredClone(ECONOMIC_FORECAST_FIXTURE.distribution),
    status: "accepted" as const,
    accepted: true,
  },
});

test("CPI is transformed into a versioned policy-rate forecast before buildEconomicBridge maps a scenario", () => {
  const calibrated = { rate: "0.05", volatility: "0.2" };
  const handoff = createCpiPdeScenarioHandoff({
    snapshot: acceptedSnapshot(),
    model: "Black–Scholes",
    calibratedParameters: calibrated,
    quantile: "p50",
  });

  assert.equal(handoff.adapterVersion, CPI_POLICY_ADAPTER_VERSION);
  assert.equal(handoff.eligible, true);
  assert.equal(handoff.bridge.calibratedParameters.rate, "0.05");
  assert.equal(handoff.bridge.scenarios[0].transformations[0].sourceInputId.startsWith("policy-rate-"), true);
  assert.equal(handoff.bridge.scenarios[0].transformations[0].targetParameter, "rate");
  assert.equal(handoff.bridge.scenarios[0].transformations[0].measure, "Q");
  assert.notEqual(handoff.bridge.scenarios[0].parameters.rate, calibrated.rate);
  assert.match(handoff.adapterFormula, /r_policy/);
  assert.match(handoff.mappingVersion, /cpi-to-policy-rate@1\.0\.0/);
});

test("the same snapshot, quantile, mapping, and base set reproduce the identical handoff", () => {
  const options = {
    snapshot: acceptedSnapshot(),
    model: "Vasicek" as const,
    calibratedParameters: { longRunRate: "0.04", shortRate: "0.03" },
    quantile: "p90" as const,
  };
  assert.deepEqual(createCpiPdeScenarioHandoff(options), createCpiPdeScenarioHandoff(options));
});

test("policy bounds are recorded and clamp before the scenario reaches PDE mapping", () => {
  const snapshot = acceptedSnapshot();
  snapshot.distribution.p90Pct = 5;
  const handoff = createCpiPdeScenarioHandoff({
    snapshot,
    model: "HJB",
    calibratedParameters: { rate: "0.03", expectedReturn: "0.08", volatility: "0.2" },
    quantile: "p90",
  });
  assert.equal(handoff.policyRateClamped, true);
  assert.equal(handoff.scenarioInputs.policyRateForecast, 0.15);
  assert.equal(handoff.affectedParameters[0].measure, "P");
  assert.equal(handoff.bridge.calibratedParameters.rate, "0.03");
});

test("look-ahead timestamps are rejected by the reused economic bridge", () => {
  const snapshot = acceptedSnapshot();
  snapshot.latestObservation.availableTimestamp = "2026-07-20T00:00:00Z";
  assert.throws(
    () => createCpiPdeScenarioHandoff({ snapshot, model: "Black–Scholes", calibratedParameters: { rate: "0.05" } }),
    EconomicBridgeValidationError,
  );
});

test("sample or stale distributions can be reviewed but cannot be applied", () => {
  const handoff = createCpiPdeScenarioHandoff({
    snapshot: ECONOMIC_FORECAST_FIXTURE,
    model: "Black–Scholes",
    calibratedParameters: { rate: "0.05" },
  });
  assert.equal(handoff.eligible, false);
  assert.ok(handoff.blockingIssues.some((issue) => /cached research fixture/i.test(issue)));
  assert.ok(handoff.blockingIssues.some((issue) => /not passed the acceptance contract/i.test(issue)));
});
