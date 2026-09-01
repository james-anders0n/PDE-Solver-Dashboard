import { economicForecastServiceConfig } from "../../../lib/economic-forecast/server.ts";

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Cross-origin refresh rejected." }, { status: 403 });
  const config = economicForecastServiceConfig();
  if (!config) return Response.json({ error: "Authenticated forecast refresh is not configured." }, { status: 503 });
  const response = await fetch(`${config.url}/refresh`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) return Response.json({ error: "Forecast refresh service rejected the job." }, { status: 502 });
  return Response.json(await response.json(), { status: 202, headers: { "Cache-Control": "no-store" } });
}
