import { economicForecastServiceConfig } from "../../../../lib/economic-forecast/server.ts";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return Response.json({ error: "Invalid refresh job ID." }, { status: 400 });
  const config = economicForecastServiceConfig();
  if (!config) return Response.json({ error: "Authenticated forecast refresh is not configured." }, { status: 503 });
  const response = await fetch(`${config.url}/jobs/${jobId}`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(5_000), cache: "no-store" });
  if (!response.ok) return Response.json({ error: "Forecast refresh status is unavailable." }, { status: response.status === 404 ? 404 : 502 });
  return Response.json(await response.json(), { headers: { "Cache-Control": "no-store" } });
}
