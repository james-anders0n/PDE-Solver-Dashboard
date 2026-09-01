import { persistOfficialReleaseCalendar } from "../../../../lib/economic-forecast/operations-server.ts";

function authorised(request: Request): boolean {
  const expected = process.env.ECONOMIC_FORECAST_INGEST_TOKEN ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return Boolean(expected && expected === supplied);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const count = await persistOfficialReleaseCalendar(await request.json() as Parameters<typeof persistOfficialReleaseCalendar>[0]);
    return Response.json({ imported: count }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Calendar import failed." }, { status: 400 });
  }
}
