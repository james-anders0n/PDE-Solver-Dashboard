import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ECONOMIC_FORECAST_FIXTURE } from "../app/lib/economic-forecast/fixtures.ts";
import {
  createParameterUncertaintyKey,
  runParameterUncertaintyPropagation,
  type ParameterUncertaintyRequest,
} from "../app/lib/parameter-uncertainty.ts";
import type { SolverJob } from "../app/lib/solver-jobs.ts";

const acceptedSnapshot = () => ({
  ...structuredClone(ECONOMIC_FORECAST_FIXTURE),
  status: "accepted" as const,
  freshness: "current" as const,
  distribution: { ...structuredClone(ECONOMIC_FORECAST_FIXTURE.distribution), status: "accepted" as const, accepted: true },
});

const baseJob: SolverJob = {
  model: "Black–Scholes",
  request: {
    spot: 100,
    strike: 100,
    maturity: 1,
    rate: 0.05,
    dividend: 0,
    volatility: 0.2,
    side: "Call",
    contract: "european",
    spaceSteps: 30,
    timeSteps: 30,
    scheme: "rannacher-cn",
    gridKind: "nonuniform",
  },
};

const request = (sampleBudget = 32): ParameterUncertaintyRequest => ({
  snapshot: acceptedSnapshot(),
  baseJob,
  config: { sampleBudget, seed: 20260824, outputHistogramBins: 16 },
  convergenceGate: {
    accepted: true,
    source: "current deterministic PDE result",
    pointwiseError: 0.0001,
    maxNormError: 0.001,
    domainExpansionDelta: 0.0002,
    observedOrder: 1.9,
  },
});

test("every CPI sample is traceable through the versioned adapter to one deterministic PDE result", () => {
  const result = runParameterUncertaintyPropagation(request());
  assert.equal(result.classification, "parameter-uncertainty propagation");
  assert.match(result.disclaimer, /Neither a risk-neutral price-path simulation/);
  assert.equal(result.traces.length, 32);
  assert.equal(result.histogram.reduce((sum, bin) => sum + bin.count, 0), 32);
  assert.equal(result.dependenceMethod, "single CPI variable; no independence assumption");
  assert.ok(result.traces.every((trace) => trace.targetParameter === "rate"));
  assert.ok(result.traces.every((trace) => Number.isFinite(trace.cpiOutcomePct) && Number.isFinite(trace.mappedParameterValue) && Number.isFinite(trace.deterministicOutput)));
  assert.ok(result.traces.every((trace) => trace.mappingVersion === result.mappingVersion));
  assert.equal(baseJob.request.rate, 0.05, "propagation must not mutate the calibrated base request");
});

test("identical distributions, seeds, mappings and budgets reproduce identical outputs", () => {
  assert.deepEqual(runParameterUncertaintyPropagation(request()), runParameterUncertaintyPropagation(request()));
});

test("larger deterministic sample budget produces stable summary statistics", () => {
  const smaller = runParameterUncertaintyPropagation(request(32));
  const larger = runParameterUncertaintyPropagation(request(128));
  assert.equal(larger.stability.stable, true);
  assert.ok(Math.abs(larger.summary.mean - smaller.summary.mean) < 0.05);
  assert.ok(Math.abs(larger.summary.p50 - smaller.summary.p50) < 0.1);
});

test("cache identity includes source distribution, mapping inputs, budget and seed", () => {
  const base = request();
  assert.notEqual(createParameterUncertaintyKey(base), createParameterUncertaintyKey({ ...base, config: { ...base.config, seed: 7 } }));
  assert.notEqual(createParameterUncertaintyKey(base), createParameterUncertaintyKey({ ...base, config: { ...base.config, sampleBudget: 64 } }));
  const changedDistribution = acceptedSnapshot();
  changedDistribution.distribution.seed += 1;
  assert.notEqual(createParameterUncertaintyKey(base), createParameterUncertaintyKey({ ...base, snapshot: changedDistribution }));
});

test("unaccepted sources, failed convergence and path Monte Carlo are rejected", () => {
  assert.throws(() => runParameterUncertaintyPropagation({ ...request(), snapshot: ECONOMIC_FORECAST_FIXTURE }), /current accepted forecast distribution/);
  assert.throws(() => runParameterUncertaintyPropagation({ ...request(), convergenceGate: { ...request().convergenceGate, accepted: false } }), /convergence gate/);
  assert.throws(() => runParameterUncertaintyPropagation({
    ...request(),
    baseJob: { ...baseJob, monteCarlo: { model: "Black–Scholes", enabled: true, paths: 1000, timeSteps: 10, seed: 1, scheme: "exact-gbm", displayPathLimit: 10, quantileLevels: [0.1, 0.5, 0.9] } },
  }), /Path Monte Carlo must be disabled/);
});

test("the retained propagation implementation stays separate from path Monte Carlo and is not an active result tab", async () => {
  const [page, panel, worker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/parameter-uncertainty-results.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workers/parameter-uncertainty.worker.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /\["Overview"[^\n]+"Economic bridge"/);
  assert.match(panel, /PARAMETER-UNCERTAINTY PROPAGATION/);
  assert.match(panel, /NOT PATH MC/);
  assert.match(panel, /Neither a risk-neutral price-path simulation nor a market-calibrated price distribution/);
  assert.match(panel, /Trace every CPI sample/);
  assert.match(worker, /resultCache/);
  assert.match(worker, /createParameterUncertaintyKey/);
});
