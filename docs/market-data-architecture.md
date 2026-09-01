# Market data architecture

PDE Studio remains one application with four top-level workspaces: **Market Data**, **Solver Studio**, **Results**, and **Run History**. Model, contract controls, active snapshot, and solver state stay in the existing client lifecycle; navigating does not mutate inputs or start a calculation.

## Provider boundary

`FRED_API_KEY` is read only by `app/api/market-data/route.ts`. It must be provided as a server secret and must never use a public/client-prefixed name. `YFINANCE_SERVICE_URL` points to the separately deployed FastAPI service under `services/market-data`. Python and `yfinance` are not executed in the Cloudflare worker.

Local environment:

```text
FRED_API_KEY=server-secret
YFINANCE_SERVICE_URL=http://127.0.0.1:8010
```

Live provider requests have a twenty-second combined timeout. A failed refresh leaves the last successful snapshot displayed with a visible error. Tests use deterministic fixtures and never call either live provider.

Black–Scholes live snapshots request the regular-market quote, exchange metadata, adjusted/action history, listed expirations, the selected-expiry call/put chain, and the FRED constant-maturity tenors bracketing the exact option maturity. Other model adapters continue to fail closed when their model-specific live transformation is unavailable. The UI never fills missing live calculations with fixture values.

## Black–Scholes equity snapshot

The equity adapter uses `ACT/365F` from the selected as-of date to the option expiration. It linearly interpolates the bracketing FRED Treasury yields in maturity after converting each annual percentage quote to a continuously compounded decimal. This is explicitly a Treasury proxy, not an OIS curve.

Dividend yield is proposed from the median put-call-parity estimate across at least two reliable, near-forward matched strikes. If that test fails, trailing cash distributions provide a disclosed fallback; otherwise the existing manual value is retained. Historical expected return is never calculated or mapped to the risk-neutral drift.

Options are excluded for zero or crossed markets, non-finite values, excessive relative spread, insufficient open interest, unavailable/future/stale trade timestamps, no-arbitrage price violations, or failed IV inversion. Midpoint IV is solved with bid/ask IV bounds, and the pricing proposal is the retained contract minimizing `|ln(K/F)|`. Provider IV remains comparison-only. Adjusted-close log-return volatilities over 20, 60, and 252 sessions are labelled P-measure diagnostics and cannot be applied as pricing sigma.

Every snapshot stores source and availability timestamps, selected expiration, rate pillars, dividend method, IV method, filtering thresholds, selected forward-ATM contract, and immutable snapshot ID. The same record is embedded in any subsequent solver run manifest.

## Heston volatility-surface calibration

The Heston adapter loads adjusted history/actions and option chains across the selected expiration range. The live route samples at most eight evenly spaced listed expirations inside that range to bound provider load. Each expiration receives its own exact `ACT/365F` maturity, forward, parity check, and continuously compounded FRED Treasury proxy interpolation. Retained strikes are normalized to `ln(K/F)`.

Structural quote filters are shared with the equity snapshot, then Heston adds forward-moneyness and minimum strike/expiry coverage gates. Excluded instruments remain in the immutable surface record with their rejection reason, but receive zero calibration weight. VIXCLS is requested only for SPY/S&P 500-style instruments and is stored as a regime prior, never as `v₀`, `θ`, or another direct Heston parameter.

Surface fetch and calibration are deliberately separate. Fetch produces dependency proposals plus labelled initialization seeds. A dedicated worker performs bounded deterministic multi-start calibration against the existing semi-analytic Heston Fourier benchmark. Price-error and IV-error objectives use normalized inverse-spread-squared weights, optionally multiplied by the square root of open interest. Cancellation terminates the worker and preserves the last accepted surface and parameter set.

Only a completed calibration makes `v₀`, `κ`, `θ`, `ξ`, and `ρ` applicable. Applying that set clears stale numerical output without starting the PDE. The result records bounds, objective, weighted RMSE, maximum error, evaluations, convergence, Feller ratio, market-minus-model residuals, expiry summaries, timestamps, settings, curve sources, surface ID, and the retained instrument set. A Feller violation remains visible but does not invalidate an otherwise converged calibration.

## Workflow and state

## Vasicek rate-history estimator

The Vasicek adapter accepts only FRED `SOFR` or `DFF` daily observations and records observation, availability, real-time/vintage, as-of, and immutable snapshot metadata. The selected date window can be sampled daily or by the last observation in each week. Missing business days are either carried from the previous valid value or excluded from transition construction, and the chosen three-standard-deviation outlier policy retains every removal or winsorization reason.

Historical parameters use the exact OU transition, represented as an AR(1) likelihood-equivalent fit: `φ = exp(-aΔ)`, `a = -log(φ)/Δ`, `b = intercept/(1-φ)`, and the innovation variance is mapped back to `σᵣ`. The result includes P-measure `aᴾ`, `bᴾ`, and `σᵣᴾ`, approximate 95% intervals, standardized residual diagnostics, sampling interval, window, and estimator version. Positive `a` and `σᵣ`, finite values, sufficient variation, and minimum history are enforced. The latest observation available by the as-of date supplies `r₀` independently of the historical fit.

Saving the P fit creates a historical scenario record and never mutates the Q pricing controls or clears a solver result. Q mode is a separate bounded deterministic cross-sectional calibration against at least four distinct zero-coupon maturities. Without that dataset the Q action fails closed. P and Q results remain immutable sibling records in the snapshot.

Optional SHY, IEF, and TLT adjusted histories are normalized validation overlays labelled `PROXY`. They test direction and broad duration response only; ETF shares are never priced or interpreted as zero-coupon bonds and never appear in the parameter mapping.

## Hull–White curve snapshot

The Hull–White adapter treats the imported `DiscountCurve` as the primary Q-measure market object. Configurable FRED SOFR and Treasury constant-maturity series span the overnight/front anchor through 30 years. Every retained pillar is aligned independently to the latest valid observation no later than the selected as-of date, with the raw series ID, percent quote, quote date, real-time/vintage fields, availability timestamp, and fetch timestamp retained in the immutable snapshot. Inputs are USD-only; no silent currency proxy is available.

Treasury proxy mode converts each quote into a continuously compounded zero-rate approximation and is always labelled `PROXY · NOT OIS`. Bootstrap mode uses simple money-market discounting for the overnight and bill end, then treats longer Treasury constant-maturity observations as semiannual par-yield proxies. Coupon-date discounts are interpolated from already constructed log discounts, and any missing inputs or small monotonicity adjustment is recorded. Both modes begin at `P(0,0)=1`, require a front anchor, positive discounts, strictly increasing maturities, and reject severe unexplained non-monotonicity. The production curve uses natural-cubic interpolation of log discount factors.

The front instantaneous forward consistently supplies proposed `r₀`. Mean reversion `a` and rate volatility `σᵣ` remain independent manual controls. Using the existing solver convention, the adapter reconstructs `ϑ(t)` and reports the maximum pillar-reproduction error. Optional SHY, IEF, and TLT option observations are displayed in a separate amber rate-volatility scenario card. They are explicitly not swaptions and never calibrate `σᵣ`.

Applying a curve snapshot atomically applies the curve identity and front rate, clears stale results, and does not start a calculation. The complete serializable curve object—not merely its string ID—is copied into Hull–White solve, affine benchmark, convergence, domain-expansion, and Monte Carlo jobs. Run details and exports retain either that full immutable snapshot or its stable snapshot ID together with construction mode, interpolation, source pillars, fit diagnostics, timestamps, and proxy classification.

## Merton HJB investment opportunity set

The Merton adapter is a physical-measure workflow. It aligns yfinance adjusted history, dividends/actions, currency and exchange calendar metadata with a USD SOFR or DFF opportunity rate and point-in-time FRED regime observations. Non-USD assets fail closed unless the user explicitly enables and records USD-rate proxy mode. FRED observations enter only when both their observation date and conservative availability date are no later than the common as-of date; live requests also use an as-of vintage.

Adjusted-close log returns supply 20-, 60-, 126-, and 252-session annualized realised volatility. Expected return can use an arithmetic annualized mean, exponentially weighted mean, or the default shrinkage estimate. Shrinkage combines the historical estimate with `r + ERP prior`, exposes the history weight, and carries an uncertainty interval. Short samples, weekday gaps, and unstable mean estimates remain visible. Drawdown, daily 95% tail loss, expected shortfall, skewness, and excess kurtosis are diagnostics and never become silent HJB parameters.

The versioned `hjb-opportunity-regime-1.0.0` Economic Bridge uses VIXCLS and T10Y2Y only as regime signals. It produces probability-valid baseline, expansion, defensive, and stress scenarios with explicit expected-return adjustments, volatility multipliers, and rate shifts. VIX is never substituted for the selected asset's realised volatility. Each base and regime set displays the analytic initial Merton allocation, its uncertainty interval, and any binding control bound.

Applying the base snapshot changes only `μ`, `σ`, and `r`. Applying a regime reuses the existing Economic Bridge base/scenario/restore lifecycle, associates the immutable market snapshot, clears stale PDE and Monte Carlo output, and never starts a job. Local wealth and risk-aversion sensitivity sliders update allocation previews only. Manifests retain the adjusted-history interval and action counts, estimator and mapping versions, FRED series/vintages and availability, regime probability, uncertainty, application lineage, and immutable snapshot ID.

The only state-changing market workflow is:

```text
Fetch → Validate → Preview changes → Apply selected parameters
```

Fetch and preview do not mutate controls. Apply stores the previous parameter set, copies only selected applicable rows into the existing controls, clears stale PDE/Monte Carlo output through the existing lifecycle, records the snapshot lineage, and does not start a solver. Restore recovers the previous inputs and also clears stale output without starting a run.

When a later solver run is queued, its local job identifier is associated with the active applied snapshot. Run manifests include the immutable snapshot and application record.

## Classifications

- **OBSERVED**: directly reported provider observation.
- **CALIBRATED**: Q-measure parameter estimated against market prices.
- **DERIVED**: transformation or approximation from observations.
- **SCENARIO**: P-measure estimate or macro-conditioned input.
- **PROXY**: substitute data that is not the target market object.
- **MANUAL**: user-controlled value that was not replaced.

Colour reinforces these labels but is never the only signal.

## Financial safeguards

- Historical equity return is never used as Black–Scholes or Heston risk-neutral drift.
- Vasicek P estimates cannot overwrite Q pricing parameters by default.
- FRED Treasury constant-maturity yields remain labelled as curve/rate proxies, not OIS.
- Treasury ETFs are diagnostics, not zero-coupon bonds.
- VIX is a macro regime signal, not an individual asset volatility.
- Currency mismatches are validation errors unless a model adds and records explicit proxy confirmation.

## Freshness

Same-session yfinance observations are preferred and are considered stale after one trading day. FRED uses the previous valid business-day observation and preserves real-time/vintage fields; it is considered stale after five calendar days unless a model-specific policy is stricter. Missing FRED values represented by `.` are discarded during normalization.

## yfinance limitations

`yfinance` relies on an unofficial Yahoo Finance interface. Its terms, redistribution rights, rate limits, and suitability must be reviewed before production or commercial deployment. Provider data is never accepted automatically: users must inspect and explicitly apply every snapshot.
