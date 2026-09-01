# Phase 7 — interface and deployment

Status: **complete** (20 August 2026)

## Delivered interface

- The desktop pricing-lab layout remains the primary workspace, with a compact
  off-canvas parameter drawer for touch and narrow screens.
- Model, contract, numerical-grid, benchmark and measure information remain
  visible at the point where a run is configured and interpreted.
- Acceptance failures now produce a prominent run-level warning for pointwise,
  maximum-norm, observed-order and non-finite-result failures.
- The “How to interpret this run” disclosure explains the price/value,
  measure convention, acceptance policy, background execution and cache.
- Keyboard focus styles, reduced-motion behavior, labelled controls, progress
  semantics and touch-sized mobile controls are retained or added.

## Background job and cache design

`app/workers/solver.worker.ts` owns the heavy numerical job. A job contains the
selected model and a fully materialised, serialisable solve request. The worker
runs the primary solve, independent benchmark, refinement study and domain-
expansion check, posting stage progress to the dashboard.

The interface never accepts a completion message whose job identifier is not
the currently active identifier. Cancelling terminates and replaces the worker,
so an obsolete result cannot overwrite a newer configuration.

The worker keeps an eight-entry least-recently-used in-memory cache. Keys are
stable JSON encodings with recursively sorted object keys. An identical model,
contract, parameter and grid request therefore restores the full validated
result without repeating a solve. The run manifest records whether the result
came from the worker or its cache. The cache is deliberately session-local: it
contains no user data, needs no durable storage and cannot make a stale result
survive a deployment.

## Downloads and reproducibility

- **Run manifest · JSON** contains the model and measure, contract schema,
  parameters, grid, calculated result, diagnostics, convergence, domain check,
  acceptance thresholds, economic-bridge lineage and execution/cache mode.
- **Grid results · CSV** contains the one-dimensional state/value/benchmark
  series, or every spot/variance value for a Heston tensor.

Both exports are generated from the exact state displayed by the dashboard.

## Deployment optimisation

- The production output remains Cloudflare Worker-compatible ESM.
- Fingerprinted static assets receive a one-year immutable browser cache;
  rendered HTML is revalidated rather than stored as immutable content.
- Responses add content-type, referrer, permissions and framing/object security
  controls.
- Heavy work is moved off the interaction thread. Identical validation runs are
  not recomputed, and the user can cancel a long job without reloading.
- A Phase 7 social card and host-derived absolute Open Graph/X metadata are
  shipped for reliable link previews.

## Verification and exit criterion

The deployment build, numerical/economic engine suite, rendered HTML contract
and lint suite are the release gates. Rendered-output tests also require the
background worker, cache key, separate downloads, explanations, warning UI,
mobile drawer, response caching policy and Phase 7 report to be present.

**Exit criterion:** the complete dashboard is responsive during heavy solves,
does not recompute an identical validated run within a session, exposes the
information needed to reproduce and download a run, clearly warns when a
numerical acceptance gate fails, and produces a deployable, cache-aware Worker
build.
