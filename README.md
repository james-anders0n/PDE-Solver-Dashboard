# PDE Studio

PDE Studio is an interactive quantitative-finance dashboard for specifying,
solving and validating finite-difference pricing and control problems. Phases
0–7 provide a locked mathematical specification, reusable one- and
two-dimensional finite-difference engines, the complete Black-Scholes product
catalogue, curve-fitted Gaussian short-rate products, benchmarked Heston
European pricing, constrained Merton optimal control, and a point-in-time
economic-to-PDE scenario bridge.

## Project status

- **Phase 0 complete:** model/contract catalogue, measure conventions,
  conditions, assumptions, parameter schemas, benchmarks and tolerances.
- **Phase 1 complete:** uniform and nonuniform grids, generic tridiagonal
  operator assembly, Thomas solve, four stepping modes, interpolation,
  diagnostics and analytic Black-Scholes convergence validation.
- **Phase 2 complete:** vanilla and cash-digital calls/puts, continuous
  zero-rebate up/down knock-outs, projected-SOR American puts, payoff-aware
  grids, Greeks and product-level convergence studies.
- **Phase 3 complete:** Vasicek and one-factor Hull–White zero-coupon bonds and
  European bond calls, negative-rate grids, time-dependent coefficients,
  analytic affine benchmarks and exact input-curve reproduction.
- **Phase 4 complete:** nonuniform tensor grids, a nine-point mixed derivative,
  MCS/HV ADI, the reduced `v=0` PDE, a Fourier benchmark, and `S-v`, `S-t` and
  `v-t` views.
- **Phase 5 complete:** monotone fitted wealth grids, analytic pointwise
  control optimisation, Howard iteration, positive-wealth state constraints,
  value/policy views and closed-form CRRA validation.
- **Phase 6 complete:** versioned forecast/regime contracts, uncertainty and
  vintage metadata, constrained P/Q-aware mappings, scenario/calibration
  separation, provenance, comparison and look-ahead controls.
- **Phase 7 complete:** cancellable background validation jobs, bounded
  identical-run caching, separate JSON/CSV downloads, mobile controls,
  acceptance warnings and cache-aware deployment responses.

See [the Phase 0 specification](docs/phase-0-specification.md) for the locked MVP
decisions, [the Phase 1 engine report](docs/phase-1-engine.md) for numerical
acceptance evidence, [the Phase 2 product report](docs/phase-2-products.md) for
equity-product evidence, [the Phase 3 short-rate report](docs/phase-3-short-rates.md)
for curve-fit and rate-product evidence, and [the full project plan](PDE_Solver_Dashboard_Project_Plan.md)
for the roadmap. The [Phase 4 Heston report](docs/phase-4-heston.md) publishes
the two-dimensional stability and convergence set; the [Phase 5 HJB report](docs/phase-5-hjb.md)
publishes value, policy, constraint and refinement evidence; and the
[Phase 6 bridge report](docs/phase-6-economic-bridge.md) records point-in-time,
measure-separation, mapping and leakage-control evidence. The
[Phase 7 interface and deployment report](docs/phase-7-interface-deployment.md)
records the background-job, cache, download, warning and deployment decisions.

## Supported Phase 0 catalogue

- Black–Scholes: European, unit cash digital, zero-rebate continuous knock-out
  barrier, and American put.
- Heston: European call and put.
- Vasicek: zero-coupon bond and European zero-coupon bond call.
- one-factor Hull–White: zero-coupon bond and European zero-coupon bond call.
- HJB: constrained Merton terminal-wealth allocation with CRRA utility.

The executable specification lives in `app/lib/pde-spec.ts`. Dashboard controls,
conditions, benchmark descriptions, validation messages and exported manifests
are derived from that catalogue.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm test
npm run lint
```

Copy `.env.example` to `.env.local` when using live market data or the optional
economic-forecast service. Never commit `.env.local` or API keys.

For first-time GitHub setup, see [GITHUB_UPLOAD_GUIDE.md](GITHUB_UPLOAD_GUIDE.md).

The application uses Next.js-compatible routing through vinext and produces a
Cloudflare Worker-compatible build. Durable storage is not enabled yet because
Phase 0 and the first solver milestone do not require it.

## Repository map

```text
app/page.tsx                 responsive dashboard and visualisations
app/lib/pde-spec.ts          executable mathematical specification
app/lib/pde-engine/          reusable 1D/2D engines plus model adapters
app/lib/economic-bridge.ts   forecast/regime contract and constrained scenario mappings
app/lib/solver-jobs.ts       serialisable background validation jobs and stable cache keys
app/workers/solver.worker.ts cancellable solver worker with bounded identical-run cache
docs/phase-0-specification.md locked Phase 0 decisions
docs/phase-1-engine.md       Phase 1 design and acceptance evidence
docs/phase-2-products.md     Phase 2 product and Greek acceptance evidence
docs/phase-3-short-rates.md  Phase 3 curve-fit and rate-product evidence
docs/phase-4-heston.md       Phase 4 Heston stability and convergence evidence
docs/phase-5-hjb.md          Phase 5 Merton value and policy acceptance evidence
docs/phase-6-economic-bridge.md Phase 6 provenance and leakage-control evidence
docs/phase-7-interface-deployment.md Phase 7 interface and deployment evidence
tests/                       rendered-product and specification checks
worker/                      deployment entry point
```

## Accuracy policy

A result is labelled calculated only after its solver passes the declared
analytic/semi-analytic benchmark, refinement, domain, boundary, no-arbitrage and
stress gates. The dashboard labels the complete Black-Scholes, Vasicek and
Hull–White catalogues and the Merton control problem as calculated; later-model
screens remain specified but gated.
