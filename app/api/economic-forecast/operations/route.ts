import { readForecastOperations } from "../../../lib/economic-forecast/operations-server.ts";

export async function GET(): Promise<Response> {
  try {
    const payload = await readForecastOperations();
    return Response.json(payload, { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=120", Vary: "Authorization" } });
  } catch {
    return Response.json({ error: "Operational status is temporarily unavailable; forecast serving remains isolated." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
