import assert from "node:assert/strict";
import test from "node:test";
import { evaluateNumericalAcceptance } from "../app/lib/numerical-acceptance.ts";

const result = (absoluteError: number, maxNormError: number, finite = true) => ({
  absoluteError,
  maxNormError,
  solution: { diagnostics: { finite } },
});

const tolerance = { pointwiseAbsolute: 5e-3, maxNorm: 2e-2, observedOrder: 1.5 };

test("numerical acceptance reports the exact failed gates", () => {
  const evaluation = evaluateNumericalAcceptance({
    result: result(6e-3, 3e-2, false),
    convergence: [{ absoluteError: 1e-2, observedOrder: null }, { absoluteError: 6e-3, observedOrder: 1.1 }],
    tolerance,
  });
  assert.equal(evaluation.accepted, false);
  assert.equal(evaluation.issues.length, 4);
  assert.match(evaluation.issues.join(" "), /Point error/);
  assert.match(evaluation.issues.join(" "), /Maximum-norm error/);
  assert.match(evaluation.issues.join(" "), /Observed convergence order/);
  assert.match(evaluation.issues.join(" "), /non-finite/);
});

test("observed order does not false-fail after both finest levels reach the point-error floor", () => {
  const evaluation = evaluateNumericalAcceptance({
    result: result(8e-4, 8e-3),
    convergence: [{ absoluteError: 4e-3, observedOrder: null }, { absoluteError: 8e-4, observedOrder: 0.7 }],
    tolerance,
  });
  assert.equal(evaluation.accepted, true);
  assert.equal(evaluation.observedOrderAcceptedByErrorFloor, true);
  assert.deepEqual(evaluation.issues, []);
});

test("observed order still fails when refinement errors have not reached tolerance", () => {
  const evaluation = evaluateNumericalAcceptance({
    result: result(4e-3, 8e-3),
    convergence: [{ absoluteError: 7e-3, observedOrder: null }, { absoluteError: 4e-3, observedOrder: 0.7 }],
    tolerance,
  });
  assert.equal(evaluation.accepted, false);
  assert.equal(evaluation.observedOrderAcceptedByErrorFloor, false);
  assert.match(evaluation.issues[0], /Observed convergence order/);
});
