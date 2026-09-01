import { parseFredValue } from "./normalization.ts";

export interface FredObservationResponse {
  realtime_start: string;
  realtime_end: string;
  observation_start: string;
  observation_end: string;
  units: string;
  output_type: number;
  file_type: string;
  order_by: string;
  sort_order: string;
  count: number;
  offset: number;
  limit: number;
  observations: Array<{
    realtime_start: string;
    realtime_end: string;
    date: string;
    value: string;
  }>;
}

export interface NormalizedFredObservation {
  seriesId: string;
  date: string;
  value: number;
  realtimeStart: string;
  realtimeEnd: string;
  availableDate?: string;
}

export async function fetchFredObservations(options: {
  seriesId: string;
  apiKey: string;
  observationStart?: string;
  observationEnd: string;
  vintageDate?: string;
  signal?: AbortSignal;
}): Promise<NormalizedFredObservation[]> {
  if (!options.apiKey) throw new Error("FRED_API_KEY is not configured on the server.");
  const query = new URLSearchParams({
    series_id: options.seriesId,
    api_key: options.apiKey,
    file_type: "json",
    observation_end: options.observationEnd,
    realtime_start: options.vintageDate ?? options.observationEnd,
    realtime_end: options.vintageDate ?? options.observationEnd,
    sort_order: "asc",
  });
  if (options.observationStart) query.set("observation_start", options.observationStart);
  const response = await fetch(`https://api.stlouisfed.org/fred/series/observations?${query}`, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`FRED request failed with status ${response.status}.`);
  const payload = await response.json() as FredObservationResponse;
  return payload.observations.flatMap((item) => {
    const value = parseFredValue(item.value);
    return value == null ? [] : [{
      seriesId: options.seriesId,
      date: item.date,
      value,
      realtimeStart: item.realtime_start,
      realtimeEnd: item.realtime_end,
    }];
  });
}
