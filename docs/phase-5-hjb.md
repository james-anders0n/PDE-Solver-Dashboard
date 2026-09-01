# Phase 5 — Merton HJB

Status: **complete** (20 August 2026)

Phase 5 adds a nonlinear Hamilton–Jacobi–Bellman engine for constrained
terminal-wealth allocation, connects value and policy views to the dashboard,
and validates both outputs against the unconstrained CRRA solution. The
implementation is in `app/lib/pde-engine/merton-hjb.ts`.

## Locked control problem

Under the real-world measure `P`, wealth follows

`dW = [rW + π(μ-r)]dt + πσdB`,

where `π` is the dollar position in the risky asset and
`πmin ≤ π ≤ πmax`. The objective is terminal utility only,
`J(W,T)=W^(1-γ)/(1-γ)`, with `γ>0`, `γ≠1`, and no consumption. The forward
time-to-maturity form solved numerically is

`Jτ = maxπ {(rW+π(μ-r))JW + ½π²σ²JWW}`.

The default domain is `W ∈ [0.05W0,4W0]`. At the lower boundary the admissible
risky exposure is zero and the inward risk-free characteristic is represented
by a one-sided state-constraint stencil. The upper boundary uses asymptotic
CRRA growth. This is a truncated-domain numerical control problem; it does not
claim that an unrestricted constant-dollar diffusion remains positive on an
unbounded continuous state space.

## Numerical method

- Uniform and smooth `W0`-fitted nonuniform wealth grids are supported.
- Diffusion and drift use a centred nonuniform stencil wherever its two
  off-diagonal generator weights are nonnegative. If a local Péclet condition
  would break monotonicity, the drift switches to the appropriate one-sided
  stencil.
- Backward Euler advances every time layer, so each frozen-policy matrix is an
  M-matrix. The implementation reports off-diagonal signs and the implicit
  diagonal margin.
- The discrete Hamiltonian is maximised pointwise. Candidate stationary
  controls from each stencil region, drift-switch points, and both control
  bounds are compared analytically.
- Howard policy iteration alternates the frozen-policy tridiagonal solve and
  pointwise maximisation. The accepted policy is re-solved once so the value
  and policy belong to the same linear system.
- Captured layers contain both `J(W,τ)` and `π*(W,τ)` for value-surface and
  policy visualisation.

## Independent unconstrained benchmark

When the bounds are inactive,

`π*(W) = (μ-r)W/(γσ²)`

and

`J(W,τ) = U(W) exp((1-γ)[r + (μ-r)²/(2γσ²)]τ)`.

The standard fixture uses `W0=100`, `T=1`, `r=0.03`, `μ=0.08`, `σ=0.20`,
`γ=3`, and bounds `[-100,200]`. The bounds are inactive at `W0`.

| Quantity | `200 × 200` HJB | Closed form | Absolute error |
|---|---:|---:|---:|
| Value `J(W0,0)` | `-4.611814671e-5` | `-4.611737016e-5` | `7.765e-10` |
| Dollar policy `π*(W0,0)` | `41.66666667` | `41.66666667` | `<1e-13` |

The value relative error is `1.684×10^-5`. Howard iteration takes at most
three updates per time layer, the tridiagonal residual is below `2×10^-18`,
all generator off-diagonals are nonnegative, and the global Bellman residual
is below `2.1×10^-5` (including the state-constraint boundary layer).

## Constraint and convergence evidence

- With bounds `[0,20]`, the computed control at `W0` is exactly `20`; 94.3% of
  interior nodes are at the upper bound. The constrained value is
  `-4.638740429×10^-5`, below the unconstrained optimum as required.
- Nonuniform refinement `50×50 → 100×100 → 200×200 → 400×400` reduces the
  point-value error from `3.484×10^-9` to `1.394×10^-9`, `7.765×10^-10`, and
  `3.781×10^-10`. The final observed order is `1.04`, above the first-order
  monotone-scheme gate of `0.9`.
- Policy error at `W0` is `4.052×10^-2` on the coarsest grid and below
  `10^-6` on the finest fixture.
- Expanding the standard wealth domain by 50% changes the `100×100` value at
  `W0` by `4.62×10^-10`.
- Automated tests cover the analytic value and policy, M-matrix diagnostics,
  Howard convergence, state-constraint control, bound activity, monotonicity
  of the value function, refinement, and domain sensitivity.

## Dashboard views and exit gate

Selecting HJB activates the wealth grid and Howard scheme. A run displays the
value surface `J(W,τ)`, the constrained policy against the dashed closed-form
policy, value and policy errors, Bellman and linear residuals, iteration counts,
bound activity, refinement results, and a reproducible exported manifest.

The Phase 5 exit criterion is met: on the published inactive-bound fixture,
both the value function and optimal dollar control converge to the known CRRA
solution, while a binding-bound fixture verifies the constrained Howard path.
