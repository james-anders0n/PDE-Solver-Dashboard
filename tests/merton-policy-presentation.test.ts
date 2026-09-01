import assert from "node:assert/strict";
import test from "node:test";

import {
  MERTON_POLICY_UNIT,
  formatAllocationShareOfWealth,
  formatDollarAllocation,
  presentMertonPolicy,
} from "../app/lib/merton-policy-presentation.ts";
import { mertonAnalyticPolicy } from "../app/lib/pde-engine/merton-hjb.ts";

test("Merton policy is presented as a dollar allocation, not a percentage", () => {
  const policy = 115.447;
  const presented = presentMertonPolicy({
    policy,
    analyticPolicy: 115.5,
    wealth: 100,
    controlMin: -100,
    controlMax: 200,
    policyAbsoluteError: 0.053,
  });

  assert.equal(presented.unit, MERTON_POLICY_UNIT);
  assert.equal(presented.nativeValue, "$115.45");
  assert.equal(presented.shareOfWealthValue, "115.45%");
  assert.equal(presented.boundsValue, "-$100.00 to $200.00");
  assert.notEqual(presented.shareOfWealthValue, "11,544.70%");
});

test("the wealth share is calculated separately from the native dollar policy", () => {
  const analyticPolicy = mertonAnalyticPolicy(100, {
    rate: 0.03,
    expectedReturn: 0.08,
    volatility: 0.12,
    riskAversion: 3,
  });

  assert.equal(formatDollarAllocation(analyticPolicy), "$115.74");
  assert.equal(formatAllocationShareOfWealth(analyticPolicy, 100), "115.74%");
  assert.equal(formatAllocationShareOfWealth(analyticPolicy, 0), null);
});
