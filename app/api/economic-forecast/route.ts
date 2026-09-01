import { readLatestEconomicForecast } from "../../lib/economic-forecast/server.ts";

export async function GET(): Promise<Response> {
  const payload = await readLatestEconomicForecast();
  return Response.json(payload, { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=300", ETag: `"${payload.snapshot.runId}"`, Vary: "Authorization" } });
}
