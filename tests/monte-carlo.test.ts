import assert from "node:assert/strict";
import test from "node:test";
import {
  correlatedNormalPair,
  Mulberry32,
  NormalSampler,
  quantile,
  quantileRecord,
  quantiles,
  RunningStatistics,
  type MonteCarloConfig,
  type MonteCarloResult,
} from "../app/lib/monte-carlo/index.ts";

test("Mulberry32 has a stable seed sequence and emits values in the documented range", () => {
  const random = new Mulberry32(123_456_789);
  assert.deepEqual(
    Array.from({ length: 6 }, () => random.nextUint32()),
    [1_107_202_814, 4_169_434_471, 3_372_958_138, 885_470_128, 1_301_683_845, 3_208_624_240],
  );

  const first = new Mulberry32(0);
  const second = new Mulberry32(0);
  for (let index = 0; index < 1_000; index += 1) {
    const left = first.next();
    assert.equal(left, second.next());
    assert.ok(left >= 0 && left < 1);
  }

  assert.throws(() => new Mulberry32(-1), /seed must be an integer/);
  assert.throws(() => new Mulberry32(1.5), /seed must be an integer/);
  assert.throws(() => new Mulberry32(0x1_0000_0000), /seed must be an integer/);
});

test("Box–Muller normal sampling is reproducible and has standard-normal moments", () => {
  const pinned = new NormalSampler(new Mulberry32(123_456_789));
  const expected = [
    0.7591867812298841,
    -0.14100904075493853,
    0.4770723819937893,
    1.6881025056916517,
    -0.01566465839321832,
    -0.8496473635338612,
  ];
  assert.deepEqual(Array.from({ length: expected.length }, () => pinned.next()), expected);

  const sample = new RunningStatistics();
  const normal = new NormalSampler(new Mulberry32(20_260_822));
  for (let index = 0; index < 200_000; index += 1) sample.add(normal.next());
  assert.ok(Math.abs(sample.mean) < 0.01, `normal mean ${sample.mean}`);
  assert.ok(Math.abs(sample.populationVariance - 1) < 0.015, `normal variance ${sample.populationVariance}`);
});

test("correlated normal pairs preserve unit moments and requested correlation", () => {
  const requestedCorrelation = -0.7;
  const normal = new NormalSampler(new Mulberry32(1_701));
  const sampleCount = 200_000;
  let sumFirst = 0;
  let sumSecond = 0;
  let sumFirstSquared = 0;
  let sumSecondSquared = 0;
  let sumProduct = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const { first, second } = correlatedNormalPair(normal, requestedCorrelation);
    sumFirst += first;
    sumSecond += second;
    sumFirstSquared += first * first;
    sumSecondSquared += second * second;
    sumProduct += first * second;
  }

  const meanFirst = sumFirst / sampleCount;
  const meanSecond = sumSecond / sampleCount;
  const varianceFirst = sumFirstSquared / sampleCount - meanFirst * meanFirst;
  const varianceSecond = sumSecondSquared / sampleCount - meanSecond * meanSecond;
  const covariance = sumProduct / sampleCount - meanFirst * meanSecond;
  const sampleCorrelation = covariance / Math.sqrt(varianceFirst * varianceSecond);

  assert.ok(Math.abs(meanFirst) < 0.01, `first mean ${meanFirst}`);
  assert.ok(Math.abs(meanSecond) < 0.01, `second mean ${meanSecond}`);
  assert.ok(Math.abs(varianceFirst - 1) < 0.015, `first variance ${varianceFirst}`);
  assert.ok(Math.abs(varianceSecond - 1) < 0.015, `second variance ${varianceSecond}`);
  assert.ok(Math.abs(sampleCorrelation - requestedCorrelation) < 0.01, `correlation ${sampleCorrelation}`);

  assert.throws(() => correlatedNormalPair(normal, 1.01), /correlation must be finite/);
  assert.throws(() => correlatedNormalPair(normal, Number.NaN), /correlation must be finite/);
});

test("running statistics use stable online population and sample variance", () => {
  const statistics = new RunningStatistics();
  assert.ok(Number.isNaN(statistics.mean));
  assert.ok(Number.isNaN(statistics.populationVariance));
  assert.ok(Number.isNaN(statistics.sampleVariance));

  [1, 2, 3, 4].forEach((value) => statistics.add(value));
  assert.deepEqual(statistics.snapshot(), {
    count: 4,
    mean: 2.5,
    populationVariance: 1.25,
    sampleVariance: 5 / 3,
    minimum: 1,
    maximum: 4,
  });
  assert.throws(() => statistics.add(Number.POSITIVE_INFINITY), /only finite values/);
});

test("linear quantile helpers are deterministic, sort once, and do not mutate inputs", () => {
  const values = [30, 0, 20, 10];
  const snapshot = values.slice();
  const levels = [0, 0.25, 0.5, 0.75, 1];

  assert.equal(quantile(values, 0.5), 15);
  assert.deepEqual(quantiles(values, levels), [0, 7.5, 15, 22.5, 30]);
  assert.deepEqual(quantileRecord(values, levels), {
    "0": 0,
    "0.25": 7.5,
    "0.5": 15,
    "0.75": 22.5,
    "1": 30,
  });
  assert.deepEqual(values, snapshot);
  assert.equal(quantile(new Float64Array([4, 2, 8]), 0.5), 4);

  assert.throws(() => quantile([], 0.5), /at least one value/);
  assert.throws(() => quantile([1, Number.NaN], 0.5), /only finite values/);
  assert.throws(() => quantile([1], -0.1), /between 0 and 1/);
});

test("Monte Carlo contracts are tagged by model, measure, and state kind", () => {
  const configs: MonteCarloConfig[] = [
    {
      model: "Black–Scholes",
      enabled: true,
      paths: 10_000,
      timeSteps: 252,
      seed: 42,
      scheme: "exact-gbm",
      displayPathLimit: 200,
      quantileLevels: [0.05, 0.5, 0.95],
    },
    {
      model: "Heston",
      enabled: true,
      paths: 10_000,
      timeSteps: 252,
      seed: 42,
      scheme: "full-truncation-euler",
      displayPathLimit: 200,
      quantileLevels: [0.05, 0.5, 0.95],
    },
    {
      model: "Vasicek",
      enabled: true,
      paths: 10_000,
      timeSteps: 252,
      seed: 42,
      scheme: "exact-gaussian",
      displayPathLimit: 200,
      quantileLevels: [0.05, 0.5, 0.95],
    },
    {
      model: "HJB",
      enabled: true,
      paths: 10_000,
      timeSteps: 252,
      seed: 42,
      scheme: "feedback-policy-euler",
      displayPathLimit: 200,
      quantileLevels: [0.05, 0.5, 0.95],
    },
  ];
  assert.deepEqual(configs.map(({ model }) => model), ["Black–Scholes", "Heston", "Vasicek", "HJB"]);

  // This function is a compile-time contract check: narrowing one tag exposes
  // only the state fields appropriate for that model family.
  const stateNames = (result: MonteCarloResult): string[] => {
    switch (result.stateKind) {
      case "stock":
        void result.stock;
        return [result.model, "stock"];
      case "stock-and-variance":
        void result.stock;
        void result.variance;
        return [result.model, "stock", "variance"];
      case "short-rate-and-discount-factor":
        void result.shortRate;
        void result.discountFactor;
        return [result.model, "short-rate", "discount-factor"];
      case "controlled-wealth":
        void result.wealth;
        void result.policy;
        return [result.model, "wealth", "policy"];
    }
  };
  assert.equal(typeof stateNames, "function");
});
