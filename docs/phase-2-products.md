# Phase 2 Black–Scholes products

Status: **complete**  
Effective date: **19 August 2026**

## Scope delivered

The Black–Scholes adapter now prices the complete Phase 2 catalogue without
moving numerical logic into the dashboard:

- European vanilla calls and puts with Rannacher smoothing;
- unit cash-or-nothing calls and puts with a cell-averaged projection of the
  discontinuous terminal payoff;
- continuously monitored, zero-rebate up-and-out and down-and-out calls and
  puts on barrier-fitted domains;
- American puts as a linear complementarity problem solved by projected SOR;
- strike-concentrated nonuniform grids, exact barrier boundary nodes and
  contract-specific time-dependent boundaries;
- delta, gamma and theta from the finite-difference solution and pricing
  operator, plus symmetric bump-and-revalue vega and rho; and
- three-level product refinement, domain sensitivity and reproducible run
  manifests in the dashboard.

The independent references are closed-form Black–Scholes vanilla and digital
prices, Reiner–Rubinstein continuous-barrier formulas, and a 1,600-step
Cox–Ross–Rubinstein tree for the American put.

## Standard-fixture acceptance evidence

Unless stated otherwise, the fixture uses `S₀=K=100`, `T=1`, `r=5%`, `q=0`,
`σ=20%`, 200 state intervals, 200 time steps, a strike-fitted nonuniform grid
and Rannacher–Crank–Nicolson.

| Product | PDE | Reference | Absolute error |
|---|---:|---:|---:|
| European call | 10.450246 | 10.450576 | 3.30e-4 |
| Cash digital call | 0.532304 | 0.532325 | 2.05e-5 |
| Up-and-out call, H=130 | 3.332402 | 3.332875 | 4.73e-4 |
| Down-and-out put, H=70 | 4.009944 | 4.012829 | 2.89e-3 |
| American put | 6.089544 | 6.089893 | 3.48e-4 |

The American run reports a maximum complementarity residual below `2e-9` and
an exercise boundary near `S*=81.10` on the standard grid. Its value dominates
the corresponding European put and remains below the strike.

## Refinement and no-arbitrage gates

- Digital call and put values sum to the discounted unit payout. Cell-averaged
  payoff projection removes even/odd grid oscillation at the discontinuity and
  restores systematic refinement.
- Knock-out prices are nonnegative, do not exceed their vanilla counterparts,
  and are exactly zero at the fitted barrier boundary.
- American values dominate intrinsic value at every node. The projected-SOR
  solution satisfies feasibility, dual feasibility and complementarity.
- Vanilla call/put parity, positivity and spot monotonicity remain covered by
  the Phase 1 regression suite.
- Product-specific uniform-grid studies reduce point-price error at the finest
  refinement and meet the declared observed-order gates on the standard
  fixtures.

## Greek acceptance

For the standard European call, the numerical sensitivities are:

| Greek | Numerical | Analytic fixture |
|---|---:|---:|
| Delta | 0.638911 | 0.636831 |
| Gamma | 0.018703 | 0.018762 |
| Theta | -6.412730 | -6.414030 |
| Vega | 37.520525 | 37.524000 |
| Rho | 53.231775 | 53.232500 |

## Exit decision

All Phase 2 exit conditions are met. Automated tests cover price accuracy,
terminal and spatial boundaries, grid refinement, domain sensitivity,
no-arbitrage relations, American obstacle and complementarity conditions, and
Greek agreement. Phase 3 can add short-rate model adapters without changing the
one-dimensional engine contract.
