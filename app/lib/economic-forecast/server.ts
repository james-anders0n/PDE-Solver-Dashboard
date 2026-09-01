import { ECONOMIC_FORECAST_FIXTURE } from "./fixtures.ts";
import type { EconomicForecastApiResponse, EconomicForecastSnapshot } from "./types.ts";
import { validateEconomicForecastSnapshot } from "./validate.ts";

let lastKnownGood: EconomicForecastSnapshot = ECONOMIC_FORECAST_FIXTURE;

export async function readLatestEconomicForecast(): Promise<EconomicForecastApiResponse> {
  const serviceUrl = process.env.ECONOMIC_FORECAST_SERVICE_URL?.replace(/\/$/, "") ?? "";
  const serviceToken = process.env.ECONOMIC_FORECAST_SERVICE_TOKEN ?? "";
  const refreshEnabled = Boolean(serviceUrl && serviceToken);
  try {
    const { readPersistedLatestForecast } = await import("./operations-server.ts");
    const persisted = await readPersistedLatestForecast();
    if (persisted) {
      lastKnownGood = persisted;
      const stale = Date.parse(persisted.target.releaseTimestamp) <= Date.now();
      return { snapshot: stale ? { ...persisted, freshness: "stale", freshnessMessage: "The persisted accepted target release has passed; the immutable last-known-good run remains served." } : persisted, source: "live", servedAt: new Date().toISOString(), stale, warning: stale ? "Persisted accepted snapshot is stale; a scheduled release-triggered refresh is required." : null, refresh: { enabled: refreshEnabled, reason: refreshEnabled ? null : "Interactive refresh is disabled; scheduled ingestion may still be active." } };
    }
  } catch {
    // D1/R2 availability must never prevent the service or bundled LKG fallback.
  }
  if (!serviceUrl) return fallback("Forecast service is not configured; showing the bundled last-known-good research snapshot.", refreshEnabled);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${serviceUrl}/latest`, { headers: serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}, signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("Forecast service did not return an accepted snapshot.");
    const snapshot = validateEconomicForecastSnapshot(await response.json());
    if (snapshot.status !== "accepted") throw new Error("Forecast service returned a non-accepted snapshot.");
    lastKnownGood = snapshot;
    const stale = Date.parse(snapshot.target.releaseTimestamp) <= Date.now();
    return { snapshot: stale ? { ...snapshot, freshness: "stale", freshnessMessage: "The target release time has passed. A refresh is required; this accepted run remains the last known good snapshot." } : snapshot, source: "live", servedAt: new Date().toISOString(), stale, warning: stale ? "Accepted snapshot is stale; the previous run remains visible." : null, refresh: { enabled: refreshEnabled, reason: refreshEnabled ? null : "Refresh service credentials are not configured." } };
  } catch {
    return fallback("Forecast service is unavailable; preserving the last-known-good snapshot.", refreshEnabled);
  } finally {
    clearTimeout(timeout);
  }
}

function fallback(warning: string, refreshEnabled: boolean): EconomicForecastApiResponse {
  return { snapshot: { ...lastKnownGood, freshness: "stale", freshnessMessage: warning }, source: lastKnownGood === ECONOMIC_FORECAST_FIXTURE ? "bundled-fallback" : "last-known-good", servedAt: new Date().toISOString(), stale: true, warning, refresh: { enabled: refreshEnabled, reason: refreshEnabled ? null : "Set ECONOMIC_FORECAST_SERVICE_URL and ECONOMIC_FORECAST_SERVICE_TOKEN on the server to enable refresh." } };
}

export function economicForecastServiceConfig(): { url: string; token: string } | null {
  const url = process.env.ECONOMIC_FORECAST_SERVICE_URL?.replace(/\/$/, "") ?? "";
  const token = process.env.ECONOMIC_FORECAST_SERVICE_TOKEN ?? "";
  return url && token ? { url, token } : null;
}
