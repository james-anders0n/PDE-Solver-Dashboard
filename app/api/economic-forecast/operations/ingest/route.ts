import { persistForecastRun, recordForecastFailure } from "../../../../lib/economic-forecast/operations-server.ts";

function authorised(request: Request): boolean {
  const expected = process.env.ECONOMIC_FORECAST_INGEST_TOKEN ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || expected.length !== supplied.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 12_000_000) return Response.json({ error: "Ingestion payload exceeds 12 MB." }, { status: 413 });
  try {
    const payload = await request.json() as Record<string, unknown>;
    if (payload.failure && !payload.snapshot) {
      await recordForecastFailure(payload.failure as { runId?: string; stage: string; code: string; message: string });
      return Response.json({ recorded: true, latestPreserved: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    const result = await persistForecastRun(payload as unknown as Parameters<typeof persistForecastRun>[0]);
    return Response.json({ ...result, latestAdvanced: result.accepted && !result.duplicate, latestPreserved: !result.accepted }, { status: result.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid ingestion payload.";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
