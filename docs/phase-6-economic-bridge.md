# Phase 6 — economic-model bridge

Status: **complete** (20 August 2026)

Phase 6 adds a point-in-time, versioned bridge between real-world economic
forecasts and the already validated PDE engines. It does not add a new pricing
model and it does not let a historical forecast silently replace a
risk-neutral market input.

## Input and audit contract

`app/lib/economic-bridge.ts` requires every forecast to provide:

- a stable input id, economic variable, point value and unit;
- lower and upper uncertainty bounds, confidence level and interval method;
- observation, availability and target timestamps;
- an explicit forecast horizon and data vintage;
- a source-model name/version; and
- a mapping id/version plus the run's point-in-time `as of` timestamp.

Regime inputs additionally carry a probability and interval, versioned return,
volatility and rate shocks, their own observation/availability metadata, and a
normalisation requirement. Forecast and regime ids must be unique.

The validator rejects observations that appear to be available before they
were observed, any input first available after the run timestamp, mismatched
forecast horizons, invalid uncertainty bounds, invalid probabilities,
non-positive volatility multipliers, missing provenance, and regime
probabilities that do not sum to one.

These look-ahead controls preserve the original vintage and compare the
availability timestamp—not merely the observation date—with the run timestamp.

## Measure boundary and constrained mappings

The bridge returns two different objects:

1. an unchanged copy of the calibrated/current parameter set; and
2. one macro-conditioned parameter set per regime.

Scenario transformations never mutate the calibrated set. The dashboard can
apply one scenario to the visible controls and can restore the saved calibrated
set. The exported run manifest stores the classification, applied scenario,
mapping version, audit record, calibrated base and all scenario records.

| Forecast | Model | Versioned mapping | Interpretation |
|---|---|---|---|
| Equity return | HJB | `μ = clamp(μ̂ + regime adjustment, −1, 2)` | P-measure expected return for the allocation objective |
| Equity return | Pricing PDEs | explicitly excluded | never replaces a Q-measure pricing drift |
| Realised equity volatility | HJB | bounded volatility scenario | P-measure wealth-risk input |
| Realised equity volatility | Black–Scholes | bounded volatility scenario | comparison only; calibrated/implied base is retained |
| Realised equity volatility | Heston | bounded squared-volatility `v₀` prior | scenario/prior, never labelled implied without calibration |
| Realised equity volatility | short-rate models | explicitly excluded | no arbitrary equity-to-rate-volatility coefficient |
| Policy rate | HJB | bounded opportunity-rate scenario | P-measure decision input, not a discount curve |
| Policy rate | Black–Scholes | bounded rate scenario | comparison only; base market rate is retained |
| Policy rate | Vasicek | bounded long-run-rate scenario/prior | distinct from the Q-calibrated base parameter |
| Policy rate | Hull–White | bounded short-rate stress overlay | never replaces the observed fitted curve |

All parameter-domain constraints are applied after the versioned transformation.
The audit record preserves both the raw transformed value and the constrained
value, so a bound application is visible rather than silent.

## Published point-in-time fixture

The dashboard fixture is frozen as of `2026-08-20T00:00:00Z` and uses economic
data observed on 31 July, available on 5 August, targeting 31 July 2027. It
contains 12-month equity-return, realised-volatility and policy-rate forecasts
with 80% ensemble intervals, plus baseline, expansion and stress regime
probabilities of 55%, 25% and 20%. Forecasts use Macro Ensemble `3.2.0`; regime
probabilities use Regime Classifier `2.4.1`; the bridge mapping is
`macro-to-pde 1.0.0`.

The regime dashboard deliberately compares separate nonlinear scenario solves.
It does not average model parameters and call the result a probability-weighted
price.

## Acceptance evidence

The Phase 6 tests run with the numerical engine suite and establish that:

- the published fixture is timestamp-valid and every displayed forecast has a
  formula, target/disposition, interval, model version, mapping version and
  financial interpretation;
- mapped HJB parameters are reproducible while the calibrated set remains
  unchanged;
- a forecast equity return is explicitly excluded from Heston's Q-measure drift;
- a volatility forecast becomes a scenario `v₀` prior without changing the
  calibrated `v₀`;
- post-run data, invalid intervals, invalid probability sums and invalid
  volatility multipliers are rejected; and
- out-of-domain raw mappings are clamped with a visible constraint flag and
  constrained interval.

The full engine and bridge suite contains 29 passing tests. The production
build and server-rendered product checks also pass.

## Exit criterion

**Passed.** Every economic input shown in the dashboard has a traceable source,
timestamp, vintage, uncertainty interval, transformation or explicit exclusion,
target measure, mapping version and financial interpretation. Scenario and
calibrated parameters are separately visible, restorable and exported.
