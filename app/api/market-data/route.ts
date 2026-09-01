import { fetchFredObservations } from "@/app/lib/market-data/fred-client";
import { bracketFredRateSeries, buildBlackScholesSnapshot } from "@/app/lib/market-data/black-scholes-snapshot";
import { buildHestonSurfaceSnapshot, relevantVixInstrument } from "@/app/lib/market-data/heston-snapshot";
import { actual365YearFraction } from "@/app/lib/market-data/normalization";
import { createPartialLiveSnapshot, needsEquityProvider } from "@/app/lib/market-data/live-snapshot";
import { buildVasicekRateHistorySnapshot } from "@/app/lib/market-data/vasicek-snapshot";
import { buildHullWhiteCurveSnapshot, type HullWhiteEtfOptionInput } from "@/app/lib/market-data/hull-white-curve";
import { buildMertonOpportunitySnapshot } from "@/app/lib/market-data/merton-opportunity";
import type { MarketDataRequest } from "@/app/lib/market-data/types";
import {
  fetchYFinanceExpirations,
  fetchYFinanceHistory,
  fetchYFinanceOptionChain,
  fetchYFinanceQuote,
} from "@/app/lib/market-data/yfinance-client";

const shiftDate = (value: string, days: number): string => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const sampleExpirations = (expirations: string[], maximum = 8): string[] => {
  if (expirations.length <= maximum) return expirations;
  return Array.from({ length: maximum }, (_, index) => expirations[Math.round(index * (expirations.length - 1) / (maximum - 1))]);
};

export async function POST(request: Request): Promise<Response> {
  const body = await request.json() as { request?: MarketDataRequest; currentParameters?: Record<string, string> };
  if (!body.request || !body.currentParameters) {
    return Response.json({ error: "A typed market-data request and current parameters are required." }, { status: 400 });
  }
  const fredApiKey = process.env.FRED_API_KEY ?? "";
  const yfinanceServiceUrl = process.env.YFINANCE_SERVICE_URL ?? "";
  if (!fredApiKey && !yfinanceServiceUrl) {
    return Response.json({ error: "Live providers are not configured. Use the deterministic fixture mode or configure the server environment." }, { status: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const providerErrors: string[] = [];
  try {
    if (body.request.model === "Black–Scholes") {
      const historyStart = shiftDate(body.request.asOfDate, -550);
      const historyEnd = shiftDate(body.request.asOfDate, 1);
      const [quote, historyPayload, expirationPayload] = await Promise.all([
        yfinanceServiceUrl
          ? fetchYFinanceQuote(yfinanceServiceUrl, body.request.instrument, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        yfinanceServiceUrl
          ? fetchYFinanceHistory(yfinanceServiceUrl, body.request.instrument, historyStart, historyEnd, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        yfinanceServiceUrl
          ? fetchYFinanceExpirations(yfinanceServiceUrl, body.request.instrument, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
      ]);
      const availableExpirations = expirationPayload?.expirations.filter((item) => item > body.request!.asOfDate).sort() ?? [];
      const selectedExpiration = body.request.optionExpiration && availableExpirations.includes(body.request.optionExpiration)
        ? body.request.optionExpiration
        : availableExpirations[0] ?? body.request.optionExpiration;
      if (!selectedExpiration) {
        return Response.json({ error: providerErrors.join(" ") || "No future yfinance option expiration was available." }, { status: 502 });
      }
      const maturity = actual365YearFraction(body.request.asOfDate, selectedExpiration);
      const rateSeries = bracketFredRateSeries(maturity);
      const [chainPayload, fredResults] = await Promise.all([
        yfinanceServiceUrl
          ? fetchYFinanceOptionChain(yfinanceServiceUrl, body.request.instrument, selectedExpiration, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        fredApiKey
          ? Promise.all(rateSeries.map((seriesId) => fetchFredObservations({
            seriesId,
            apiKey: fredApiKey,
            observationStart: shiftDate(body.request!.asOfDate, -14),
            observationEnd: body.request!.asOfDate,
            signal: controller.signal,
          }).catch((error: Error) => { providerErrors.push(`${seriesId}: ${error.message}`); return []; })))
          : Promise.resolve([]),
      ]);
      if (!quote && !historyPayload && !chainPayload) {
        return Response.json({ error: providerErrors.join(" ") || "No yfinance Black–Scholes data was available." }, { status: 502 });
      }
      try {
        return Response.json(buildBlackScholesSnapshot({
          request: { ...body.request, optionExpiration: selectedExpiration },
          currentParameters: body.currentParameters,
          quote,
          history: historyPayload?.points,
          expirations: availableExpirations.length ? availableExpirations : [selectedExpiration],
          optionChain: chainPayload?.contracts,
          optionCurrency: chainPayload?.currency ?? historyPayload?.currency,
          fred: fredResults.flat(),
          providerErrors,
        }));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "The Black–Scholes snapshot could not be built." }, { status: 502 });
      }
    }

    if (body.request.model === "Heston") {
      const historyStart = shiftDate(body.request.asOfDate, -550);
      const historyEnd = shiftDate(body.request.asOfDate, 1);
      const [quote, historyPayload, expirationPayload] = await Promise.all([
        yfinanceServiceUrl
          ? fetchYFinanceQuote(yfinanceServiceUrl, body.request.instrument, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        yfinanceServiceUrl
          ? fetchYFinanceHistory(yfinanceServiceUrl, body.request.instrument, historyStart, historyEnd, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        yfinanceServiceUrl
          ? fetchYFinanceExpirations(yfinanceServiceUrl, body.request.instrument, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
      ]);
      const availableExpirations = expirationPayload?.expirations.filter((item) => item > body.request!.asOfDate).sort() ?? [];
      const retainedRange = sampleExpirations(availableExpirations.filter((item) =>
        item >= body.request!.hestonExpirationStart && item <= body.request!.hestonExpirationEnd));
      if (!retainedRange.length) {
        return Response.json({ error: providerErrors.join(" ") || "No yfinance expirations fell inside the selected Heston range." }, { status: 502 });
      }
      const rateSeries = [...new Set(retainedRange.flatMap((expiration) =>
        bracketFredRateSeries(actual365YearFraction(body.request!.asOfDate, expiration))))];
      const [chainResults, fredResults, vix] = await Promise.all([
        Promise.all(retainedRange.map((expiration) => yfinanceServiceUrl
          ? fetchYFinanceOptionChain(yfinanceServiceUrl, body.request!.instrument, expiration, controller.signal)
            .then((payload) => ({ expiration, currency: payload.currency, contracts: payload.contracts }))
            .catch((error: Error) => { providerErrors.push(`${expiration}: ${error.message}`); return undefined; })
          : Promise.resolve(undefined))),
        fredApiKey
          ? Promise.all(rateSeries.map((seriesId) => fetchFredObservations({
            seriesId, apiKey: fredApiKey, observationStart: shiftDate(body.request!.asOfDate, -14),
            observationEnd: body.request!.asOfDate, signal: controller.signal,
          }).catch((error: Error) => { providerErrors.push(`${seriesId}: ${error.message}`); return []; })))
          : Promise.resolve([]),
        fredApiKey && body.request.hestonIncludeVix && relevantVixInstrument(body.request.instrument)
          ? fetchFredObservations({
            seriesId: "VIXCLS", apiKey: fredApiKey, observationStart: shiftDate(body.request.asOfDate, -14),
            observationEnd: body.request.asOfDate, signal: controller.signal,
          }).catch((error: Error) => { providerErrors.push(`VIXCLS: ${error.message}`); return []; })
          : Promise.resolve([]),
      ]);
      try {
        return Response.json(buildHestonSurfaceSnapshot({
          request: body.request, currentParameters: body.currentParameters, quote, history: historyPayload?.points,
          expirations: availableExpirations, chains: chainResults.filter((item) => item != null),
          fred: fredResults.flat(), vix, providerErrors,
        }));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "The Heston surface snapshot could not be built." }, { status: 502 });
      }
    }

    if (body.request.model === "Vasicek") {
      if (body.request.fredSeries !== "SOFR" && body.request.fredSeries !== "DFF") {
        return Response.json({ error: "Vasicek rate-history fit supports only SOFR or DFF." }, { status: 400 });
      }
      const etfSymbols = body.request.vasicekIncludeEtfs ? (["SHY", "IEF", "TLT"] as const) : [];
      const [fred, etfResults] = await Promise.all([
        fredApiKey
          ? fetchFredObservations({
            seriesId: body.request.fredSeries,
            apiKey: fredApiKey,
            observationStart: body.request.vasicekWindowStart,
            observationEnd: body.request.vasicekWindowEnd,
            vintageDate: body.request.asOfDate,
            signal: controller.signal,
          }).catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        Promise.all(etfSymbols.map((symbol) => yfinanceServiceUrl
          ? fetchYFinanceHistory(yfinanceServiceUrl, symbol, body.request!.vasicekWindowStart, shiftDate(body.request!.vasicekWindowEnd, 1), controller.signal)
            .then((payload) => [symbol, payload.points] as const)
            .catch((error: Error) => { providerErrors.push(`${symbol}: ${error.message}`); return undefined; })
          : Promise.resolve(undefined))),
      ]);
      if (!fred?.length) return Response.json({ error: providerErrors.join(" ") || "No usable FRED rate history was available." }, { status: 502 });
      try {
        return Response.json(buildVasicekRateHistorySnapshot({
          request: body.request,
          currentParameters: body.currentParameters,
          fred,
          etfHistories: Object.fromEntries(etfResults.filter((item) => item != null)),
          providerErrors,
        }));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "The Vasicek rate-history snapshot could not be built." }, { status: 502 });
      }
    }

    if (body.request.model === "Hull–White") {
      const selectedSeries = [...new Set(body.request.hullWhiteSelectedSeries)];
      const fredResults = fredApiKey
        ? await Promise.all(selectedSeries.map((seriesId) => fetchFredObservations({
          seriesId,
          apiKey: fredApiKey,
          observationStart: shiftDate(body.request!.asOfDate, -35),
          observationEnd: body.request!.asOfDate,
          vintageDate: body.request!.asOfDate,
          signal: controller.signal,
        }).catch((error: Error) => { providerErrors.push(`${seriesId}: ${error.message}`); return []; })))
        : [];
      const etfOptions: HullWhiteEtfOptionInput[] = body.request.hullWhiteIncludeEtfOptions && yfinanceServiceUrl
        ? (await Promise.all((["SHY", "IEF", "TLT"] as const).map(async (symbol) => {
          try {
            const [quote, expirationPayload] = await Promise.all([
              fetchYFinanceQuote(yfinanceServiceUrl, symbol, controller.signal),
              fetchYFinanceExpirations(yfinanceServiceUrl, symbol, controller.signal),
            ]);
            const expiration = expirationPayload.expirations.filter((item) => item > body.request!.asOfDate).sort()[0];
            if (!expiration) throw new Error("No future option expiration was available.");
            const chain = await fetchYFinanceOptionChain(yfinanceServiceUrl, symbol, expiration, controller.signal);
            return { symbol, spot: quote.regularMarketPrice, expiration, contracts: chain.contracts } satisfies HullWhiteEtfOptionInput;
          } catch (error) {
            providerErrors.push(`${symbol}: ${error instanceof Error ? error.message : "ETF option data unavailable."}`);
            return undefined;
          }
        }))).filter((item) => item != null)
        : [];
      if (!fredResults.some((items) => items.length)) {
        return Response.json({ error: providerErrors.join(" ") || "No usable FRED curve pillars were available." }, { status: 502 });
      }
      try {
        return Response.json(buildHullWhiteCurveSnapshot({
          request: body.request,
          currentParameters: body.currentParameters,
          fred: fredResults.flat(),
          etfOptions,
          providerErrors,
        }));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "The Hull–White curve snapshot could not be built." }, { status: 502 });
      }
    }

    if (body.request.model === "HJB") {
      const historyStart = shiftDate(body.request.asOfDate, -Math.max(900, body.request.hjbHistorySessions * 2));
      const historyEnd = shiftDate(body.request.asOfDate, 1);
      const fredSeries = [...new Set([body.request.hjbOpportunityRateSeries, ...body.request.hjbRegimeSeries])];
      const [quote, historyPayload, fredResults] = await Promise.all([
        yfinanceServiceUrl
          ? fetchYFinanceQuote(yfinanceServiceUrl, body.request.instrument, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        yfinanceServiceUrl
          ? fetchYFinanceHistory(yfinanceServiceUrl, body.request.instrument, historyStart, historyEnd, controller.signal)
            .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
          : Promise.resolve(undefined),
        fredApiKey
          ? Promise.all(fredSeries.map((seriesId) => fetchFredObservations({
            seriesId,
            apiKey: fredApiKey,
            observationStart: historyStart,
            observationEnd: body.request!.asOfDate,
            vintageDate: body.request!.asOfDate,
            signal: controller.signal,
          }).catch((error: Error) => { providerErrors.push(`${seriesId}: ${error.message}`); return []; })))
          : Promise.resolve([]),
      ]);
      if (!historyPayload?.points.length) {
        return Response.json({ error: providerErrors.join(" ") || "No usable adjusted yfinance history was available." }, { status: 502 });
      }
      try {
        return Response.json(buildMertonOpportunitySnapshot({
          request: body.request,
          currentParameters: body.currentParameters,
          quote,
          history: historyPayload.points,
          historyCurrency: historyPayload.currency,
          fred: fredResults.flat(),
          providerErrors,
        }));
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "The Merton opportunity-set snapshot could not be built." }, { status: 502 });
      }
    }

    const [fred, quote] = await Promise.all([
      fredApiKey
        ? fetchFredObservations({ seriesId: body.request.fredSeries, apiKey: fredApiKey, observationEnd: body.request.asOfDate, signal: controller.signal })
          .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
        : Promise.resolve(undefined),
      needsEquityProvider(body.request.model) && yfinanceServiceUrl
        ? fetchYFinanceQuote(yfinanceServiceUrl, body.request.instrument, controller.signal)
          .catch((error: Error) => { providerErrors.push(error.message); return undefined; })
        : Promise.resolve(undefined),
    ]);
    if (!fred && !quote) {
      return Response.json({ error: providerErrors.join(" ") || "No live provider returned usable data." }, { status: 502 });
    }
    return Response.json(createPartialLiveSnapshot({
      request: body.request,
      currentParameters: body.currentParameters,
      fred,
      quote,
      providerErrors,
    }));
  } finally {
    clearTimeout(timeout);
  }
}
