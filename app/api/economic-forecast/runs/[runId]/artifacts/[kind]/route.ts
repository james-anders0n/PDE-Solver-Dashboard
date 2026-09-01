import { readForecastArtifact } from "../../../../../../lib/economic-forecast/operations-server.ts";

const KINDS = new Set(["snapshot", "csv", "report", "draws"]);

export async function GET(_request: Request, context: { params: Promise<{ runId: string; kind: string }> }): Promise<Response> {
  const { runId, kind } = await context.params;
  if (!KINDS.has(kind)) return Response.json({ error: "Unknown artifact kind." }, { status: 404 });
  try {
    const object = await readForecastArtifact(runId, kind as "snapshot" | "csv" | "report" | "draws");
    if (!object) return Response.json({ error: "Artifact not found or expired." }, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "private, max-age=3600, immutable");
    return new Response(object.body, { headers });
  } catch {
    return Response.json({ error: "Invalid artifact request." }, { status: 400 });
  }
}
