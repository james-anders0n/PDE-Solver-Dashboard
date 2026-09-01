import assert from "node:assert/strict";
import test from "node:test";
import katex from "katex";
import { MODEL_KEYS, MODEL_SPECS } from "../app/lib/pde-spec.ts";

const render = (math: string) => katex.renderToString(math, {
  displayMode: true,
  output: "htmlAndMathml",
  throwOnError: true,
});

test("all governing equations and contract conditions are valid KaTeX", () => {
  for (const model of MODEL_KEYS) {
    const specification = MODEL_SPECS[model];
    assert.match(specification.equation, /\\frac/);
    assert.match(render(specification.state), /class="katex-display"/);
    assert.match(render(specification.equation), /class="frac-line"/);

    for (const contract of specification.contracts) {
      for (const condition of [
        ...Object.values(contract.terminalCondition),
        ...Object.values(contract.boundaryCondition),
      ]) {
        if (condition) assert.match(render(condition), /class="katex-display"/);
      }
    }
  }
});

