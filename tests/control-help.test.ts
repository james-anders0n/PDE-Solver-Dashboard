import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_CONTROL_HELP,
  MARKET_CONTROL_IDS_BY_MODEL,
  SOLVER_CONTROL_HELP,
  SOLVER_CONTROL_IDS,
  SOLVER_PARAMETER_HELP,
  assertControlHelpCoverage,
  getMarketProposalHelp,
  getSolverParameterHelp,
} from "../app/lib/control-help.ts";
import { MODEL_KEYS, MODEL_SPECS, defaultParameters, getActiveParameters } from "../app/lib/pde-spec.ts";
import { createFixtureSnapshot, defaultMarketRequest } from "../app/lib/market-data/index.ts";

test("every rendered Market Data and Solver Studio control has registered help", () => {
  assert.doesNotThrow(assertControlHelpCoverage);
  for (const model of MODEL_KEYS) {
    for (const id of MARKET_CONTROL_IDS_BY_MODEL[model]) {
      assert.ok(MARKET_CONTROL_HELP[id].description.length > 30, `${model}:${id} has concise descriptive help`);
      assert.ok(MARKET_CONTROL_HELP[id].context.length > 5, `${model}:${id} identifies its context`);
    }
    for (const contract of MODEL_SPECS[model].contracts) {
      for (const parameter of getActiveParameters(model, contract.id)) {
        const help = getSolverParameterHelp(model, parameter);
        assert.equal(help, SOLVER_PARAMETER_HELP[`${model}:${parameter.id}`]);
        assert.match(help.context, new RegExp(`${MODEL_SPECS[model].measure}-measure`));
      }
    }
  }
  for (const id of SOLVER_CONTROL_IDS) assert.ok(SOLVER_CONTROL_HELP[id]);
});

test("every fixture parameter-mapping row has classification, measure, units and model effect help", () => {
  for (const model of MODEL_KEYS) {
    const contract = MODEL_SPECS[model].contracts[0].id;
    const snapshot = createFixtureSnapshot(defaultMarketRequest(model), defaultParameters(model, contract));
    for (const proposal of snapshot.proposals) {
      const help = getMarketProposalHelp(model, proposal);
      assert.match(help.description, new RegExp(proposal.classification, "i"));
      assert.match(help.description, new RegExp(`${proposal.provenance.measure}-measure`));
      assert.match(help.context, new RegExp(proposal.provenance.unit));
      assert.ok(help.description.length > 50, `${model}:${proposal.id} explains its effect`);
    }
  }
});
