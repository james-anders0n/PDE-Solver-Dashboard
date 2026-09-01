import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GET as getForecast } from "../app/api/economic-forecast/route.ts";
import { POST as refreshForecast } from "../app/api/economic-forecast/refresh/route.ts";
import { ECONOMIC_FORECAST_FIXTURE } from "../app/lib/economic-forecast/fixtures.ts";
import { readLatestEconomicForecast } from "../app/lib/economic-forecast/server.ts";
import { validateEconomicForecastSnapshot } from "../app/lib/economic-forecast/validate.ts";

test("GET economic forecast is cheap, cacheable, and preserves the fallback", async () => {
  const previousUrl = process.env.ECONOMIC_FORECAST_SERVICE_URL;
  const previousToken = process.env.ECONOMIC_FORECAST_SERVICE_TOKEN;
  delete process.env.ECONOMIC_FORECAST_SERVICE_URL;
  delete process.env.ECONOMIC_FORECAST_SERVICE_TOKEN;
  try {
    const response = await getForecast();
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /max-age=30/);
    assert.equal(payload.source, "bundled-fallback");
    assert.equal(payload.refresh.enabled, false);
    assert.equal(payload.snapshot.runId, ECONOMIC_FORECAST_FIXTURE.runId);
  } finally {
    if (previousUrl) process.env.ECONOMIC_FORECAST_SERVICE_URL = previousUrl;
    if (previousToken) process.env.ECONOMIC_FORECAST_SERVICE_TOKEN = previousToken;
  }
});

test("snapshot validation rejects draw payloads with inconsistent histograms", () => {
  const invalid = structuredClone(ECONOMIC_FORECAST_FIXTURE);
  invalid.distribution.histogram[0].count += 1;
  assert.throws(() => validateEconomicForecastSnapshot(invalid), /histogram counts/i);
});

test("a validated service snapshot becomes the live last-known-good response", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.ECONOMIC_FORECAST_SERVICE_URL;
  const previousToken = process.env.ECONOMIC_FORECAST_SERVICE_TOKEN;
  process.env.ECONOMIC_FORECAST_SERVICE_URL = "https://forecast.internal";
  process.env.ECONOMIC_FORECAST_SERVICE_TOKEN = "server-only-test-token";
  const accepted = structuredClone(ECONOMIC_FORECAST_FIXTURE);
  accepted.status = "accepted";
  accepted.freshness = "current";
  accepted.distribution.status = "accepted";
  accepted.distribution.accepted = true;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer server-only-test-token");
    return Response.json(accepted);
  };
  try {
    const payload = await readLatestEconomicForecast();
    assert.equal(payload.source, "live");
    assert.equal(payload.snapshot.status, "accepted");
    assert.equal(payload.refresh.enabled, true);
    assert.doesNotMatch(JSON.stringify(payload), /server-only-test-token/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl) process.env.ECONOMIC_FORECAST_SERVICE_URL = previousUrl;
    else delete process.env.ECONOMIC_FORECAST_SERVICE_URL;
    if (previousToken) process.env.ECONOMIC_FORECAST_SERVICE_TOKEN = previousToken;
    else delete process.env.ECONOMIC_FORECAST_SERVICE_TOKEN;
  }
});

test("refresh is same-origin and disabled without server credentials", async () => {
  const crossOrigin = await refreshForecast(new Request("https://dashboard.test/api/economic-forecast/refresh", { method: "POST", headers: { Origin: "https://attacker.test" } }));
  assert.equal(crossOrigin.status, 403);
  const local = await refreshForecast(new Request("https://dashboard.test/api/economic-forecast/refresh", { method: "POST", headers: { Origin: "https://dashboard.test" } }));
  assert.equal(local.status, 503);
});

test("forecast credentials stay server-side and GET never invokes Python", async () => {
  const [server, route, page, sidecar] = await Promise.all([
    readFile(new URL("../app/lib/economic-forecast/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/economic-forecast/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/economic-forecast/main.py", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(server + route + page, /NEXT_PUBLIC_(?:FRED|ECONOMIC_FORECAST)/);
  assert.doesNotMatch(route, /run_pipeline|python|subprocess/i);
  assert.match(sidecar, /BoundedJobExecutor/);
  assert.match(sidecar, /job_executor\.submit/);
  assert.match(sidecar, /latest\.json/);
  assert.match(sidecar, /run_pipeline/);
});
