import assert from "node:assert/strict";
import test from "node:test";
import {
  isMonteCarloResultTabAvailable,
  validateMonteCarloControls,
} from "../app/lib/monte-carlo/index.ts";

const validEnabled = {
  enabled: true,
  eligible: true,
  paths: "10000",
  timeSteps: "252",
  seed: "20250308",
};

test("disabled Monte Carlo preserves PDE-only validation while valid enabled controls pass", () => {
  assert.deepEqual(validateMonteCarloControls({ ...validEnabled, enabled: false, paths: "invalid", seed: "-1" }), []);
  assert.deepEqual(validateMonteCarloControls(validEnabled), []);
});

test("Monte Carlo control bounds reject unsupported, fractional, and out-of-range values", () => {
  const issues = validateMonteCarloControls({
    enabled: true,
    eligible: false,
    paths: "99.5",
    timeSteps: "2001",
    seed: "4294967296",
  });
  assert.equal(issues.length, 4);
  assert.match(issues[0], /supported equity and short-rate contracts/);
  assert.match(issues[1], /100 to 100,000/);
  assert.match(issues[2], /1 to 2,000/);
  assert.match(issues[3], /4,294,967,295/);
});

test("production Heston antithetic paths require an even count", () => {
  const issues = validateMonteCarloControls({ ...validEnabled, paths: "10001", requiresEvenPaths: true });
  assert.deepEqual(issues, ["Heston antithetic variance reduction requires an even Monte Carlo path count."]);
  assert.deepEqual(validateMonteCarloControls({ ...validEnabled, paths: "10000", requiresEvenPaths: true }), []);
});

test("Monte Carlo result tab requires both an eligible contract and a completed payload", () => {
  assert.equal(isMonteCarloResultTabAvailable(true, false), false);
  assert.equal(isMonteCarloResultTabAvailable(false, true), false);
  assert.equal(isMonteCarloResultTabAvailable(true, true), true);
});
