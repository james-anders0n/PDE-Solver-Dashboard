# Phase 3 short-rate models

Status: **complete**  
Effective date: **19 August 2026**

## Scope delivered

The one-dimensional engine now has independent adapters for the risk-neutral
Vasicek and one-factor Hull–White models:

- zero-coupon bonds and European calls on zero-coupon bonds;
- affine analytic bond and bond-option reference formulas;
- automatically generated rate domains based on conditional means and six
  conditional standard deviations, symmetrised around the current rate and
  explicitly extending below zero on the standard fixtures;
- exact analytic far-rate boundary values and current-rate-focused nonuniform
  grids;
- a versioned 13-pillar AUD OIS demonstration curve, interpolated with a
  natural cubic spline in log-discount factors;
- reconstruction of the time-dependent Hull–White drift under
  `dr=[ϑ(t)−ar]dt+σᵣdWᵠ`; and
- three-level refinement, 25% domain-expansion checks, curve-fit diagnostics,
  rate delta/gamma and rate-volatility sensitivity in the dashboard.

The PDE solver obtains Hull–White drift coefficients at the old and new time
levels. Analytic formulas are used only for independent comparison and far-rate
boundaries; the interior values are produced by finite-difference time
marching.

## Curve-fit exit gate

At time zero, the Hull–White affine bond formula was evaluated at every input
curve pillar from 0 to 60 years. The largest relative discount-factor error was
`3.997e-15`, or `3.997e-11` basis points. This is far inside the Phase 3 exit
tolerance of one basis point.

The fitted drift is genuinely time dependent: on the five-year fixture,
`ϑ(t)` ranges from approximately `0.003000` to `0.008834` under the convention
stated above.

## Standard-fixture acceptance evidence

The Vasicek fixture uses `r₀=3%`, `a=0.15`, `b=4%`, `σᵣ=1%`; Hull–White uses
`r₀=3%`, `a=0.10`, `σᵣ=1%` and curve snapshot
`AUD-OIS-demo-2026-07-29`. Claims expire in five years, bond calls use a
ten-year underlying bond with strike `0.75`, and numerical runs use 200 state
intervals, 200 time steps and Rannacher–Crank–Nicolson.

| Model and product | PDE | Reference | Absolute error | Max-norm error |
|---|---:|---:|---:|---:|
| Vasicek zero-coupon bond | 0.849088307 | 0.849088109 | 1.98e-7 | 2.86e-6 |
| Vasicek bond call | 0.073944448 | 0.073944088 | 3.61e-7 | 1.22e-5 |
| Hull–White zero-coupon bond | 0.835725704 | 0.835725426 | 2.78e-7 | 3.52e-6 |
| Hull–White bond call | 0.054017693 | 0.054016819 | 8.74e-7 | 8.47e-6 |

The Vasicek domain is `[-7.18%, 13.18%]`; the Hull–White domain is
`[-8.70%, 14.70%]`. Expanding both rate bounds by 25% changes the four standard
prices by between `4.33e-10` and `6.09e-7`.

Uniform `100 × 100`, `200 × 200`, and `400 × 400` refinement studies reduce
the finest-level bond-option errors and produce final observed orders above
the specified `1.8` gate for both models.

## Exit decision

All Phase 3 exit conditions are met. Automated tests cover affine formulas,
negative-rate support, rate monotonicity, time-dependent drift reconstruction,
every curve pillar, point and max-norm accuracy, domain behaviour and systematic
bond-option refinement. Both short-rate model families are calculated,
benchmarked and exportable from the dashboard.
