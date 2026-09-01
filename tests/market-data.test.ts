import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_KEYS, defaultParameters } from "../app/lib/pde-spec.ts";
import { blackScholesPrice } from "../app/lib/pde-engine/black-scholes.ts";
import {
  actual365YearFraction,
  acceptHestonCalibration,
  annualizedRealizedVolatility,
  annualToContinuous,
  applySnapshot,
  bracketFredRateSeries,
  buildBlackScholesSnapshot,
  buildHullWhiteCurveSnapshot,
  buildMertonOpportunitySnapshot,
  calibrateHestonSurface,
  calibrateVasicekQCurve,
  createFixtureSnapshot,
  createVasicekHistoricalScenario,
  createPartialLiveSnapshot,
  currencyIssue,
  defaultMarketRequest,
  estimateParityDividendYield,
  filterAndInvertOptions,
  freshnessFromDates,
  getMarketAdapter,
  HULL_WHITE_SERIES,
  MERTON_ECONOMIC_BRIDGE_MAPPING_VERSION,
  MERTON_OPPORTUNITY_ESTIMATOR_VERSION,
  HESTON_CALIBRATION_BOUNDS,
  HestonCalibrationCancelledError,
  estimateVasicekHistorical,
  impliedVolatilityFromPrice,
  interpolateFredRate,
  parseFredValue,
  percentToDecimal,
  prepareVasicekHistory,
  restoreSnapshotInputs,
  selectedChangedProposalIds,
  spreadAwareWeights,
} from "../app/lib/market-data/index.ts";
import {
  createDiscountCurve,
  hullWhiteTheta,
  validateDiscountCurvePillars,
} from "../app/lib/pde-engine/short-rate.ts";

test("normalises FRED missing values, percentages, compounding, dates, and freshness", () => {
  assert.equal(parseFredValue("."), null);
  assert.equal(parseFredValue(""), null);
  assert.equal(parseFredValue("4.25"), 4.25);
  assert.equal(percentToDecimal(4.25), 0.0425);
  assert.ok(Math.abs(annualToContinuous(0.05) - Math.log(1.05)) < 1e-14);
  assert.equal(actual365YearFraction("2026-01-01", "2027-01-01"), 1);
  assert.equal(freshnessFromDates("2026-08-23", "2026-08-21", 3), "current");
  assert.equal(freshnessFromDates("2026-08-23", "2026-08-10", 3), "stale");
});

test("currency compatibility fails closed unless proxy mode is confirmed", () => {
  assert.equal(currencyIssue("USD", "usd"), null);
  assert.match(currencyIssue("AUD", "USD") ?? "", /Currency mismatch/);
  assert.equal(currencyIssue("AUD", "USD", true), null);
});

function hullWhiteFredFixture(overrides: Partial<Record<string, number>> = {}) {
  const values: Record<string, number> = {
    SOFR: 4.31, DGS1MO: 4.28, DGS3MO: 4.25, DGS6MO: 4.20, DGS1: 4.12, DGS2: 4.02,
    DGS3: 4.00, DGS5: 4.08, DGS7: 4.18, DGS10: 4.30, DGS20: 4.54, DGS30: 4.61,
    ...overrides,
  };
  return Object.entries(values).flatMap(([seriesId, value], index) => [
    { seriesId, date: "2026-08-19", value: value + 0.10, realtimeStart: "2026-08-20", realtimeEnd: "2026-08-20" },
    { seriesId, date: index % 3 === 0 ? "2026-08-20" : "2026-08-21", value, realtimeStart: "2026-08-23", realtimeEnd: "2026-08-23" },
    { seriesId, date: "2026-08-24", value: value - 0.10, realtimeStart: "2026-08-24", realtimeEnd: "2026-08-24" },
  ]);
}

function mertonHistoryFixture(count = 320, missingIndex?: number) {
  const dates: string[] = [];
  let time = Date.parse("2025-05-01T00:00:00Z");
  while (dates.length < count + (missingIndex == null ? 0 : 1)) {
    const date = new Date(time);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    time += 86_400_000;
  }
  if (missingIndex != null) dates.splice(missingIndex, 1);
  let adjustedClose = 100;
  return dates.slice(0, count).map((date, index) => {
    const simpleReturn = index === 0 ? 0 : index % 2 === 0 ? 0.003 : 0.001;
    adjustedClose *= 1 + simpleReturn;
    return { date, close: adjustedClose, adjustedClose, volume: 1_000_000, dividends: index === 63 ? 0.25 : 0, splits: index === 126 ? 2 : 0 };
  });
}

function mertonFredFixture(asOfDate = "2026-08-21") {
  return [
    { seriesId: "SOFR", date: "2026-08-19", value: 4.3, realtimeStart: asOfDate, realtimeEnd: asOfDate, availableDate: "2026-08-20" },
    { seriesId: "VIXCLS", date: "2026-08-19", value: 18, realtimeStart: asOfDate, realtimeEnd: asOfDate, availableDate: "2026-08-20" },
    { seriesId: "T10Y2Y", date: "2026-08-19", value: 0.4, realtimeStart: asOfDate, realtimeEnd: asOfDate, availableDate: "2026-08-20" },
  ];
}

test("Merton adjusted total returns, annualization, volatility windows, actions, and missing sessions are explicit", () => {
  const request = { ...defaultMarketRequest("HJB"), hjbHistorySessions: 252 as const, hjbEstimator: "arithmetic" as const, hjbVolatilityWindow: 60 as const };
  const current = defaultParameters("HJB", "merton-allocation");
  const snapshot = buildMertonOpportunitySnapshot({
    request,
    currentParameters: current,
    quote: { symbol: "AAPL", currency: "USD", timezone: "America/New_York", regularMarketPrice: 150, regularMarketTime: "2026-08-21T20:00:00Z" },
    history: mertonHistoryFixture(260, 120),
    historyCurrency: "USD",
    fred: mertonFredFixture(),
  });
  const details = snapshot.mertonOpportunity!;
  assert.equal(details.estimatorVersion, MERTON_OPPORTUNITY_ESTIMATOR_VERSION);
  assert.ok(Math.abs(details.returns[0].logReturn - Math.log1p(0.003)) < 1e-12);
  assert.ok(Math.abs(details.returnEstimates.arithmetic.value - 0.504) < 1e-12);
  assert.ok(details.realisedVolatility["20"]! > 0);
  assert.ok(details.realisedVolatility["60"]! > 0);
  assert.ok(details.realisedVolatility["126"]! > 0);
  assert.ok(details.realisedVolatility["252"]! > 0);
  assert.equal(details.adjustments.dividendEvents, 1);
  assert.equal(details.adjustments.splitEvents, 1);
  assert.ok(details.calendar.missingWeekdaySessions.length >= 1);
  assert.ok(snapshot.warnings.some((warning) => /weekday gaps/i.test(warning)));
});

test("Merton arithmetic, EWMA, and shrinkage estimators preserve uncertainty and the explicit prior weight", () => {
  const current = defaultParameters("HJB", "merton-allocation");
  const history = mertonHistoryFixture();
  const fred = mertonFredFixture();
  const base = { ...defaultMarketRequest("HJB"), hjbHistorySessions: 252 as const, hjbShrinkageWeight: 0.25, hjbEquityRiskPremiumPrior: 0.05 };
  const arithmetic = buildMertonOpportunitySnapshot({ request: { ...base, hjbEstimator: "arithmetic" }, currentParameters: current, history, historyCurrency: "USD", fred });
  const ewma = buildMertonOpportunitySnapshot({ request: { ...base, hjbEstimator: "ewma" }, currentParameters: current, history, historyCurrency: "USD", fred });
  const shrinkage = buildMertonOpportunitySnapshot({ request: { ...base, hjbEstimator: "shrinkage" }, currentParameters: current, history, historyCurrency: "USD", fred });
  const details = shrinkage.mertonOpportunity!;
  const expected = 0.25 * details.returnEstimates.arithmetic.value + 0.75 * (0.043 + 0.05);
  assert.equal(arithmetic.proposals[0].proposedValue, arithmetic.mertonOpportunity!.returnEstimates.arithmetic.value.toFixed(8));
  assert.equal(ewma.proposals[0].proposedValue, ewma.mertonOpportunity!.returnEstimates.ewma.value.toFixed(8));
  assert.ok(Math.abs(details.returnEstimates.shrinkage.value - expected) < 1e-14);
  assert.equal(details.returnEstimates.shrinkage.historicalWeight, 0.25);
  assert.ok(details.returnEstimates.shrinkage.lower < details.returnEstimates.shrinkage.value);
  assert.ok(details.returnEstimates.shrinkage.value < details.returnEstimates.shrinkage.upper);
});

test("Merton regime maps are versioned, probability-valid, P-classified, and preview control bounds", () => {
  const current = { ...defaultParameters("HJB", "merton-allocation"), controlMin: "-10", controlMax: "20" };
  const snapshot = buildMertonOpportunitySnapshot({ request: defaultMarketRequest("HJB"), currentParameters: current, history: mertonHistoryFixture(520), historyCurrency: "USD", fred: mertonFredFixture() });
  const details = snapshot.mertonOpportunity!;
  assert.equal(details.mappingVersion, MERTON_ECONOMIC_BRIDGE_MAPPING_VERSION);
  assert.deepEqual(details.bridgeInput.regimes.map((item) => item.id), ["baseline", "expansion", "defensive", "stress"]);
  assert.ok(Math.abs(details.bridgeInput.regimes.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-14);
  assert.ok(details.bridgeInput.regimes.every((item) => item.probability >= item.uncertainty.lower && item.probability <= item.uncertainty.upper));
  assert.ok(details.allocationPreviews.some((item) => item.binding !== "none"));
  assert.ok(details.allocationPreviews.every((item) => item.appliedAllocation >= -10 && item.appliedAllocation <= 20));
  assert.ok(snapshot.proposals.every((item) => item.provenance.measure === "P"));
  assert.equal(snapshot.proposals.find((item) => item.id === "excessReturn")?.applicable, false);
  assert.equal(snapshot.proposals.find((item) => item.id === "analyticAllocation")?.applicable, false);
  assert.ok(snapshot.warnings.some((warning) => /VIXCLS.*not.*realised volatility/i.test(warning)));
});

test("Merton point-in-time selection excludes unavailable FRED observations", () => {
  const request = defaultMarketRequest("HJB");
  const fred = [
    ...mertonFredFixture(),
    { seriesId: "VIXCLS", date: "2026-08-21", value: 80, realtimeStart: "2026-08-21", realtimeEnd: "2026-08-21", availableDate: "2026-08-24" },
    { seriesId: "SOFR", date: "2026-08-21", value: 9, realtimeStart: "2026-08-21", realtimeEnd: "2026-08-21", availableDate: "2026-08-24" },
  ];
  const snapshot = buildMertonOpportunitySnapshot({ request, currentParameters: defaultParameters("HJB", "merton-allocation"), history: mertonHistoryFixture(520), historyCurrency: "USD", fred });
  assert.equal(snapshot.mertonOpportunity!.opportunityRate.value, 0.043);
  assert.equal(snapshot.mertonOpportunity!.regimeObservations.find((item) => item.seriesId === "VIXCLS")?.value, 18);
  assert.ok(snapshot.observations.every((item) => item.availableTimestamp <= `${request.asOfDate}T23:59:59Z`));
});

test("Merton USD opportunity rates reject currency mismatch unless explicit proxy mode is selected", () => {
  const current = defaultParameters("HJB", "merton-allocation");
  const request = { ...defaultMarketRequest("HJB"), currency: "AUD" };
  assert.throws(() => buildMertonOpportunitySnapshot({ request, currentParameters: current, history: mertonHistoryFixture(520), historyCurrency: "AUD", fred: mertonFredFixture() }), /explicit proxy mode/i);
  const snapshot = buildMertonOpportunitySnapshot({ request: { ...request, hjbUsdRateProxyMode: true }, currentParameters: current, history: mertonHistoryFixture(520), historyCurrency: "AUD", fred: mertonFredFixture() });
  assert.equal(snapshot.mertonOpportunity!.opportunityRate.proxy, true);
  assert.equal(snapshot.proposals.find((item) => item.id === "rate")?.classification, "proxy");
  assert.ok(snapshot.warnings.some((warning) => /proxy mode is active/i.test(warning)));
});

test("Hull–White aligns previous-valid FRED pillars and builds a serializable positive Treasury proxy curve", () => {
  const request = defaultMarketRequest("Hull–White");
  const current = defaultParameters("Hull–White", "zero-coupon-bond");
  const snapshot = buildHullWhiteCurveSnapshot({ request, currentParameters: current, fred: hullWhiteFredFixture() });
  assert.ok(snapshot.hullWhite);
  const details = snapshot.hullWhite!;
  assert.equal(details.curve.pillars[0].time, 0);
  assert.equal(details.curve.pillars[0].discount, 1);
  assert.equal(details.proxyStatus, "PROXY");
  assert.equal(details.interpolation, "natural-cubic-log-discount");
  assert.equal(details.pillars.length, HULL_WHITE_SERIES.length);
  assert.ok(details.pillars.every((pillar) => pillar.quoteDate <= request.asOfDate));
  assert.ok(details.pillars.some((pillar) => pillar.quoteDate === "2026-08-20"));
  assert.ok(details.pillars.some((pillar) => pillar.quoteDate === "2026-08-21"));
  assert.ok(details.curve.pillars.every((pillar) => Number.isFinite(pillar.discount) && pillar.discount > 0));
  assert.ok(details.curve.pillars.every((pillar, index) => index === 0 || pillar.time > details.curve.pillars[index - 1].time));
  assert.ok(details.curve.pillars.every((pillar, index) => index === 0 || pillar.discount <= details.curve.pillars[index - 1].discount));
  assert.ok(Number.isFinite(details.frontRate));
  assert.equal(typeof structuredClone(details.curve).pillars[1].discount, "number");
  assert.ok(snapshot.warnings.some((warning) => /never called an OIS/i.test(warning)));
});

test("Hull–White bootstrap documents instruments and reproduces its deterministic curve fixture", () => {
  const request = { ...defaultMarketRequest("Hull–White"), hullWhiteCurveMode: "bootstrap" as const };
  const current = defaultParameters("Hull–White", "zero-coupon-bond");
  const snapshot = buildHullWhiteCurveSnapshot({ request, currentParameters: current, fred: hullWhiteFredFixture() });
  const details = snapshot.hullWhite!;
  assert.equal(details.mode, "bootstrap");
  assert.ok(details.pillars.some((pillar) => pillar.compounding === "simple"));
  assert.ok(details.pillars.some((pillar) => pillar.compounding === "semiannual"));
  assert.ok(details.constructionNotes.some((note) => /coupon-date discounts/i.test(note)));
  assert.ok(details.maximumFitErrorBasisPoints < 1e-7);
  assert.ok(details.pillars.every((pillar) => Math.abs(pillar.reproductionError) < 1e-10));
});

test("Hull–White rejects missing front anchors, currency mismatch, stale data, and severe non-monotonicity", () => {
  const current = defaultParameters("Hull–White", "zero-coupon-bond");
  const request = defaultMarketRequest("Hull–White");
  assert.throws(() => buildHullWhiteCurveSnapshot({
    request: { ...request, hullWhiteSelectedSeries: ["DGS3MO", "DGS6MO", "DGS1", "DGS2"] },
    currentParameters: current,
    fred: hullWhiteFredFixture(),
  }), /front anchor/i);
  assert.throws(() => buildHullWhiteCurveSnapshot({
    request: { ...request, currency: "AUD" }, currentParameters: current, fred: hullWhiteFredFixture(),
  }), /Currency mismatch/i);
  assert.throws(() => buildHullWhiteCurveSnapshot({
    request: { ...request, hullWhiteMaximumQuoteAgeDays: 0 }, currentParameters: current, fred: hullWhiteFredFixture(),
  }), /staleness/i);
  assert.throws(() => buildHullWhiteCurveSnapshot({
    request: { ...request, hullWhiteSelectedSeries: ["DGS1MO", "DGS3MO", "DGS6MO", "DGS1"], hullWhiteCurveFamily: "treasury" },
    currentParameters: current,
    fred: hullWhiteFredFixture({ DGS1MO: 8, DGS3MO: -8, DGS6MO: -8, DGS1: -8 }),
  }), /non-monotonicity/i);
});

test("Hull–White interpolation, validation, theta reconstruction, and curve-only parameter mapping remain guarded", () => {
  assert.throws(() => validateDiscountCurvePillars([{ time: 0, discount: 1 }, { time: 0.5, discount: 0.98 }, { time: 1, discount: 0 }]), /positive/i);
  assert.throws(() => validateDiscountCurvePillars([{ time: 0, discount: 1 }, { time: 2, discount: 0.9 }, { time: 1, discount: 0.95 }]), /increasing/i);
  const request = { ...defaultMarketRequest("Hull–White"), hullWhiteIncludeEtfOptions: true };
  const current = defaultParameters("Hull–White", "zero-coupon-bond");
  const snapshot = createFixtureSnapshot(request, current);
  const details = snapshot.hullWhite!;
  const curve = createDiscountCurve(details.curve.id, details.curve.pillars);
  details.curve.pillars.forEach((pillar) => assert.ok(Math.abs(curve.discount(pillar.time) - pillar.discount) < 1e-12));
  assert.ok([0, 0.25, 3, 12, 30].every((time) => Number.isFinite(hullWhiteTheta({
    shortRate: details.frontRate,
    meanReversion: Number(current.meanReversion),
    rateVolatility: Number(current.rateVolatility),
    curve,
  }, time))));
  assert.equal(snapshot.proposals.find((item) => item.id === "meanReversion")?.selected, false);
  assert.equal(snapshot.proposals.find((item) => item.id === "rateVolatility")?.proposedValue, current.rateVolatility);
  assert.equal(details.etfOptionProxies.length, 3);
  assert.ok(details.etfOptionProxies.every((item) => item.classification === "rate-volatility-scenario-proxy" && /not swaptions/i.test(item.warning)));
  const applied = applySnapshot(current, snapshot, new Set(["curveId", "shortRate"]), "2026-08-23T23:30:00Z");
  assert.equal(applied.parameters.curveId, details.curve.id);
  assert.equal(applied.parameters.shortRate, details.frontRate.toFixed(8));
  assert.equal(applied.parameters.meanReversion, current.meanReversion);
  assert.equal(applied.parameters.rateVolatility, current.rateVolatility);
});

test("every model adapter creates a deterministic model-tailored preview without mutating inputs", async () => {
  for (const model of MODEL_KEYS) {
    const contract = model === "Heston" ? "european" : model === "Vasicek" || model === "Hull–White" ? "zero-coupon-bond" : model === "HJB" ? "merton-allocation" : "european";
    const parameters = defaultParameters(model, contract);
    const original = structuredClone(parameters);
    const request = defaultMarketRequest(model);
    const first = await getMarketAdapter(model).preview(request, parameters);
    const second = await getMarketAdapter(model).preview(request, parameters);
    assert.deepEqual(parameters, original, `${model} preview mutated solver parameters`);
    assert.deepEqual(first, second, `${model} fixture is not deterministic`);
    assert.equal(first.model, model);
    assert.ok(first.primarySeries.length > 0);
    if (model === "Heston") assert.equal(first.secondarySeries.length, 0, "uncalibrated Heston previews must not fabricate residuals");
    else assert.ok(first.secondarySeries.length > 0);
    assert.ok(first.proposals.length > 0);
    assert.ok(first.observations.every((item) => item.observationTimestamp && item.availableTimestamp));
  }
});

test("apply changes only selected valid rows, records lineage, and restore recovers previous inputs", () => {
  const request = defaultMarketRequest("Black–Scholes");
  const current = defaultParameters("Black–Scholes", "european");
  const snapshot = createFixtureSnapshot(request, current);
  const selected = new Set(["spot", "volatility"]);
  const result = applySnapshot(current, snapshot, selected, "2026-08-23T08:00:00Z");
  const spotProposal = snapshot.proposals.find((item) => item.id === "spot");
  const volatilityProposal = snapshot.proposals.find((item) => item.id === "volatility");
  assert.equal(current.spot, "100");
  assert.equal(result.parameters.spot, spotProposal?.proposedValue);
  assert.equal(result.parameters.volatility, volatilityProposal?.proposedValue);
  assert.equal(result.parameters.rate, current.rate);
  assert.deepEqual(result.history.selectedParameterIds, ["spot", "volatility"]);
  assert.ok(result.history.excludedParameterIds.includes("rate"));
  assert.deepEqual(restoreSnapshotInputs(result.history), current);
});

test("snapshots with validation errors cannot be applied", () => {
  const current = defaultParameters("Black–Scholes", "european");
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Black–Scholes"), current);
  snapshot.validationIssues.push("Currency mismatch");
  assert.throws(() => applySnapshot(current, snapshot, new Set(["spot"])), /validation errors/);
});

test("P/Q safeguards leave historical Vasicek estimates unselected and inapplicable", () => {
  const current = defaultParameters("Vasicek", "zero-coupon-bond");
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Vasicek"), current);
  const historical = snapshot.proposals.filter((item) => ["meanReversion", "longRunRate", "rateVolatility"].includes(item.id));
  assert.ok(historical.every((item) => item.provenance.measure === "P"));
  assert.ok(historical.every((item) => !item.selected && !item.applicable));
  assert.deepEqual(selectedChangedProposalIds(snapshot), ["shortRate"]);
});

test("seeded synthetic OU fixture recovers Vasicek P parameters within documented finite-sample tolerances", () => {
  const current = defaultParameters("Vasicek", "zero-coupon-bond");
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Vasicek"), current);
  const estimate = snapshot.vasicek!.pEstimate;
  assert.ok(Math.abs(estimate.parameters.meanReversion - 0.72) < 0.25, "aᴾ recovery exceeded tolerance 0.25");
  assert.ok(Math.abs(estimate.parameters.longRunRate - 0.043) < 0.003, "bᴾ recovery exceeded tolerance 0.003");
  assert.ok(Math.abs(estimate.parameters.rateVolatility - 0.0115) < 0.002, "σᵣᴾ recovery exceeded tolerance 0.002");
  assert.ok(estimate.intervals.meanReversion.lower > 0);
  assert.ok(estimate.intervals.rateVolatility.lower > 0);
  assert.equal(estimate.measure, "P");
  assert.ok(snapshot.vasicek!.removedObservations.length > 0, "fixture outlier policy should retain removal reasons");
});

test("Vasicek history preparation makes missing-day, resampling, and outlier policies explicit", () => {
  const observations = [
    { date: "2026-01-05", value: 0.04 },
    { date: "2026-01-07", value: 0.0402 },
    { date: "2026-01-08", value: 0.09 },
    { date: "2026-01-09", value: 0.0401 },
    { date: "2026-01-12", value: 0.0403 },
    { date: "2026-01-13", value: 0.04025 },
  ];
  const carried = prepareVasicekHistory(observations, { windowStart: "2026-01-05", windowEnd: "2026-01-13", sampling: "daily", missingPolicy: "previous-valid", outlierPolicy: "remove-3sigma" });
  assert.equal(carried.find((item) => item.date === "2026-01-06")?.source, "carried");
  const weekly = prepareVasicekHistory(observations, { windowStart: "2026-01-05", windowEnd: "2026-01-13", sampling: "weekly", missingPolicy: "drop-gaps", outlierPolicy: "none" });
  assert.equal(weekly.length, 2);
  assert.ok(weekly[0].date > observations[0].date, "weekly sampling should retain the last available observation");
});

test("Vasicek estimator rejects insufficient and invalid histories", () => {
  const options = { windowStart: "2026-01-01", windowEnd: "2026-03-01", sampling: "daily" as const, missingPolicy: "drop-gaps" as const, outlierPolicy: "none" as const, minimumObservations: 20 };
  assert.throws(() => estimateVasicekHistorical([
    { date: "2026-01-05", value: 0.04, source: "observed", excluded: false },
    { date: "2026-01-06", value: 0.041, source: "observed", excluded: false },
  ], options), /at least 20/);
  const constant = Array.from({ length: 25 }, (_, index) => ({ date: `2026-01-${String(index + 1).padStart(2, "0")}`, value: 0.04, source: "observed" as const, excluded: false }));
  assert.throws(() => estimateVasicekHistorical(constant, options), /insufficient rate variation/);
});

test("historical Vasicek scenarios are immutable P records and cannot silently overwrite the Q base", () => {
  const current = defaultParameters("Vasicek", "zero-coupon-bond");
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Vasicek"), current);
  const scenario = createVasicekHistoricalScenario(snapshot, "2026-08-23T04:00:00Z");
  assert.equal(scenario.measure, "P");
  assert.deepEqual(current, defaultParameters("Vasicek", "zero-coupon-bond"));
  const application = applySnapshot(current, snapshot, new Set(selectedChangedProposalIds(snapshot)), "2026-08-23T04:01:00Z");
  assert.notEqual(application.parameters.shortRate, current.shortRate);
  assert.equal(application.parameters.meanReversion, current.meanReversion);
  assert.equal(application.parameters.longRunRate, current.longRunRate);
  assert.equal(application.parameters.rateVolatility, current.rateVolatility);
});

test("Vasicek Q-curve calibration is deterministic, bounded, and separate from the P estimate", () => {
  const request = { ...defaultMarketRequest("Vasicek"), vasicekMeasureMode: "q-curve" as const };
  const current = defaultParameters("Vasicek", "zero-coupon-bond");
  const first = createFixtureSnapshot(request, current);
  const second = createFixtureSnapshot(request, current);
  assert.deepEqual(first, second);
  const result = first.vasicek!.qCalibration!;
  assert.equal(result.measure, "Q");
  assert.ok(result.instruments.length >= 4);
  assert.ok(result.maximumError < 5e-4);
  for (const key of ["meanReversion", "longRunRate", "rateVolatility"] as const) {
    assert.ok(result.parameters[key] >= result.bounds[key][0] && result.parameters[key] <= result.bounds[key][1]);
  }
  assert.ok(first.proposals.filter((item) => item.id !== "shortRate").every((item) => item.provenance.measure === "Q" && item.applicable));
  assert.equal(first.vasicek!.pEstimate.measure, "P");
});

test("Vasicek Q calibration fails closed without adequate zero-coupon coverage", () => {
  assert.throws(() => calibrateVasicekQCurve({
    shortRate: 0.04,
    instruments: [{ id: "1Y", maturity: 1, price: 0.96 }, { id: "2Y", maturity: 2, price: 0.92 }],
    seed: { meanReversion: 0.5, longRunRate: 0.04, rateVolatility: 0.01 },
    completedAt: "2026-08-23T04:00:00Z",
  }), /at least four distinct/);
});

test("Treasury ETF histories stay visibly labelled PROXY and never become Vasicek parameter proposals", () => {
  const request = { ...defaultMarketRequest("Vasicek"), vasicekIncludeEtfs: true };
  const snapshot = createFixtureSnapshot(request, defaultParameters("Vasicek", "zero-coupon-bond"));
  assert.deepEqual(snapshot.vasicek!.etfOverlays.map((item) => item.symbol), ["SHY", "IEF", "TLT"]);
  assert.ok(snapshot.vasicek!.etfOverlays.every((item) => item.proxyLabel === "PROXY"));
  assert.ok(!snapshot.proposals.some((item) => ["SHY", "IEF", "TLT"].includes(item.id)));
  assert.match(snapshot.warnings.join(" "), /not zero-coupon bonds/i);
});

test("partial live snapshots retain only returned provider observations and disable unsupported inference", () => {
  const current = defaultParameters("Heston", "european");
  const request = { ...defaultMarketRequest("Heston"), sourceMode: "live" as const };
  const snapshot = createPartialLiveSnapshot({
    request,
    currentParameters: current,
    quote: { symbol: "AAPL", currency: "USD", timezone: "America/New_York", regularMarketPrice: 227.5, regularMarketTime: "2026-08-21T20:00:00Z" },
    fred: undefined,
    providerErrors: ["FRED unavailable"],
  });
  assert.equal(snapshot.freshness, "partial");
  assert.equal(snapshot.proposals.find((item) => item.id === "spot")?.proposedValue, "227.5");
  assert.equal(snapshot.proposals.find((item) => item.id === "v0")?.applicable, false);
  assert.equal(snapshot.observations.length, 1);
  assert.match(snapshot.freshnessMessage, /provider limitations/i);
});

test("Black–Scholes snapshot matches expiry, ACT/365F maturity, and forward ATM", () => {
  const request = defaultMarketRequest("Black–Scholes");
  const snapshot = createFixtureSnapshot(request, defaultParameters("Black–Scholes", "european"));
  const details = snapshot.blackScholes!;
  assert.equal(details.expiration, request.optionExpiration);
  assert.ok(Math.abs(Number(snapshot.proposals.find((item) => item.id === "maturity")?.proposedValue)
    - actual365YearFraction(request.asOfDate, details.expiration)) < 1e-8);
  const retained = snapshot.primarySeries.flatMap((series) => series.points).filter((point) => !point.excluded);
  const minimumDistance = Math.min(...retained.map((point) => Math.abs(Math.log(point.x / details.forward))));
  assert.ok(Math.abs(Math.abs(Math.log(details.atmStrike! / details.forward)) - minimumDistance) < 1e-12);
  assert.equal(retained.filter((point) => point.selected).length, 1);
  assert.match(snapshot.secondarySeries[0].label, /\(Q\)/);
  assert.match(snapshot.secondarySeries[1].label, /\(P\)/);
  assert.ok(details.instruments.length > 0);
  assert.ok(details.instruments.every((instrument) => instrument.ask >= instrument.bid));
  assert.ok(details.instruments.every((instrument) => instrument.maturity > 0));
  assert.ok(details.instruments.some((instrument) => Boolean(instrument.lastTradeTimestamp)));
  assert.notEqual(details.volatility.selectedImpliedVolatility, details.volatility.providerImpliedVolatility);
});

test("unavailable requested expiration falls back deterministically and remains explicit", () => {
  const request = { ...defaultMarketRequest("Black–Scholes"), optionExpiration: "2099-02-01" };
  const asOf = request.asOfDate;
  const snapshot = buildBlackScholesSnapshot({
    request,
    currentParameters: defaultParameters("Black–Scholes", "european"),
    quote: { symbol: "AAPL", currency: "USD", timezone: "America/New_York", regularMarketPrice: 100, regularMarketTime: `${asOf}T20:00:00Z` },
    history: [{ date: asOf, close: 100, adjustedClose: 100, volume: 1, dividends: 0, splits: 0 }],
    expirations: ["2027-02-19"], optionChain: [], optionCurrency: "USD",
  });
  assert.equal(snapshot.blackScholes?.expiration, "2027-02-19");
  assert.match(snapshot.warnings.join(" "), /was unavailable/);
});

test("FRED tenor matching interpolates continuously compounded decimal rates", () => {
  assert.deepEqual(bracketFredRateSeries(0.375), ["DGS3MO", "DGS6MO"]);
  const observations = [
    { seriesId: "DGS3MO", date: "2026-08-21", value: 4, realtimeStart: "2026-08-21", realtimeEnd: "2026-08-23" },
    { seriesId: "DGS6MO", date: "2026-08-21", value: 5, realtimeStart: "2026-08-21", realtimeEnd: "2026-08-23" },
  ];
  const result = interpolateFredRate(observations, 0.375, "2026-08-23", 0.03);
  const expected = (annualToContinuous(0.04) + annualToContinuous(0.05)) / 2;
  assert.equal(result.mode, "treasury-proxy");
  assert.ok(Math.abs(result.rate - expected) < 1e-14);
  assert.deepEqual(result.sourceSeries, ["DGS3MO", "DGS6MO"]);
  assert.equal(result.maximumObservationAgeDays, 2);
});

test("put-call parity recovers a reliable continuous dividend yield", () => {
  const spot = 100, maturity = 0.5, rate = 0.04, dividend = 0.017, volatility = 0.24;
  const contracts = [90, 100, 110].flatMap((strike) => (["call", "put"] as const).map((optionType) => {
    const price = blackScholesPrice({ spot, strike, maturity, rate, dividend, volatility, side: optionType === "call" ? "Call" : "Put" });
    return {
      contractSymbol: `${optionType}-${strike}`, optionType, expiration: "2027-02-19", strike,
      bid: price - 0.01, ask: price + 0.01, lastPrice: price, impliedVolatility: volatility,
      openInterest: 500, volume: 100, lastTradeTimestamp: "2026-08-23T19:00:00Z",
    };
  }));
  const result = estimateParityDividendYield({
    contracts, spot, maturity, rate, asOfDate: "2026-08-23", maximumRelativeSpread: 0.2,
    minimumOpenInterest: 25, forwardGuess: spot * Math.exp((rate - dividend) * maturity),
  });
  assert.equal(result.matchedPairs, 3);
  assert.ok(Math.abs(result.value! - dividend) < 1e-12);
});

test("quote filtering rejects bad structure, stale data, low liquidity, and no-arbitrage breaches", () => {
  const base = {
    optionType: "call" as const, expiration: "2027-02-19", strike: 100, bid: 6, ask: 6.1,
    lastPrice: 6.05, impliedVolatility: 0.2, openInterest: 100, volume: 20,
    lastTradeTimestamp: "2026-08-23T19:00:00Z",
  };
  const contracts = [
    { ...base, contractSymbol: "valid" },
    { ...base, contractSymbol: "zero", bid: 0 },
    { ...base, contractSymbol: "crossed", bid: 6.2, ask: 6.1 },
    { ...base, contractSymbol: "wide", bid: 1, ask: 6 },
    { ...base, contractSymbol: "illiquid", openInterest: 1 },
    { ...base, contractSymbol: "stale", lastTradeTimestamp: "2026-08-01T19:00:00Z" },
    { ...base, contractSymbol: "arbitrage", bid: 119, ask: 121, lastPrice: 120 },
  ];
  const result = filterAndInvertOptions({
    contracts, optionView: "combined", asOfDate: "2026-08-23", maximumRelativeSpread: 0.15,
    minimumOpenInterest: 25, spot: 100, maturity: 0.5, rate: 0.04, dividend: 0.01,
  });
  assert.equal(result.filter((item) => !item.excluded).length, 1);
  assert.deepEqual(new Set(result.filter((item) => item.excluded).map((item) => item.rejectionReason)), new Set([
    "Zero bid or ask", "Crossed market", "Bid/ask spread exceeds filter", "Open interest below filter",
    "Stale option quote", "No-arbitrage price bound violated",
  ]));
});

test("implied-volatility inversion converges and rejects impossible prices", () => {
  const parameters = { spot: 100, strike: 105, maturity: 0.75, rate: 0.035, dividend: 0.012, volatility: 0.287 };
  const price = blackScholesPrice({ ...parameters, side: "Call" });
  const implied = impliedVolatilityFromPrice({ ...parameters, price, side: "call" });
  assert.ok(Math.abs(implied! - parameters.volatility) < 1e-7);
  assert.equal(impliedVolatilityFromPrice({ ...parameters, price: 150, side: "call" }), null);
});

test("realised volatility uses adjusted log returns and does not become pricing sigma", () => {
  const returns = [0.01, -0.01, 0.02];
  const prices = [100];
  returns.forEach((value) => prices.push(prices.at(-1)! * Math.exp(value)));
  const history = prices.map((adjustedClose, index) => ({
    date: `2026-08-${String(20 + index).padStart(2, "0")}`, close: adjustedClose * 2,
    adjustedClose, volume: 1, dividends: 0, splits: 0,
  }));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const expected = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1) * 252);
  assert.ok(Math.abs(annualizedRealizedVolatility(history, 3)! - expected) < 1e-12);
  assert.equal(annualizedRealizedVolatility(history, 20), null);
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Black–Scholes"), defaultParameters("Black–Scholes", "european"));
  assert.match(snapshot.proposals.find((item) => item.id === "volatility")?.provenance.formula ?? "", /midpoint/);
  assert.ok(!snapshot.proposals.some((item) => item.id.startsWith("realised")));
});

test("USD Treasury proxies fail the snapshot currency guard for non-USD requests", () => {
  const request = { ...defaultMarketRequest("Black–Scholes"), currency: "AUD" };
  const snapshot = createFixtureSnapshot(request, defaultParameters("Black–Scholes", "european"));
  assert.ok(snapshot.validationIssues.some((issue) => /FRED Treasury rate pillars are USD/.test(issue)));
  assert.throws(() => applySnapshot(defaultParameters("Black–Scholes", "european"), snapshot, new Set(["spot"])), /validation errors/);
});

test("Heston fixture prepares an expiry-specific forward-moneyness surface without directly applying seeds", () => {
  const request = defaultMarketRequest("Heston");
  const snapshot = createFixtureSnapshot(request, defaultParameters("Heston", "european"));
  const details = snapshot.heston!;
  assert.equal(details.retainedExpirations.length, 3);
  assert.equal(details.rates.length, 3);
  assert.ok(new Set(details.rates.map((item) => item.value.toFixed(8))).size > 1, "rates must be interpolated separately by expiry");
  const retained = details.instruments.filter((item) => !item.excluded);
  assert.ok(retained.length >= 30);
  assert.ok(retained.every((item) => Math.abs(item.logMoneyness - Math.log(item.strike / item.forward)) < 1e-14));
  assert.ok(retained.every((item) => item.logMoneyness >= request.hestonMoneynessMinimum && item.logMoneyness <= request.hestonMoneynessMaximum));
  assert.ok(details.instruments.some((item) => item.excluded && item.rejectionReason));
  assert.equal(details.calibration, undefined);
  const seeds = snapshot.proposals.filter((item) => item.calibrationRole === "seed");
  assert.equal(seeds.length, 5);
  assert.ok(seeds.every((item) => !item.selected && !item.applicable && item.bounds));
});

test("Heston coverage guards reject surfaces without enough strikes or expiries", () => {
  const request = { ...defaultMarketRequest("Heston"), hestonMinimumStrikes: 20, hestonMinimumExpiries: 3 };
  const snapshot = createFixtureSnapshot(request, defaultParameters("Heston", "european"));
  assert.match(snapshot.validationIssues.join(" "), /requires at least 3 expirations/);
  assert.equal(snapshot.heston?.retainedExpirations.length, 0);
  assert.throws(() => applySnapshot(defaultParameters("Heston", "european"), snapshot, new Set(["spot"])), /validation errors/);
});

test("Heston spread-aware weights are normalized and optionally reward open interest", () => {
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Heston"), defaultParameters("Heston", "european"));
  const retained = snapshot.heston!.instruments.filter((item) => !item.excluded).slice(0, 2).map((item, index) => ({
    ...item, bid: 5, ask: 5.1, bidImpliedVolatility: 0.2, askImpliedVolatility: 0.21, openInterest: index ? 400 : 25,
  }));
  const withoutOpenInterest = spreadAwareWeights(retained, "price", false);
  const withOpenInterest = spreadAwareWeights(retained, "price", true);
  assert.ok(Math.abs(withoutOpenInterest.reduce((sum, value) => sum + value, 0) - 1) < 1e-14);
  assert.ok(Math.abs(withoutOpenInterest[0] - withoutOpenInterest[1]) < 1e-14);
  assert.ok(withOpenInterest[1] > withOpenInterest[0]);
  assert.ok(Math.abs(withOpenInterest.reduce((sum, value) => sum + value, 0) - 1) < 1e-14);
});

test("Heston bounded multi-start calibration is deterministic for fixed fixtures and seed", () => {
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Heston"), defaultParameters("Heston", "european"));
  const details = snapshot.heston!;
  const options = {
    spot: Number(snapshot.proposals.find((item) => item.id === "spot")?.proposedValue),
    instruments: details.instruments, seeds: details.seeds, objective: "iv" as const, useOpenInterest: true,
    randomSeed: 1729, multiStarts: 2, maximumEvaluations: 120, quadratureOrder: 16,
    startedAt: "2026-08-23T01:00:00Z", completedAt: "2026-08-23T01:00:01Z",
  };
  const first = calibrateHestonSurface(options);
  const second = calibrateHestonSurface(options);
  assert.deepEqual(first, second);
  assert.equal(first.converged, true);
  assert.ok(first.weightedRmse < 0.02);
  assert.ok(first.maximumError < 0.08);
  assert.ok(first.evaluations <= options.maximumEvaluations);
  for (const key of ["v0", "kappa", "theta", "xi", "rho"] as const) {
    assert.ok(first.parameters[key] >= HESTON_CALIBRATION_BOUNDS[key][0] && first.parameters[key] <= HESTON_CALIBRATION_BOUNDS[key][1]);
  }
  assert.ok(Number.isFinite(first.fellerRatio));
});

test("Heston calibration cancellation is cooperative in the pure engine", () => {
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Heston"), defaultParameters("Heston", "european"));
  let checks = 0;
  assert.throws(() => calibrateHestonSurface({
    spot: 226.43, instruments: snapshot.heston!.instruments, seeds: snapshot.heston!.seeds,
    objective: "iv", useOpenInterest: true, randomSeed: 1, multiStarts: 2, maximumEvaluations: 80,
    quadratureOrder: 16, shouldCancel: () => ++checks > 2,
  }), HestonCalibrationCancelledError);
  assert.ok(checks > 2);
});

test("failed calibration preserves the snapshot while accepted calibration applies only by explicit action", () => {
  const current = defaultParameters("Heston", "european");
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Heston"), current);
  const original = structuredClone(snapshot);
  const details = snapshot.heston!;
  const result = calibrateHestonSurface({
    spot: 226.43, instruments: details.instruments, seeds: details.seeds, objective: "price",
    useOpenInterest: false, randomSeed: 99, multiStarts: 2, maximumEvaluations: 100, quadratureOrder: 16,
    startedAt: "2026-08-23T02:00:00Z", completedAt: "2026-08-23T02:00:01Z",
  });
  assert.deepEqual(snapshot, original, "calibration mutated the prepared snapshot");
  assert.throws(() => acceptHestonCalibration(snapshot, { ...result, converged: false }), /failed calibration/);
  assert.deepEqual(snapshot, original, "failed acceptance replaced the last accepted set");
  const accepted = acceptHestonCalibration(snapshot, result);
  assert.equal(accepted.heston?.calibration?.objective, "price");
  assert.equal(accepted.proposals.filter((item) => item.calibrationRole === "calibrated").length, 5);
  const selected = new Set(selectedChangedProposalIds(accepted));
  const application = applySnapshot(current, accepted, selected, "2026-08-23T02:00:02Z");
  for (const key of ["v0", "kappa", "theta", "xi", "rho"] as const) {
    assert.equal(Number(application.parameters[key]), Number(result.parameters[key].toFixed(8)));
  }
  assert.equal(application.history.associatedSolverRunIds.length, 0, "application must not start a PDE run");
});

test("VIXCLS is retained only as a regime prior for a relevant selected market", () => {
  const irrelevant = createFixtureSnapshot({ ...defaultMarketRequest("Heston"), hestonIncludeVix: true }, defaultParameters("Heston", "european"));
  assert.equal(irrelevant.heston?.vix, undefined);
  assert.match(irrelevant.warnings.join(" "), /VIXCLS was not loaded/);
  const relevant = createFixtureSnapshot({ ...defaultMarketRequest("Heston"), instrument: "SPY", hestonIncludeVix: true }, defaultParameters("Heston", "european"));
  assert.equal(relevant.heston?.vix?.classification, "regime-prior");
  assert.ok(!relevant.proposals.some((item) => item.id.toLowerCase().includes("vix")), "VIX must not be a direct Heston parameter");
});
