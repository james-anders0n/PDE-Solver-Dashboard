import {
  createDiscountCurve,
  hullWhiteBondPrice,
  hullWhiteTheta,
  validateDiscountCurvePillars,
} from "../pde-engine/short-rate.ts";
import type { NormalizedFredObservation } from "./fred-client.ts";
import type { YFinanceOptionContract } from "./yfinance-client.ts";
import type {
  HullWhiteCurvePillar,
  HullWhiteCurveSnapshotDetails,
  HullWhiteEtfOptionProxy,
  MarketDataRequest,
  MarketSnapshot,
  ParameterProposal,
  TransformationProvenance,
} from "./types.ts";

export interface HullWhiteSeriesSpec {
  id: string;
  tenorLabel: string;
  time: number;
  instrument: HullWhiteCurvePillar["constructionInstrument"];
  dayCount: HullWhiteCurvePillar["dayCount"];
}

export const HULL_WHITE_SERIES: readonly HullWhiteSeriesSpec[] = [
  { id: "SOFR", tenorLabel: "ON", time: 1 / 360, instrument: "overnight-deposit", dayCount: "ACT/360" },
  { id: "DGS1MO", tenorLabel: "1M", time: 1 / 12, instrument: "treasury-bill-proxy", dayCount: "ACT/365F" },
  { id: "DGS3MO", tenorLabel: "3M", time: 0.25, instrument: "treasury-bill-proxy", dayCount: "ACT/365F" },
  { id: "DGS6MO", tenorLabel: "6M", time: 0.5, instrument: "treasury-bill-proxy", dayCount: "ACT/365F" },
  { id: "DGS1", tenorLabel: "1Y", time: 1, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
  { id: "DGS2", tenorLabel: "2Y", time: 2, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
  { id: "DGS3", tenorLabel: "3Y", time: 3, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
  { id: "DGS5", tenorLabel: "5Y", time: 5, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
  { id: "DGS7", tenorLabel: "7Y", time: 7, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
  { id: "DGS10", tenorLabel: "10Y", time: 10, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
  { id: "DGS20", tenorLabel: "20Y", time: 20, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
  { id: "DGS30", tenorLabel: "30Y", time: 30, instrument: "treasury-par-yield-proxy", dayCount: "ACT/365F" },
] as const;

export interface HullWhiteEtfOptionInput {
  symbol: "SHY" | "IEF" | "TLT";
  spot: number;
  expiration: string;
  contracts: YFinanceOptionContract[];
}

export interface HullWhiteCurveInput {
  request: MarketDataRequest;
  currentParameters: Record<string, string>;
  fred: NormalizedFredObservation[];
  etfOptions?: HullWhiteEtfOptionInput[];
  providerErrors?: string[];
}

const dayDifference = (later: string, earlier: string) => Math.floor((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
const annualToContinuous = (rate: number) => Math.log1p(rate);
const sofrToContinuous = (rate: number) => 360 * Math.log1p(rate / 360);

function previousValidBySeries(
  observations: NormalizedFredObservation[],
  selected: string[],
  asOfDate: string,
): { aligned: Map<string, NormalizedFredObservation>; missing: string[] } {
  const aligned = new Map<string, NormalizedFredObservation>();
  selected.forEach((seriesId) => {
    const latest = observations
      .filter((item) => item.seriesId === seriesId && item.date <= asOfDate && Number.isFinite(item.value))
      .sort((left, right) => right.date.localeCompare(left.date))[0];
    if (latest) aligned.set(seriesId, latest);
  });
  return { aligned, missing: selected.filter((seriesId) => !aligned.has(seriesId)) };
}

function logLinearDiscount(known: Array<{ time: number; discount: number }>, time: number, fallbackRate: number): number {
  if (time <= 0) return 1;
  const rightIndex = known.findIndex((point) => point.time >= time);
  if (rightIndex > 0) {
    const left = known[rightIndex - 1];
    const right = known[rightIndex];
    const weight = (time - left.time) / (right.time - left.time);
    return Math.exp(Math.log(left.discount) + weight * (Math.log(right.discount) - Math.log(left.discount)));
  }
  const last = known[known.length - 1];
  return Math.exp(Math.log(last.discount) - fallbackRate * (time - last.time));
}

function rawDiscount(spec: HullWhiteSeriesSpec, quoteDecimal: number, mode: MarketDataRequest["hullWhiteCurveMode"], known: Array<{ time: number; discount: number }>): { discount: number; normalizedRate: number; compounding: HullWhiteCurvePillar["compounding"] } {
  if (mode === "treasury-proxy") {
    const normalizedRate = spec.id === "SOFR" ? sofrToContinuous(quoteDecimal) : annualToContinuous(quoteDecimal);
    return { discount: Math.exp(-normalizedRate * spec.time), normalizedRate, compounding: "continuous-approximation" };
  }
  if (spec.instrument === "overnight-deposit" || spec.time <= 0.5) {
    const discount = 1 / (1 + quoteDecimal * spec.time);
    return { discount, normalizedRate: -Math.log(discount) / spec.time, compounding: "simple" };
  }
  const coupon = quoteDecimal / 2;
  const paymentCount = Math.max(1, Math.round(spec.time * 2));
  let previousCoupons = 0;
  for (let payment = 1; payment < paymentCount; payment += 1) {
    const paymentTime = payment / 2;
    previousCoupons += coupon * logLinearDiscount(known, paymentTime, annualToContinuous(quoteDecimal));
  }
  const discount = (1 - previousCoupons) / (1 + coupon);
  if (!(discount > 0) || !Number.isFinite(discount)) throw new Error(`Bootstrap failed to produce a positive ${spec.tenorLabel} discount factor.`);
  return { discount, normalizedRate: -Math.log(discount) / spec.time, compounding: "semiannual" };
}

function enforceMonotonicity(pillars: HullWhiteCurvePillar[]): HullWhiteCurvePillar[] {
  let previousDiscount = 1;
  let previousTime = 0;
  return pillars.map((pillar) => {
    if (!(pillar.discount > 0) || !Number.isFinite(pillar.discount)) throw new Error("Curve construction produced a nonpositive or non-finite discount factor.");
    const interval = pillar.time - previousTime;
    const impliedForward = -Math.log(pillar.discount / previousDiscount) / interval;
    if (impliedForward < -0.01) {
      throw new Error(`Severe unexplained non-monotonicity between ${previousTime.toFixed(3)}Y and ${pillar.time.toFixed(3)}Y.`);
    }
    const adjusted = pillar.discount > previousDiscount
      ? { ...pillar, discount: previousDiscount, normalizedRate: -Math.log(previousDiscount) / pillar.time, adjustment: "Minor discount increase flattened to preserve a non-increasing curve." }
      : pillar;
    previousDiscount = adjusted.discount;
    previousTime = adjusted.time;
    return adjusted;
  });
}

function selectEtfOptionProxies(inputs: HullWhiteEtfOptionInput[] = []): HullWhiteEtfOptionProxy[] {
  return inputs.flatMap((input) => {
    const retained = input.contracts.filter((contract) =>
      contract.impliedVolatility != null && contract.impliedVolatility > 0 && contract.openInterest > 0 && contract.bid >= 0 && contract.ask >= contract.bid);
    if (!retained.length) return [];
    const selected = retained.reduce((best, item) => Math.abs(item.strike - input.spot) < Math.abs(best.strike - input.spot) ? item : best);
    return [{
      symbol: input.symbol,
      expiration: input.expiration,
      contractSymbol: selected.contractSymbol,
      optionType: selected.optionType,
      strike: selected.strike,
      impliedVolatility: selected.impliedVolatility!,
      openInterest: selected.openInterest,
      classification: "rate-volatility-scenario-proxy" as const,
      warning: "Amber scenario proxy only. Treasury ETF options are not swaptions and do not calibrate Hull–White σᵣ.",
    }];
  });
}

function proposal(options: {
  request: MarketDataRequest;
  current: Record<string, string>;
  id: string;
  label: string;
  symbol: string;
  proposedValue: string;
  classification: ParameterProposal["classification"];
  selected: boolean;
  applicable: boolean;
  sourceIds: string[];
  formula: string;
  unit?: TransformationProvenance["unit"];
  warning?: string;
}): ParameterProposal {
  const timestamp = `${options.request.asOfDate}T23:00:00Z`;
  return {
    id: options.id,
    label: options.label,
    symbol: options.symbol,
    currentValue: options.current[options.id] ?? "—",
    proposedValue: options.proposedValue,
    classification: options.classification,
    selected: options.selected,
    applicable: options.applicable,
    warning: options.warning,
    calibrationRole: options.id === "curveId" || options.id === "shortRate" ? "dependency" : undefined,
    provenance: {
      provider: options.classification === "manual" ? "manual" : "FRED",
      sourceIdentifiers: options.sourceIds,
      observationTimestamp: timestamp,
      availableTimestamp: timestamp,
      fetchedTimestamp: timestamp,
      vintage: options.request.asOfDate,
      formula: options.formula,
      financialInterpretation: options.id === "curveId" ? "The imported Q-measure discount curve is the primary Hull–White market object."
        : options.id === "shortRate" ? "Front instantaneous forward derived from the applied curve."
          : "Kept separate from the initial curve; unchanged unless the user supplies an independent calibration or scenario.",
      measure: "Q",
      unit: options.unit ?? "decimal",
      compounding: options.id === "shortRate" ? "continuous" : "not-applicable",
      stalenessPolicy: `Previous valid FRED observation by as-of; maximum configured quote age ${options.request.hullWhiteMaximumQuoteAgeDays} days.`,
    },
  };
}

export function buildHullWhiteCurveSnapshot(input: HullWhiteCurveInput): MarketSnapshot {
  const { request, currentParameters } = input;
  if (request.model !== "Hull–White") throw new Error("Hull–White curve builder received the wrong model.");
  if (request.currency.toUpperCase() !== "USD") throw new Error("Currency mismatch: FRED Treasury and SOFR inputs are USD. No implicit cross-currency proxy is supported.");
  if (!Number.isInteger(request.hullWhiteMaximumQuoteAgeDays) || request.hullWhiteMaximumQuoteAgeDays < 0) throw new Error("Maximum quote age must be a non-negative integer.");
  const knownIds = new Set(HULL_WHITE_SERIES.map((item) => item.id));
  const selected = [...new Set(request.hullWhiteSelectedSeries)].filter((item) => knownIds.has(item));
  if (selected.length < 4) throw new Error("Hull–White curve construction requires at least four configured FRED tenors.");
  const frontPreference = request.hullWhiteCurveFamily === "sofr-treasury" ? ["SOFR", "DGS1MO"] : ["DGS1MO"];
  if (!frontPreference.some((item) => selected.includes(item))) throw new Error("The selected curve is missing a front anchor (SOFR or DGS1MO as appropriate)." );
  const { aligned, missing } = previousValidBySeries(input.fred, selected, request.asOfDate);
  const frontSeries = frontPreference.find((item) => aligned.has(item));
  if (!frontSeries) throw new Error("The selected FRED observations do not contain an available front anchor by the as-of date.");
  const availableSpecs = HULL_WHITE_SERIES.filter((spec) => selected.includes(spec.id) && aligned.has(spec.id)).sort((left, right) => left.time - right.time);
  if (availableSpecs.length < 4) throw new Error("Too few aligned FRED pillars remain after missing-input checks.");
  const stale = availableSpecs.filter((spec) => dayDifference(request.asOfDate, aligned.get(spec.id)!.date) > request.hullWhiteMaximumQuoteAgeDays);
  if (stale.length) throw new Error(`Quote staleness exceeds policy for ${stale.map((item) => item.id).join(", ")}.`);

  const constructed: HullWhiteCurvePillar[] = [];
  const knownDiscounts = [{ time: 0, discount: 1 }];
  availableSpecs.forEach((spec) => {
    const raw = aligned.get(spec.id)!;
    const quoteDecimal = raw.value / 100;
    const transformed = rawDiscount(spec, quoteDecimal, request.hullWhiteCurveMode, knownDiscounts);
    const pillar: HullWhiteCurvePillar = {
      seriesId: spec.id,
      tenorLabel: spec.tenorLabel,
      time: spec.time,
      rawQuote: raw.value,
      rawUnit: "percent",
      quoteDate: raw.date,
      realtimeStart: raw.realtimeStart,
      realtimeEnd: raw.realtimeEnd,
      availableTimestamp: `${request.asOfDate}T00:00:00Z`,
      normalizedRate: transformed.normalizedRate,
      discount: transformed.discount,
      reproductionError: 0,
      constructionInstrument: spec.instrument,
      dayCount: spec.dayCount,
      compounding: transformed.compounding,
    };
    constructed.push(pillar);
    knownDiscounts.push({ time: pillar.time, discount: pillar.discount });
  });
  const monotonePillars = enforceMonotonicity(constructed);
  const curveId = `USD-${request.hullWhiteCurveMode === "bootstrap" ? "TREASURY-BOOTSTRAP" : "TREASURY-PROXY"}-${request.asOfDate}`;
  const serializableCurve = { id: curveId, pillars: [{ time: 0, discount: 1 }, ...monotonePillars.map((item) => ({ time: item.time, discount: item.discount }))] };
  validateDiscountCurvePillars(serializableCurve.pillars);
  const curve = createDiscountCurve(curveId, serializableCurve.pillars);
  const frontRate = curve.instantaneousForward(0);
  if (!Number.isFinite(frontRate)) throw new Error("The curve did not produce a finite front instantaneous forward.");
  const meanReversion = Number(currentParameters.meanReversion);
  const rateVolatility = Number(currentParameters.rateVolatility);
  if (!(meanReversion > 0) || !(rateVolatility > 0)) throw new Error("Hull–White a and σᵣ must remain finite and positive while reconstructing ϑ(t)." );
  const hullWhiteParameters = { shortRate: frontRate, meanReversion, rateVolatility, curve };
  const reproduced = monotonePillars.map((pillar) => {
    const price = hullWhiteBondPrice(hullWhiteParameters, pillar.time);
    return { ...pillar, reproductionError: price / pillar.discount - 1 };
  });
  const maximumFitErrorBasisPoints = Math.max(...reproduced.map((item) => Math.abs(item.reproductionError))) * 10_000;
  const theta = Array.from({ length: 121 }, (_, index) => {
    const time = 30 * index / 120;
    return { time, value: hullWhiteTheta(hullWhiteParameters, time) };
  });
  if (!theta.every((item) => Number.isFinite(item.value))) throw new Error("Hull–White ϑ(t) reconstruction produced a non-finite value.");
  const etfOptionProxies = selectEtfOptionProxies(input.etfOptions);
  const snapshotId = `${request.sourceMode}-hull-white-${request.hullWhiteCurveMode}-${request.asOfDate}`;
  const details: HullWhiteCurveSnapshotDetails = {
    snapshotId,
    curve: serializableCurve,
    mode: request.hullWhiteCurveMode,
    family: request.hullWhiteCurveFamily,
    currency: "USD",
    asOfDate: request.asOfDate,
    interpolation: request.hullWhiteInterpolation,
    proxyStatus: "PROXY",
    sourceSeries: availableSpecs.map((item) => item.id),
    missingSeries: missing,
    frontSeries,
    frontRate,
    maximumFitErrorBasisPoints,
    maximumQuoteAgeDays: request.hullWhiteMaximumQuoteAgeDays,
    pillars: reproduced,
    theta,
    etfOptionProxies,
    constructionNotes: request.hullWhiteCurveMode === "treasury-proxy"
      ? ["Treasury yields are normalized to continuously compounded zero-rate approximations.", "This is a Treasury PROXY curve and is never labelled OIS.", "Natural cubic interpolation is applied to log discount factors."]
      : ["Bills use simple discounting; Treasury constant-maturity yields are treated as semiannual par-yield proxies.", "Coupon-date discounts use log-linear interpolation of already bootstrapped discounts with a quote-rate tail approximation for missing coupon nodes.", "This documented bootstrap remains a Treasury PROXY and is never labelled OIS."],
  };
  const denseTimes = Array.from({ length: 241 }, (_, index) => 30 * index / 240);
  const observations = reproduced.map((pillar) => ({
    provider: "FRED" as const,
    identifier: pillar.seriesId,
    value: pillar.rawQuote,
    observationTimestamp: `${pillar.quoteDate}T16:00:00Z`,
    availableTimestamp: pillar.availableTimestamp,
    fetchedTimestamp: `${request.asOfDate}T23:00:00Z`,
    vintage: pillar.realtimeStart,
    unit: "percent" as const,
    currency: "USD",
  }));
  const providerState = request.sourceMode === "fixture" ? "fixture" as const : input.providerErrors?.length ? "partial" as const : "current" as const;
  return {
    id: snapshotId,
    model: "Hull–White",
    workspaceLabel: "Curve snapshot",
    instrument: curveId,
    currency: "USD",
    asOfDate: request.asOfDate,
    createdAt: `${request.asOfDate}T23:00:00Z`,
    freshness: providerState,
    freshnessMessage: `${availableSpecs.length} FRED pillars aligned by the previous-valid-observation rule; quote dates and vintage fields remain attached to each pillar.`,
    sourceMode: request.sourceMode,
    measure: "Q",
    providerHealth: [
      { provider: "FRED", state: providerState, message: `${availableSpecs.length} aligned pillars · ${missing.length} missing` },
      ...(request.hullWhiteIncludeEtfOptions ? [{ provider: "yfinance" as const, state: request.sourceMode === "fixture" ? "fixture" as const : etfOptionProxies.length ? "current" as const : "partial" as const, message: `${etfOptionProxies.length} ETF-option scenario proxies` }] : []),
    ],
    observations,
    proposals: [
      proposal({ request, current: currentParameters, id: "curveId", label: "Curve snapshot", symbol: "P(0,·)", proposedValue: curveId, classification: "proxy", selected: true, applicable: true, sourceIds: details.sourceSeries, formula: `${request.hullWhiteCurveMode}; ${request.hullWhiteInterpolation}`, unit: "identifier" }),
      proposal({ request, current: currentParameters, id: "shortRate", label: "Front rate", symbol: "r₀", proposedValue: frontRate.toFixed(8), classification: "derived", selected: true, applicable: true, sourceIds: [frontSeries], formula: "instantaneousForward(0) from the imported log-discount curve" }),
      proposal({ request, current: currentParameters, id: "meanReversion", label: "Mean reversion", symbol: "a", proposedValue: currentParameters.meanReversion, classification: "manual", selected: false, applicable: true, sourceIds: [], formula: "unchanged; calibrated separately from the initial curve" }),
      proposal({ request, current: currentParameters, id: "rateVolatility", label: "Rate volatility", symbol: "σᵣ", proposedValue: currentParameters.rateVolatility, classification: "manual", selected: false, applicable: true, sourceIds: [], formula: "unchanged; ETF-option information is scenario-only" }),
      proposal({ request, current: currentParameters, id: "curveInterpolation", label: "Interpolation", symbol: "I", proposedValue: "Natural cubic log discount", classification: "derived", selected: false, applicable: false, sourceIds: details.sourceSeries, formula: request.hullWhiteInterpolation, unit: "identifier", warning: "Curve metadata; it is stored with the snapshot rather than copied into a scalar solver control." }),
      proposal({ request, current: currentParameters, id: "proxyStatus", label: "Curve status", symbol: "P", proposedValue: "PROXY · NOT OIS", classification: "proxy", selected: false, applicable: false, sourceIds: details.sourceSeries, formula: request.hullWhiteCurveMode, unit: "identifier", warning: "FRED Treasury data is a proxy market object, not an OIS discount curve." }),
      proposal({ request, current: currentParameters, id: "maximumFitError", label: "Maximum fit error", symbol: "ε", proposedValue: `${maximumFitErrorBasisPoints.toExponential(3)} bp`, classification: "derived", selected: false, applicable: false, sourceIds: details.sourceSeries, formula: "max |P_HW(0,T)/P_market(0,T)-1| × 10,000", unit: "identifier", warning: "Diagnostic stored in the immutable curve snapshot." }),
    ],
    primaryTitle: "Yield, discount and instantaneous-forward curve",
    primarySummary: "Segmented views separate raw FRED pillars from interpolation. Treasury inputs remain visibly classified as PROXY.",
    primarySeries: [
      { id: "raw-yield", label: "Raw normalized pillars", classification: "observed", points: reproduced.map((item) => ({ x: item.time, y: item.normalizedRate, label: `${item.tenorLabel} · ${item.seriesId}` })) },
      { id: "yield", label: "Interpolated zero yield", classification: "proxy", points: denseTimes.filter((time) => time > 0).map((time) => ({ x: time, y: -Math.log(curve.discount(time)) / time })) },
      { id: "raw-discount", label: "Constructed discount pillars", classification: "observed", points: serializableCurve.pillars.map((item) => ({ x: item.time, y: item.discount })) },
      { id: "discount", label: "Discount P(0,T)", classification: "derived", points: denseTimes.map((time) => ({ x: time, y: curve.discount(time) })) },
      { id: "forward", label: "Instantaneous forward", classification: "derived", points: denseTimes.map((time) => ({ x: time, y: curve.instantaneousForward(time) })) },
    ],
    secondaryTitle: "Reconstructed Hull–White ϑ(t)",
    secondarySummary: "The existing solver convention reconstructs time-dependent drift from the immutable curve while a and σᵣ remain independent controls.",
    secondarySeries: [{ id: "theta", label: "ϑ(t)", classification: "derived", points: theta.map((item) => ({ x: item.time, y: item.value })) }],
    diagnostics: [
      { label: "Mode", value: `${request.hullWhiteCurveMode.toUpperCase()} · PROXY · NOT OIS` },
      { label: "Front anchor", value: `${frontSeries} · ${(frontRate * 100).toFixed(4)}% continuous` },
      { label: "Interpolation", value: "Natural cubic log discount" },
      { label: "Maximum fit error", value: `${maximumFitErrorBasisPoints.toExponential(3)} bp` },
      { label: "Quote alignment", value: `Previous valid by ${request.asOfDate}` },
      { label: "Missing inputs", value: missing.length ? missing.join(", ") : "None" },
    ],
    validationIssues: [],
    warnings: [
      "FRED Treasury constant-maturity yields are a visibly classified PROXY and are never called an OIS curve.",
      ...(missing.length ? [`Missing configured inputs: ${missing.join(", ")}. The retained instrument set is recorded.`] : []),
      ...(reproduced.some((item) => item.adjustment) ? ["Minor raw discount increases were flattened; every adjustment is recorded at pillar level."] : []),
      ...(request.hullWhiteIncludeEtfOptions ? ["SHY, IEF and TLT option information is an amber rate-volatility scenario proxy, not a swaption calibration."] : []),
    ],
    hullWhite: details,
  };
}

export function createHullWhiteFixtureSnapshot(request: MarketDataRequest, currentParameters: Record<string, string>): MarketSnapshot {
  const rates: Record<string, number> = {
    SOFR: 4.31, DGS1MO: 4.28, DGS3MO: 4.25, DGS6MO: 4.20, DGS1: 4.12, DGS2: 4.02,
    DGS3: 4.00, DGS5: 4.08, DGS7: 4.18, DGS10: 4.30, DGS20: 4.54, DGS30: 4.61,
  };
  const fred = request.hullWhiteSelectedSeries.flatMap((seriesId, index) => rates[seriesId] == null ? [] : [{
    seriesId,
    date: index % 5 === 0 ? "2026-08-20" : "2026-08-21",
    value: rates[seriesId],
    realtimeStart: request.asOfDate,
    realtimeEnd: request.asOfDate,
  }]);
  const etfOptions: HullWhiteEtfOptionInput[] | undefined = request.hullWhiteIncludeEtfOptions
    ? (["SHY", "IEF", "TLT"] as const).map((symbol, index) => {
      const spot = [82.4, 94.2, 88.7][index];
      return {
        symbol,
        spot,
        expiration: "2026-12-18",
        contracts: [{ contractSymbol: `${symbol}261218C${Math.round(spot * 1000)}`, optionType: "call" as const, expiration: "2026-12-18", strike: Math.round(spot), bid: 1.1, ask: 1.3, lastPrice: 1.2, impliedVolatility: [0.09, 0.14, 0.21][index], openInterest: 500 + index * 250, volume: 80, lastTradeTimestamp: "2026-08-21T20:00:00Z" }],
      };
    })
    : undefined;
  return buildHullWhiteCurveSnapshot({ request, currentParameters, fred, etfOptions });
}
