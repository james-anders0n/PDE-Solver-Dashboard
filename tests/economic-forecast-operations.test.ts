import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ECONOMIC_FORECAST_FIXTURE } from "../app/lib/economic-forecast/fixtures.ts";
import { compactRunRecord, immutableArtifactPrefix, sanitizeOperationalText } from "../app/lib/economic-forecast/operations.ts";

test("accepted and rejected runs retain compact reproducibility metadata", () => {
  const accepted = { ...ECONOMIC_FORECAST_FIXTURE, status: "accepted" as const, distribution: { ...ECONOMIC_FORECAST_FIXTURE.distribution, accepted: true, coverage: ECONOMIC_FORECAST_FIXTURE.distribution.coverage.map((item) => ({ ...item, accepted: true })) } };
  const acceptedRecord = compactRunRecord(accepted);
  assert.equal(acceptedRecord.accepted, true);
  assert.equal(acceptedRecord.seed, accepted.distribution.seed);
  assert.equal(acceptedRecord.distributionMethodVersion, accepted.distribution.methodVersion);
  const rejectedRecord = compactRunRecord(ECONOMIC_FORECAST_FIXTURE, { stage: "coverage", code: "calibration-gate", message: "token=abcdefghijklmnopqrstuvwx123456789" });
  assert.equal(rejectedRecord.accepted, false);
  assert.equal(rejectedRecord.status, "rejected");
  assert.doesNotMatch(rejectedRecord.failureMessage ?? "", /abcdefghijkl/);
});

test("artifact paths are immutable and traversal-safe", () => {
  assert.equal(immutableArtifactPrefix("run-20260824-cpi"), "economic-forecast/runs/run-20260824-cpi");
  assert.throws(() => immutableArtifactPrefix("../../latest"));
  assert.throws(() => immutableArtifactPrefix("short"));
});

test("structured operational text removes common credential forms", () => {
  const result = sanitizeOperationalText("api_key=abc123 bearer: 12345678901234567890123456789012");
  assert.doesNotMatch(result, /abc123|1234567890/);
});

test("latest pointer mutation exists only in the accepted ingestion branch", () => {
  const source = readFileSync(new URL("../app/lib/economic-forecast/operations-server.ts", import.meta.url), "utf8");
  const branch = source.slice(source.indexOf("if (compact.accepted)"), source.indexOf("await bindings.DB.batch(statements)"));
  assert.match(branch, /latest_accepted_run_id/);
  assert.match(branch, /else\s*\{[\s\S]*consecutive_acceptance_failures/);
  assert.equal((source.match(/stateStatement\(bindings\.DB, "latest_accepted_run_id"/g) ?? []).length, 1);
});
