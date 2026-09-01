# Phase 1 reusable 1D PDE engine

Status: **complete**  
Effective date: **19 August 2026**

## Scope delivered

The numerical engine is independent of the dashboard and solves linear one-dimensional parabolic problems in time-to-maturity form,

\[
u_\tau = a(x,\tau)u_{xx} + b(x,\tau)u_x - c(x,\tau)u.
\]

The model supplies coefficient functions, the contract supplies terminal and time-dependent Dirichlet boundary data, and the engine supplies:

- endpoint-preserving uniform grids;
- smooth sinh-mapped nonuniform grids concentrated around an interior focus;
- validated nonuniform three-point first- and second-derivative stencils;
- generic tridiagonal operator assembly with explicit boundary-vector contributions;
- an independent Thomas solver with dimension, finiteness and pivot safeguards;
- explicit Euler, backward Euler and Crank-Nicolson steppers;
- Rannacher-Crank-Nicolson with four backward-Euler half-steps covering exactly two full time intervals;
- bracket-reporting linear interpolation with extrapolation disabled;
- runtime, grid, range, finiteness, residual, matrix-sign, diagonal-margin and explicit-stability diagnostics; and
- captured time layers for dashboard surface and heatmap views.

The implementation is under `app/lib/pde-engine/`. No dashboard component is required to import, execute or test it.

## Black-Scholes validation adapter

The first model adapter supplies the Black-Scholes coefficients, European call/put payoffs, discounted asymptotic boundaries and a closed-form benchmark. It reports the interpolated point price, absolute and relative point error, max-norm error, L2 error, interpolation bracket, convergence levels and domain-expansion sensitivity.

Standard fixture:

| Input | Value |
|---|---:|
| Spot / strike | 100 / 100 |
| Maturity | 1 year |
| Rate / dividend yield | 5% / 0% |
| Volatility | 20% |
| Production grid | 200 space intervals, 200 time steps, strike-fitted nonuniform |
| Scheme | Rannacher-Crank-Nicolson |

Acceptance result:

| Measure | Result |
|---|---:|
| PDE call price | 10.45024594 |
| Closed-form call price | 10.45057562 |
| Point absolute error | 3.2968e-4 |
| Point relative error | 3.1547e-5 |
| Max-norm error | 7.2759e-4 |
| L2 error | 4.2950e-4 |
| 25% domain-expansion price change | 1.6140e-4 |

Uniform-grid refinement provides an independent convergence demonstration:

| M × N | PDE price | Absolute error | Observed order |
|---:|---:|---:|---:|
| 50 × 50 | 10.59421392 | 1.4364e-1 | - |
| 100 × 100 | 10.41068571 | 3.9890e-2 | 1.85 |
| 200 × 200 | 10.44066518 | 9.9104e-3 | 2.01 |

## Test coverage

Automated tests cover grid construction and rejection, stencil reduction, manufactured quadratic derivatives, boundary-vector assembly, Thomas solves and input immutability, all four time-stepping modes on the analytic heat equation, explicit instability warnings, interpolation behavior, Black-Scholes call and put accuracy, put-call parity, positivity, spot monotonicity, nonuniform-grid pricing, domain expansion and systematic refinement.

## Exit decision

All Phase 1 exit conditions are met. Phase 2 can build product-specific Black-Scholes payoffs, complementarity handling, Greeks and convergence views on this engine without moving numerical logic into the dashboard.
