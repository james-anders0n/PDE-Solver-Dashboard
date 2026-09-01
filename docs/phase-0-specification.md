# Phase 0 mathematical specification

Status: **complete and locked for the MVP**  
Specification version: **0.1.0**  
Effective date: **12 August 2026**

This document is the human-readable companion to the executable catalogue in
`app/lib/pde-spec.ts`. If the two disagree, the executable catalogue blocks the
run and the discrepancy must be resolved before solver work continues.

## Conventions

- Pricing problems use calendar time `t` in displayed PDEs and time to maturity
  `τ = T − t` internally for forward time marching.
- Black–Scholes, Heston, Vasicek and Hull–White use the risk-neutral measure
  `Q`. Forecast equity returns must never replace `r − q` in a pricing PDE.
- The Merton HJB problem uses the real-world measure `P`; its expected return is
  a versioned forecast input.
- Rates and yields are continuously compounded decimals. Volatilities are
  annualised decimals. Maturities are year fractions.
- Prices and value functions use double precision. Interpolation error at the
  requested initial state is reported separately from grid-node error.

## Locked MVP problem catalogue

| Model | Supported contract/problem | Scope decision | Independent benchmark |
|---|---|---|---|
| Black–Scholes | European call and put | Cash-settled vanilla | Closed-form Black–Scholes price and Greeks |
| Black–Scholes | Digital call and put | Unit cash-or-nothing | Closed-form digital price |
| Black–Scholes | Barrier call and put | Continuously monitored knock-out only; zero rebate | Closed-form continuous-barrier formula |
| Black–Scholes | American put | Put only; LCP formulation | High-resolution CRR tree plus complementarity residual |
| Heston | European call and put | No Heston barrier in MVP | Semi-analytic Fourier price with independent quadrature |
| Vasicek | Zero-coupon bond | Unit notional | Analytic affine bond formula |
| Vasicek | European bond call | Unit underlying bond notional | Analytic Vasicek bond-option formula |
| Hull–White | Zero-coupon bond | Unit notional; fitted initial curve | Analytic bond formula and curve reproduction |
| Hull–White | European bond call | Same fitted-curve convention as PDE | Analytic one-factor Hull–White bond-option formula |
| HJB | Merton allocation | Terminal CRRA utility, no consumption, bounded dollar control | Unconstrained closed-form value and policy when bounds are inactive |

Knock-in barriers, rebates, discrete barrier monitoring, American calls, Heston
barriers and general rate payoffs are explicitly outside the MVP. Adding one is
a specification change, not a UI toggle.

## Governing problems and boundaries

The exact equations, terminal data and contract-specific boundary conditions
are stored in `MODEL_SPECS`. The following rules are binding across contracts:

- Black–Scholes uses `S ∈ [0,Smax]`; `Smax` is selected from spot, strike,
  maturity and volatility, then challenged by a domain-expansion test. Barrier
  levels coincide with grid nodes.
- Heston uses `(S,v) ∈ [0,Smax] × [0,vmax]`, the reduced PDE at `v=0`, and a
  tested zero-variance-gradient condition at `vmax`. Feller violation produces a
  diagnostic rather than rejecting the run.
- Vasicek and Hull–White rate domains include negative rates and begin at the
  conditional mean plus or minus six conditional standard deviations. Expanding
  both bounds by 25% must not materially change the requested price.
- Hull–White uses `dr=[ϑ(t)−ar]dt+σᵣdWᑫ`. Discount factors are interpolated in
  log space and the derived `ϑ(t)` must reproduce the same curve.
- HJB keeps `W>0`, uses a one-sided monotone state-constraint stencil at the
  lower boundary, CRRA asymptotics at the upper boundary, and explicitly bounded
  dollar control `π ∈ [πmin,πmax]`.

## Parameter contracts

Every parameter has an identifier, label, symbol, definition, default, source,
unit and admissible domain in `MODEL_SPECS`. Inputs are classified as:

- `market`: directly observed market state or a versioned curve snapshot;
- `calibrated`: risk-neutral parameters fitted to market information;
- `contract`: payoff or exercise definition;
- `scenario`: real-world forecast/control input; or
- `numerical`: grid or algorithm choice.

Cross-parameter rules are also binding:

- a bond underlying maturity must be strictly after the option expiry;
- a barrier cannot equal spot at inception;
- `πmin < πmax`;
- CRRA requires `γ>0` and `γ≠1` in this implementation; and
- Heston requires positive `κ`, `θ`, and `ξ`, with `ρ∈[-1,1]`.

The future economic bridge must additionally provide observation timestamp,
forecast horizon, data vintage, source model version and mapping version. Those
fields are not silently inferred.

## Acceptance gates

The executable catalogue stores contract-level tolerances. They are initial
engineering acceptance gates for the standard fixtures, not claims of universal
accuracy. Each solver must pass all applicable gates before its UI status can
change from illustrative to calculated:

1. point-price absolute and relative error at the requested initial state;
2. max-norm and L2 error on the comparison domain;
3. observed order under systematic space/time refinement;
4. boundary and expanded-domain sensitivity;
5. positivity, intrinsic bounds and relevant monotonicity checks;
6. analytic Greeks or policy comparisons where available;
7. stress fixtures, including short maturity, near-zero volatility, extreme
   correlation and a Heston Feller-violating case; and
8. a reproducible regression fixture containing parameters, grid, benchmark,
   tolerances and software/specification version.

For nonsmooth payoffs, excluded comparison nodes and reduced expected orders are
declared in the relevant tolerance note rather than hidden after a failure.

## Phase 0 exit decision

Every MVP screen now resolves to one written governing problem, terminal
condition, boundary policy, parameter schema, measure interpretation,
independent benchmark and acceptance tolerance. Phase 1 may therefore begin
with the reusable one-dimensional engine.
