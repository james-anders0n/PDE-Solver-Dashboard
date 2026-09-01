import { vasicekBondPrice } from "../pde-engine/short-rate.ts";
import type { NormalizedFredObservation } from "./fred-client.ts";
import type { YFinanceHistoryPoint } from "./yfinance-client.ts";
import {
  calibrateVasicekQCurve,
  estimateVasicekHistorical,
  prepareVasicekHistory,
  type VasicekCurveInstrument,
} from "./vasicek-estimator.ts";
import type {
  MarketDataRequest,
  MarketSnapshot,
  ParameterProposal,
  TransformationProvenance,
  VasicekEtfOverlay,
  VasicekHistoricalScenario,
} from "./types.ts";

export interface VasicekSnapshotInput {
  request: MarketDataRequest;
  currentParameters: Record<string, string>;
  fred: NormalizedFredObservation[];
  etfHistories?: Partial<Record<"SHY" | "IEF" | "TLT", YFinanceHistoryPoint[]>>;
  qCurveInstruments?: VasicekCurveInstrument[];
  providerErrors?: string[];
}

const ETF_BANDS: Record<"SHY" | "IEF" | "TLT", VasicekEtfOverlay["durationBand"]> = {
  SHY: "short", IEF: "intermediate", TLT: "long",
};

function provenance(
  request: MarketDataRequest,
  measure: "P" | "Q",
  formula: string,
  observationDate: string,
  classification: "observed" | "scenario" | "calibrated",
): TransformationProvenance {
  return {
    provider: "FRED",
    sourceIdentifiers: [request.fredSeries],
    observationTimestamp: `${observationDate}T16:00:00Z`,
    availableTimestamp: `${request.asOfDate}T00:00:00Z`,
    fetchedTimestamp: `${request.asOfDate}T23:00:00Z`,
    vintage: request.asOfDate,
    formula,
    financialInterpretation: classification === "observed"
      ? "Latest observed short rate available by the as-of date; this does not identify a historical risk premium."
      : measure === "P"
        ? "Historical P-measure OU estimate. It may be saved as a scenario but cannot overwrite the Q pricing base."
        : "Cross-sectional Q-measure calibration against zero-coupon prices; retained separately from the P estimate.",
    measure,
    unit: "decimal",
    compounding: "continuous",
    stalenessPolicy: "Use the latest value available by the as-of date and retain FRED real-time/vintage metadata.",
  };
}

function makeProposal(options: {
  request: MarketDataRequest;
  current: Record<string, string>;
  id: "shortRate" | "meanReversion" | "longRunRate" | "rateVolatility";
  value: number;
  measure: "P" | "Q";
  classification: "observed" | "scenario" | "calibrated";
  selected: boolean;
  applicable: boolean;
  observationDate: string;
  formula: string;
  warning?: string;
  bounds?: [number, number];
}): ParameterProposal {
  const labels = { shortRate: "Short rate", meanReversion: "Mean reversion", longRunRate: "Long-run rate", rateVolatility: "Rate volatility" };
  const symbols = { shortRate: "r₀", meanReversion: "a", longRunRate: "b", rateVolatility: "σᵣ" };
  return {
    id: options.id,
    label: labels[options.id],
    symbol: symbols[options.id],
    currentValue: options.current[options.id] ?? "—",
    proposedValue: options.value.toFixed(8),
    classification: options.classification,
    selected: options.selected,
    applicable: options.applicable,
    warning: options.warning,
    bounds: options.bounds,
    calibrationRole: options.classification === "calibrated" ? "calibrated" : options.id === "shortRate" ? "dependency" : undefined,
    provenance: provenance(options.request, options.measure, options.formula, options.observationDate, options.classification),
  };
}

function etfOverlays(histories: VasicekSnapshotInput["etfHistories"]): VasicekEtfOverlay[] {
  return (Object.keys(ETF_BANDS) as Array<keyof typeof ETF_BANDS>).flatMap((symbol) => {
    const points = histories?.[symbol]?.filter((item) => Number.isFinite(item.adjustedClose) && item.adjustedClose > 0) ?? [];
    if (!points.length) return [];
    const base = points[0].adjustedClose;
    return [{ symbol, proxyLabel: "PROXY" as const, durationBand: ETF_BANDS[symbol], points: points.map((item) => ({ date: item.date, normalizedValue: item.adjustedClose / base * 100 })) }];
  });
}

export function buildVasicekRateHistorySnapshot(input: VasicekSnapshotInput): MarketSnapshot {
  const { request, currentParameters } = input;
  if (request.model !== "Vasicek") throw new Error("Vasicek history builder received the wrong model.");
  if (request.fredSeries !== "SOFR" && request.fredSeries !== "DFF") throw new Error("Vasicek rate-history fit supports only SOFR or DFF.");
  if (request.vasicekWindowEnd > request.asOfDate) throw new Error("The Vasicek history window cannot extend beyond the as-of date.");
  if (!Number.isInteger(request.vasicekMinimumObservations) || request.vasicekMinimumObservations < 20) throw new Error("Vasicek minimum observations must be an integer of at least twenty.");

  const fred = input.fred
    .filter((item) => item.seriesId === request.fredSeries && item.date <= request.asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!fred.length) throw new Error(`${request.fredSeries} returned no observations available by ${request.asOfDate}.`);
  const rateObservations = fred.map((item) => ({ date: item.date, value: item.value / 100 }));
  const preparation = {
    windowStart: request.vasicekWindowStart,
    windowEnd: request.vasicekWindowEnd,
    sampling: request.vasicekSampling,
    missingPolicy: request.vasicekMissingPolicy,
    outlierPolicy: request.vasicekOutlierPolicy,
  } as const;
  const preparedPoints = prepareVasicekHistory(rateObservations, preparation);
  const pEstimate = estimateVasicekHistorical(preparedPoints, { ...preparation, minimumObservations: request.vasicekMinimumObservations });
  const latest = rateObservations[rateObservations.length - 1];
  const completedAt = `${request.asOfDate}T23:00:00Z`;
  const qCalibration = request.vasicekMeasureMode === "q-curve" && input.qCurveInstruments?.length
    ? calibrateVasicekQCurve({ shortRate: latest.value, instruments: input.qCurveInstruments, seed: pEstimate.parameters, completedAt })
    : undefined;
  const snapshotId = `${request.sourceMode}-vasicek-${request.fredSeries.toLowerCase()}-${request.asOfDate}-${request.vasicekSampling}`;
  const pWarning = "Historical P estimate cannot overwrite the Q pricing parameter. Save it as a historical scenario instead.";
  const pProposals = (Object.keys(pEstimate.parameters) as Array<keyof typeof pEstimate.parameters>).map((id) => makeProposal({
    request, current: currentParameters, id, value: pEstimate.parameters[id], measure: "P", classification: "scenario",
    selected: false, applicable: false, observationDate: latest.date, formula: "exact-discretized OU maximum-likelihood-equivalent AR(1) fit", warning: pWarning,
  }));
  const qProposals = qCalibration
    ? (Object.keys(qCalibration.parameters) as Array<keyof typeof qCalibration.parameters>).map((id) => makeProposal({
      request, current: currentParameters, id, value: qCalibration.parameters[id], measure: "Q", classification: "calibrated",
      selected: true, applicable: true, observationDate: latest.date, formula: "bounded cross-sectional calibration to zero-coupon bond prices", bounds: qCalibration.bounds[id],
    }))
    : pProposals;
  const removedObservations = preparedPoints.filter((point) => point.excluded).map((point) => ({ date: point.date, value: point.value, reason: point.exclusionReason ?? "Excluded by policy" }));
  const conditional = preparedPoints.map((point, index) => ({
    x: index,
    y: index === 0 ? point.value : pEstimate.parameters.longRunRate + (preparedPoints[index - 1].value - pEstimate.parameters.longRunRate) * Math.exp(-pEstimate.parameters.meanReversion * pEstimate.sampleIntervalYears),
    label: point.date,
  }));
  const overlays = etfOverlays(input.etfHistories);
  const warnings = [
    "Historical aᴾ, bᴾ and σᵣᴾ remain immutable P-measure scenario estimates and are never selected for the Q solver by default.",
    ...(request.vasicekMeasureMode === "q-curve" && !qCalibration ? ["No adequate cross-sectional zero-coupon dataset is attached. Q calibration and Q-set application are disabled."] : []),
    ...(overlays.length ? ["SHY, IEF and TLT are PROXY validation overlays only; ETF shares are not zero-coupon bonds."] : []),
  ];
  const residualStd = Math.max(pEstimate.residualDiagnostics.standardDeviation, 1e-15);
  return {
    id: snapshotId,
    model: "Vasicek",
    workspaceLabel: "Rate-history fit",
    instrument: request.fredSeries,
    currency: "USD",
    asOfDate: request.asOfDate,
    createdAt: completedAt,
    freshness: request.sourceMode === "fixture" ? "fixture" : input.providerErrors?.length ? "partial" : "current",
    freshnessMessage: request.sourceMode === "fixture"
      ? "Deterministic FRED vintage fixture — the P estimate is scenario-only and the Q base is protected."
      : `FRED ${request.fredSeries} observations aligned to vintage ${request.asOfDate}; availability metadata retained.`,
    sourceMode: request.sourceMode,
    measure: request.vasicekMeasureMode === "q-curve" ? "Q" : "P",
    providerHealth: [
      { provider: "FRED", state: request.sourceMode === "fixture" ? "fixture" : "current", message: `${fred.length} ${request.fredSeries} observations · vintage ${request.asOfDate}` },
      ...(request.vasicekIncludeEtfs ? [{ provider: "yfinance" as const, state: request.sourceMode === "fixture" ? "fixture" as const : overlays.length ? "current" as const : "partial" as const, message: overlays.length ? `${overlays.length} ETF PROXY overlays` : "ETF overlays unavailable" }] : []),
    ],
    observations: [{
      provider: "FRED", identifier: request.fredSeries, value: latest.value, observationTimestamp: `${latest.date}T16:00:00Z`,
      availableTimestamp: `${request.asOfDate}T00:00:00Z`, fetchedTimestamp: completedAt, vintage: fred[fred.length - 1].realtimeStart,
      unit: "decimal", currency: "USD",
    }],
    proposals: [
      makeProposal({ request, current: currentParameters, id: "shortRate", value: latest.value, measure: "Q", classification: "observed", selected: true, applicable: true, observationDate: latest.date, formula: "latest observation available by as-of date, percent divided by 100" }),
      ...qProposals,
    ],
    primaryTitle: `${request.fredSeries} history, long-run mean and conditional mean`,
    primarySummary: `Exact-discretized OU fit over ${pEstimate.window.join(" to ")}; removed observations remain visible with reasons.`,
    primarySeries: [
      { id: "rate", label: `${request.fredSeries} retained`, classification: "observed", points: preparedPoints.map((point, index) => ({ x: index, y: point.value, label: point.date, excluded: point.excluded, rejectionReason: point.exclusionReason })) },
      { id: "conditional", label: "Conditional mean Eᴾ[rₜ₊Δ|rₜ]", classification: "scenario", points: conditional },
      { id: "long-run", label: "Long-run mean bᴾ", classification: "scenario", points: preparedPoints.map((point, index) => ({ x: index, y: pEstimate.parameters.longRunRate, label: point.date })) },
    ],
    secondaryTitle: "OU residuals, confidence intervals and duration proxies",
    secondarySummary: "Standardized residuals and lag diagnostics assess the P fit. Optional Treasury ETF histories validate only direction and broad duration response.",
    secondarySeries: [
      { id: "residuals", label: "Standardized OU residual", classification: "scenario", points: pEstimate.residuals.map((value, x) => ({ x, y: value / residualStd })) },
      ...overlays.map((overlay) => ({ id: overlay.symbol, label: `${overlay.symbol} ${overlay.durationBand} PROXY`, classification: "proxy" as const, points: overlay.points.map((point, x) => ({ x, y: point.normalizedValue, label: point.date })) })),
    ],
    diagnostics: [
      { label: "Measure", value: request.vasicekMeasureMode === "historical-p" ? "P historical scenario · Q base protected" : qCalibration ? "Q cross-sectional calibration" : "Q mode · calibration unavailable" },
      { label: "Estimator", value: pEstimate.estimatorVersion },
      { label: "Window", value: `${pEstimate.window[0]} → ${pEstimate.window[1]}` },
      { label: "Sampling", value: `${pEstimate.sampling} · Δ ${pEstimate.sampleIntervalYears.toFixed(6)} years` },
      { label: "Usable observations", value: `${pEstimate.observations} · ${removedObservations.length} removed` },
      { label: "Lag-1 residual ACF", value: pEstimate.residualDiagnostics.lag1Autocorrelation.toFixed(4) },
      { label: "Jarque–Bera", value: pEstimate.residualDiagnostics.jarqueBera.toFixed(3) },
      ...(qCalibration ? [{ label: "Q curve objective", value: `${qCalibration.objective.toExponential(3)} · max ${qCalibration.maximumError.toExponential(3)}` }] : []),
    ],
    validationIssues: [],
    warnings,
    vasicek: {
      series: request.fredSeries,
      snapshotId,
      vintage: request.asOfDate,
      availabilityTimestamp: `${request.asOfDate}T00:00:00Z`,
      latestObservation: latest,
      preparedPoints,
      removedObservations,
      pEstimate,
      qCalibration,
      etfOverlays: overlays,
      requestedMeasureMode: request.vasicekMeasureMode,
    },
  };
}

function seededNormal(seed: number): () => number {
  let state = seed >>> 0;
  const uniform = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return () => {
    if (spare != null) { const result = spare; spare = null; return result; }
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12)));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

export function createVasicekFixtureSnapshot(request: MarketDataRequest, currentParameters: Record<string, string>): MarketSnapshot {
  const normal = seededNormal(80421);
  const start = new Date(`${request.vasicekWindowStart}T00:00:00Z`);
  const end = new Date(`${request.vasicekWindowEnd}T00:00:00Z`);
  const parameters = { meanReversion: 0.72, longRunRate: 0.043, rateVolatility: 0.0115 };
  const dt = 1 / 252;
  const phi = Math.exp(-parameters.meanReversion * dt);
  const innovation = parameters.rateVolatility * Math.sqrt((1 - phi ** 2) / (2 * parameters.meanReversion));
  let rate = 0.0525;
  const fred: NormalizedFredObservation[] = [];
  let index = 0;
  for (let date = start; date <= end; date = new Date(date.getTime() + 86_400_000)) {
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    rate = parameters.longRunRate + phi * (rate - parameters.longRunRate) + innovation * normal();
    index += 1;
    if (index % 97 === 0) continue;
    const displayed = index === 333 ? rate + 0.018 : rate;
    fred.push({ seriesId: request.fredSeries, date: date.toISOString().slice(0, 10), value: displayed * 100, realtimeStart: request.asOfDate, realtimeEnd: request.asOfDate });
  }
  const latest = fred[fred.length - 1].value / 100;
  const etfHistories = request.vasicekIncludeEtfs ? Object.fromEntries((["SHY", "IEF", "TLT"] as const).map((symbol) => {
    const duration = symbol === "SHY" ? 1.8 : symbol === "IEF" ? 7.2 : 16.5;
    let level = 100;
    let previousRate = fred[0].value / 100;
    const points = fred.map((item, pointIndex) => {
      const itemRate = item.value / 100;
      level *= Math.exp(-duration * (itemRate - previousRate) + 0.00004 * Math.sin(pointIndex / 13));
      previousRate = itemRate;
      return { date: item.date, close: level, adjustedClose: level, volume: 1_000_000, dividends: 0, splits: 0 };
    });
    return [symbol, points];
  })) as Partial<Record<"SHY" | "IEF" | "TLT", YFinanceHistoryPoint[]>> : undefined;
  const qTrue = { meanReversion: 0.44, longRunRate: 0.0395, rateVolatility: 0.0092 };
  const qCurveInstruments = request.vasicekMeasureMode === "q-curve"
    ? [0.25, 0.5, 1, 2, 5, 10].map((maturity) => ({ id: `USD-ZC-${maturity}Y`, maturity, price: vasicekBondPrice({ shortRate: latest, ...qTrue }, maturity) }))
    : undefined;
  return buildVasicekRateHistorySnapshot({ request, currentParameters, fred, etfHistories, qCurveInstruments });
}

export function createVasicekHistoricalScenario(snapshot: MarketSnapshot, createdAt = new Date().toISOString()): VasicekHistoricalScenario {
  if (!snapshot.vasicek) throw new Error("Only a Vasicek rate-history snapshot can be saved as a historical scenario.");
  const estimate = snapshot.vasicek.pEstimate;
  return {
    id: `vasicek-p-${snapshot.id}-${createdAt}`,
    snapshotId: snapshot.id,
    createdAt,
    measure: "P",
    series: snapshot.vasicek.series,
    vintage: snapshot.vasicek.vintage,
    estimatorVersion: estimate.estimatorVersion,
    window: estimate.window,
    sampling: estimate.sampling,
    parameters: { ...estimate.parameters },
    intervals: structuredClone(estimate.intervals),
  };
}
