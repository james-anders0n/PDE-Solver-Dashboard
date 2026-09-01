import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultCaseDefinition } from "../app/lib/case-definition.ts";
import { defaultParameters } from "../app/lib/pde-spec.ts";
import { createFixtureSnapshot, defaultMarketRequest } from "../app/lib/market-data/index.ts";
import {
  alignParametersToOptionQuote,
  assessOptionValuation,
  findMatchingOptionQuote,
  findRepresentativeOptionQuote,
  supportsListedOptionValuation,
  type OptionQuoteEvidence,
} from "../app/lib/option-valuation-assessment.ts";

const definition = {
  ...createDefaultCaseDefinition({ model: "Black–Scholes", instrument: "AAPL", valuationDate: "2026-08-21" }),
  instrument: "AAPL",
  side: "Call" as const,
};

const quote: OptionQuoteEvidence = {
  snapshotId: "fixture-snapshot",
  contractSymbol: "AAPL20270219C00225000",
  instrument: "AAPL",
  currency: "USD",
  side: "Call",
  expiration: "2027-02-19",
  strike: 225,
  maturity: 182 / 365,
  bid: 4.8,
  ask: 5,
  mid: 4.9,
  relativeSpread: 0.2 / 4.9,
  openInterest: 900,
  quoteTimestamp: "2026-08-21T19:45:00Z",
  sourceMode: "fixture",
  freshness: "fixture",
  style: "synthetic-european",
};

const assess = (modelValue: number, overrides: Partial<Parameters<typeof assessOptionValuation>[0]> = {}) => assessOptionValuation({
  definition,
  resultFreshness: "current",
  accepted: true,
  modelValue,
  numericalError: 0.02,
  quote,
  ...overrides,
});

test("long-entry relative valuation separates positive edge, fair value, and premium above model", () => {
  const positive = assess(6);
  assert.equal(positive.stance, "positive-edge");
  assert.match(positive.label, /Illustrative.*Potential positive model edge/);
  assert.ok(Math.abs(positive.edgeRange![0] - 0.9) < 1e-12);
  assert.ok(Math.abs(positive.edgeRange![1] - 1.1) < 1e-12);

  const fair = assess(5.04);
  assert.equal(fair.stance, "near-fair-value");
  assert.ok(fair.edgeRange![0] < 0 && fair.edgeRange![1] > 0);

  const premium = assess(4);
  assert.equal(premium.stance, "premium-above-model");
  assert.ok(premium.edgeRange![1] < 0);
});

test("valuation assessment fails closed for stale, unaccepted, incompatible, and unverified evidence", () => {
  assert.equal(assess(6, { resultFreshness: "stale" }).stance, "insufficient-evidence");
  assert.equal(assess(6, { accepted: false }).stance, "insufficient-evidence");
  assert.equal(assess(6, { definition: { ...definition, contractId: "digital-cash", contractLabel: "Digital cash" } }).stance, "insufficient-evidence");
  const liveQuote = { ...quote, sourceMode: "live" as const, freshness: "current" as const, style: "unverified-listed" as const };
  const live = assess(6, { quote: liveQuote });
  assert.equal(live.stance, "insufficient-evidence");
  assert.match(live.reasons.join(" "), /does not certify an exercise style/);
});

test("quote matching requires the active model, instrument, side, strike, and expiry", () => {
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Black–Scholes"), defaultParameters("Black–Scholes", "european"));
  const instrument = snapshot.blackScholes!.instruments.find((item) => item.optionType === "call")!;
  const matchingDefinition = { ...definition, instrument: snapshot.instrument };
  const matching = findMatchingOptionQuote({
    snapshot,
    definition: matchingDefinition,
    parameters: { strike: String(instrument.strike), maturity: String(instrument.maturity) },
  });
  assert.equal(matching?.contractSymbol, instrument.contractSymbol);
  assert.equal(matching?.ask, instrument.ask);
  assert.equal(matching?.style, "synthetic-european");

  assert.equal(findMatchingOptionQuote({
    snapshot,
    definition: { ...matchingDefinition, side: "Put" },
    parameters: { strike: String(instrument.strike), maturity: String(instrument.maturity) },
  })?.side, "Put");
  assert.equal(findMatchingOptionQuote({
    snapshot,
    definition: matchingDefinition,
    parameters: { strike: String(instrument.strike + 0.25), maturity: String(instrument.maturity) },
  }), null);
});

test("representative quote recovery stays model matched and chooses the nearest-expiry ATM contract", () => {
  const request = { ...defaultMarketRequest("Heston"), instrument: "SPY", asOfDate: "2026-08-28" };
  const snapshot = createFixtureSnapshot(request, defaultParameters("Heston", "european"));
  const hestonDefinition = {
    ...createDefaultCaseDefinition({ model: "Heston", instrument: "SPY", valuationDate: "2026-08-28" }),
    instrument: "SPY",
    side: "Call" as const,
  };
  const suggested = findRepresentativeOptionQuote({
    snapshot,
    definition: hestonDefinition,
    parameters: { strike: "100", maturity: "1" },
  });
  assert.ok(suggested);
  assert.equal(suggested.snapshotId, snapshot.id);
  assert.equal(suggested.instrument, "SPY");
  assert.equal(suggested.side, "Call");
  assert.ok(snapshot.heston!.instruments.some((item) => item.contractSymbol === suggested.contractSymbol && !item.excluded));

  assert.equal(findRepresentativeOptionQuote({
    snapshot,
    definition: { ...hestonDefinition, model: "Black–Scholes" },
    parameters: { strike: "100", maturity: "1" },
  }), null);
});

test("market application automatically aligns an unmatched option case and preserves an exact contract", () => {
  const snapshot = createFixtureSnapshot(defaultMarketRequest("Black–Scholes"), defaultParameters("Black–Scholes", "european"));
  const unmatched = alignParametersToOptionQuote({
    snapshot,
    definition,
    parameters: defaultParameters("Black–Scholes", "european"),
  });

  assert.ok(unmatched.quote);
  assert.equal(unmatched.changed, true);
  assert.equal(unmatched.parameters.strike, String(unmatched.quote.strike));
  assert.equal(unmatched.parameters.maturity, String(unmatched.quote.maturity));

  const exact = alignParametersToOptionQuote({
    snapshot,
    definition,
    parameters: unmatched.parameters,
  });
  assert.equal(exact.changed, false);
  assert.equal(exact.quote?.contractSymbol, unmatched.quote.contractSymbol);
  assert.deepEqual(exact.parameters, unmatched.parameters);
});

test("insufficient assessment exposes a safe quoted-contract recovery and exact numerical issues", () => {
  const assessment = assess(6, {
    accepted: false,
    quote: null,
    suggestedQuote: quote,
    numericalAcceptanceIssues: ["Maximum-norm error 3.000e-2 exceeds 2.000e-2."],
  });
  assert.equal(assessment.stance, "insufficient-evidence");
  assert.equal(assessment.suggestedQuote?.contractSymbol, quote.contractSymbol);
  assert.match(assessment.reasons.join(" "), /Maximum-norm error/);
  assert.equal(assessment.sampleOnly, true);
});

test("listed-option relative valuation is limited to equity option models", () => {
  assert.equal(supportsListedOptionValuation("Black–Scholes"), true);
  assert.equal(supportsListedOptionValuation("Heston"), true);
  assert.equal(supportsListedOptionValuation("Vasicek"), false);
  assert.equal(supportsListedOptionValuation("Hull–White"), false);
  assert.equal(supportsListedOptionValuation("HJB"), false);
});
