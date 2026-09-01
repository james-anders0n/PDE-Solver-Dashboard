import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the PDE Studio product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>PDE Studio — Numerical Pricing Lab<\/title>/i);
  assert.match(html, /PDE Studio/);
  assert.match(html, /Governing model/);
  assert.match(html, /aria-label="Expand PDE Studio controls"/);
  assert.match(html, /aria-label="More information about Governing model"/);
  assert.match(html, /aria-label="Case workflow"/);
  assert.match(html, />Define</);
  assert.match(html, />Condition</);
  assert.match(html, />Solve</);
  assert.match(html, />Decide</);
  assert.match(html, /Current case/);
  assert.match(html, /Define the problem/);
  assert.match(html, /aria-label="Case name"/);
  assert.match(html, /aria-label="Case governing model"/);
  assert.match(html, /Draft · save required/);
  assert.match(html, /Save definition/);
  assert.match(html, /Sample result loaded/);
  assert.match(html, /Workflow and result status/);
  assert.match(html, /Status guide/);
  assert.doesNotMatch(html, /Current · validated|Answer current/);
  assert.match(html, /Case timeline/);
  assert.doesNotMatch(html, /class="export-menu"/);
  assert.match(html, /aria-label="Case next action"/);
  assert.match(html, /og:image/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/);
});

test("ships the responsive dashboard and executable specification", async () => {
  const [page, monteCarloView, rateMonteCarloView, mertonMonteCarloView, monteCarloGbm, monteCarloRates, monteCarloMerton, layout, css, packageJson, specification, bridge, solverJobs, solverWorker, deploymentWorker, phaseZero, phaseThree, phaseFour, phaseFive, phaseSix, phaseSeven, userGuide, americanAssessment] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/monte-carlo-results.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/short-rate-monte-carlo-results.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/merton-policy-monte-carlo-results.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/monte-carlo/gbm.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/monte-carlo/short-rate.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/monte-carlo/merton-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/pde-spec.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/economic-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/solver-jobs.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/workers/solver.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/phase-0-specification.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/phase-3-short-rates.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/phase-4-heston.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/phase-5-hjb.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/phase-6-economic-bridge.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/phase-7-interface-deployment.md", import.meta.url), "utf8"),
    readFile(new URL("../Notes/PDE_Studio_Research_and_User_Guide.md", import.meta.url), "utf8"),
    readFile(new URL("../Notes/american put monte carlo assessment.md", import.meta.url), "utf8"),
  ]);
  const [marketView, hestonCalibration, hestonSnapshot, hestonCalibrationWorker, vasicekEstimator, vasicekSnapshot, hullWhiteCurve, mertonOpportunity, marketArchitecture] = await Promise.all([
    readFile(new URL("../app/components/market-data-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/market-data/heston-calibration.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/market-data/heston-snapshot.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/workers/heston-calibration.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/market-data/vasicek-estimator.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/market-data/vasicek-snapshot.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/market-data/hull-white-curve.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/market-data/merton-opportunity.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/market-data-architecture.md", import.meta.url), "utf8"),
  ]);
  const solverSurface = await readFile(new URL("../app/components/solver-studio-workspace.tsx", import.meta.url), "utf8");

  assert.match(page, /MODEL_SPECS/);
  assert.match(page, /SurfaceChart/);
  assert.match(page, /ComparisonChart/);
  assert.match(page + solverJobs, /solveBlackScholesProduct/);
  assert.match(page + solverJobs, /runBlackScholesProductConvergence/);
  assert.match(solverJobs, /solveShortRateProduct/);
  assert.match(solverJobs, /runShortRateConvergence/);
  assert.match(solverJobs, /solveHestonEuropean/);
  assert.match(solverJobs, /runHestonConvergence/);
  assert.match(page, /HestonTimeSliceChart/);
  assert.match(solverJobs, /solveMertonHjb/);
  assert.match(solverJobs, /runMertonConvergence/);
  assert.match(page, /MertonPolicyChart/);
  assert.match(page, /exportRun/);
  assert.match(page, /exportResults/);
  assert.match(page, /new Worker/);
  assert.match(page, /cancelSolver/);
  const invalidationBlock = page.match(/const clearCalculatedResult = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.doesNotMatch(invalidationBlock, /setSolverResult\(null\)/);
  assert.match(page, /previous result retained as stale/);
  assert.match(page, /const clearCalculatedResult[\s\S]*?activeJobIdRef\.current \+= 1/);
  assert.match(page, /createMonteCarloManifest/);
  assert.match(page, /createMonteCarloCsvRows/);
  assert.match(page, /monteCarloEnabled/);
  assert.match(page, /sidebarCollapsed/);
  assert.match(page, /const \[sidebarCollapsed, setSidebarCollapsed\] = useState\(true\)/);
  assert.match(page, /const closeParameterControls = \(\) =>/);
  assert.match(page, /const selectCaseStage = \(stage: CaseStage\) => \{\s*closeParameterControls\(\)/);
  assert.match(page, /onOpenMarketControls=\{\(\) => \{ openWorkspace\("market-data"\); openParameterControls\(\); \}\}/);
  assert.doesNotMatch(page, /SIDEBAR_STORAGE_KEY|pde-studio\.sidebar-collapsed/);
  assert.match(page, /<ControlHelpLabel/);
  assert.match(page, /MarketDataWorkspace/);
  assert.match(page, /CaseTimelineDrawer/);
  assert.doesNotMatch(page, /RunHistoryWorkspace/);
  assert.match(page, /applyMarketData/);
  assert.match(page, /Load fixture snapshot/);
  assert.match(page, /Fetch live snapshot/);
  assert.match(page, /runHestonCalibration/);
  assert.match(page, /cancelHestonCalibration/);
  assert.match(marketView, /Apply \{selectedIds\.size\} changes to \{snapshot\.measure\} base/);
  assert.match(marketView, /HestonSurfaceVisual/);
  assert.match(marketView, /HestonResidualVisual/);
  assert.match(marketView, /accessible summary/);
  assert.match(hestonSnapshot, /forward-log-moneyness/);
  assert.match(hestonSnapshot, /minimum strike coverage/);
  assert.match(hestonCalibration, /bounded deterministic multi-start/);
  assert.match(hestonCalibration, /hestonSemiAnalyticPrice/);
  assert.match(hestonCalibrationWorker, /calibrateHestonSurface/);
  assert.match(hestonCalibrationWorker, /postMessage/);
  assert.match(page, /Historical P fit/);
  assert.match(page, /saveVasicekHistoricalScenario/);
  assert.match(marketView, /Save P historical scenario/);
  assert.match(marketView, /VasicekHistoryVisual/);
  assert.match(marketView, /P history ≠ Q pricing/);
  assert.match(marketView, /requestedMeasureMode === "q-curve"/);
  assert.match(vasicekEstimator, /exact-ou-ar1-1\.0\.0/);
  assert.match(vasicekEstimator, /Q-curve calibration requires at least four distinct zero-coupon maturities/);
  assert.match(vasicekSnapshot, /Historical P estimate cannot overwrite the Q pricing parameter/);
  assert.match(vasicekSnapshot, /ETF shares are not zero-coupon bonds/);
  assert.match(hullWhiteCurve, /Curve snapshot/);
  assert.match(page, /hullWhiteSelectedSeries/);
  assert.match(marketView, /HullWhiteCurveVisual/);
  assert.match(marketView, /Yield/);
  assert.match(marketView, /Discount/);
  assert.match(marketView, /Forward/);
  assert.match(marketView, /Curve pillars and proxy instruments/);
  assert.match(marketView, /not swaption/i);
  assert.match(hullWhiteCurve, /previous-valid-observation rule/);
  assert.match(page, /natural-cubic-log-discount/);
  assert.match(hullWhiteCurve, /Severe unexplained non-monotonicity/);
  assert.match(hullWhiteCurve, /P\(0,·\)/);
  assert.match(marketArchitecture, /complete serializable curve object/);
  assert.match(page, /hjbEstimator/);
  assert.match(page, /hjbShrinkageWeight/);
  assert.doesNotMatch(page, /onApplyEconomicRegime/);
  assert.match(page, /setActiveMarketSnapshotId\(currentMarketSnapshot\.id\)/);
  assert.match(page, /applyEconomicScenario[\s\S]*?clearCalculatedResult\(\)/);
  assert.match(marketView, /MertonOpportunityHistory/);
  assert.match(marketView, /MertonAllocationView/);
  assert.match(marketView, /Preview only · does not change HJB controls/);
  assert.match(marketView, /VIX = regime signal, not asset σ/);
  assert.match(mertonOpportunity, /merton-opportunity-set-1\.0\.0/);
  assert.match(mertonOpportunity, /hjb-opportunity-regime-1\.0\.0/);
  assert.match(mertonOpportunity, /availableDate <= asOfDate/);
  assert.match(mertonOpportunity, /π\*=clamp/);
  assert.match(marketArchitecture, /Applying a regime reuses the existing Economic Bridge/);
  assert.match(page, /validateMonteCarloControls/);
  assert.match(solverSurface, /aria-label="Enable Monte Carlo simulation"/);
  assert.match(solverSurface, /Advanced execution settings/);
  assert.match(page, /mainTab === "Monte Carlo"/);
  assert.match(page, /onClick=\{\(\) => setMainTab\(tab\)\}/);
  assert.match(page, /disabled=\{tab === "Monte Carlo" && !monteCarloTabAvailable\}/);
  assert.match(page, /scheme: "exact-gbm"/);
  assert.match(page, /scheme: "andersen-qe"/);
  assert.match(page, /scheme: "exact-gaussian"/);
  assert.match(page, /scheme: "feedback-policy-euler"/);
  assert.match(page, /varianceReduction: "antithetic"/);
  assert.match(monteCarloView, /Black–Scholes GBM Monte Carlo paths/);
  assert.match(monteCarloView, /Black–Scholes continuous barrier GBM paths/);
  assert.match(monteCarloView, /Continuous knock-out monitoring/);
  assert.match(monteCarloView, /Monitoring bias estimate/);
  assert.match(monteCarloView, /conditional terminal intrinsic reference only/);
  assert.match(monteCarloView, /Heston Monte Carlo paths/);
  assert.match(monteCarloView, /Heston variance paths/);
  assert.match(monteCarloView, /Theoretical expectation/);
  assert.match(monteCarloView, /Finite-sample mean/);
  assert.match(monteCarloView, /Expected payoff/);
  assert.match(monteCarloView, /Payoff at expected stock/);
  assert.match(monteCarloView, /95% confidence interval/);
  assert.match(monteCarloView, /role="img"/);
  assert.match(monteCarloView, /displayedPaths\.length/);
  assert.match(rateMonteCarloView, /exact-Gaussian short-rate Monte Carlo/);
  assert.match(rateMonteCarloView, /Pathwise discount factors/);
  assert.match(rateMonteCarloView, /Integrated short rate/);
  assert.match(rateMonteCarloView, /Hull–White curve-reproduction diagnostics/);
  assert.match(rateMonteCarloView, /role="img"/);
  assert.match(monteCarloRates, /gaussianRateIntegralMoments/);
  assert.match(monteCarloRates, /exact joint Gaussian law/);
  assert.match(monteCarloRates, /resolveHullWhiteCurve/);
  assert.match(mertonMonteCarloView, /Merton controlled-wealth simulation/);
  assert.match(mertonMonteCarloView, /Expected terminal utility/);
  assert.match(mertonMonteCarloView, /Terminal wealth distribution/);
  assert.match(mertonMonteCarloView, /Policy constraints/);
  assert.match(mertonMonteCarloView, /P-measure policy evaluation/);
  assert.match(mertonMonteCarloView, /role="img"/);
  assert.doesNotMatch(mertonMonteCarloView, /stock|strike|payoff|option price/i);
  assert.match(monteCarloMerton, /interpolateMertonFeedbackPolicy/);
  assert.match(monteCarloMerton, /calendar t uses HJB layer tau=T-t/);
  assert.match(userGuide, /Selecting a result tab only displays the completed run; it never reruns a simulation/);
  assert.match(userGuide, /exact GBM endpoints plus a Brownian-bridge continuous-monitoring correction/);
  assert.match(userGuide, /Vasicek and one-factor Hull–White/);
  assert.match(userGuide, /exact joint Gaussian distribution/);
  assert.match(userGuide, /Merton simulation is a real-world `P`-measure policy evaluation/);
  assert.match(userGuide, /American Monte Carlo remains intentionally excluded/);
  assert.match(userGuide, /model-specific diagnostic rows/);
  assert.match(page, /contract === "barrier"/);
  assert.match(monteCarloGbm, /brownianBridgeBarrierCrossingProbability/);
  assert.match(monteCarloGbm, /terminal intrinsic payoff times Brownian-bridge conditional survival weight/);
  assert.match(americanAssessment, /Longstaff–Schwartz not implemented/);
  assert.match(americanAssessment, /Independent policy training and valuation/);
  assert.match(americanAssessment, /would value a European put/);
  assert.match(page, /runWarnings/);
  assert.match(page, /Explore the completed result/);
  assert.match(page, /resultFreshness === "current"/);
  assert.match(page, /buildEconomicBridge/);
  assert.match(page, /Apply.*scenario/);
  assert.match(page, /transformation lineage/);
  assert.match(page, /setRunning\(true\)/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /\/og\.png/);
  assert.match(css, /@media \(max-width: 580px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /sidebar\.open/);
  assert.match(css, /\.app-shell\.sidebar-collapsed/);
  assert.match(css, /\.info-popover/);
  assert.match(css, /\.mc-chart-grid/);
  assert.match(css, /\.toggle-control:focus-within/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page + layout, /codex-preview|_sites-preview|SkeletonPreview/);
  assert.match(specification, /export const MODEL_SPECS/);
  assert.match(specification, /measure: "Q"/);
  assert.match(specification, /measure: "P"/);
  assert.match(specification, /American put/);
  assert.match(specification, /Heston semi-analytic Fourier/);
  assert.match(specification, /validateParameters/);
  assert.match(specification, /pointwiseAbsolute/);
  assert.match(bridge, /validateEconomicBridgeInput/);
  assert.match(bridge, /look-ahead leakage/);
  assert.match(bridge, /Excluded from Q-measure pricing/);
  assert.match(bridge, /calibratedParameters/);
  assert.match(solverJobs, /createSolverJobKey/);
  assert.match(solverJobs, /executeSolverJob/);
  assert.match(solverWorker, /MAX_CACHE_ENTRIES = 8/);
  assert.match(solverWorker, /cacheHit: true/);
  assert.match(solverWorker, /cancelledJobs/);
  assert.match(solverJobs, /Simulating exact risk-neutral GBM paths/);
  assert.match(solverJobs, /Simulating correlated Heston stock and variance paths/);
  assert.match(deploymentWorker, /max-age=31536000, immutable/);
  assert.match(deploymentWorker, /Content-Security-Policy/);
  const productEngine = await readFile(new URL("../app/lib/pde-engine/black-scholes.ts", import.meta.url), "utf8");
  const rateEngine = await readFile(new URL("../app/lib/pde-engine/short-rate.ts", import.meta.url), "utf8");
  const hestonEngine = await readFile(new URL("../app/lib/pde-engine/heston.ts", import.meta.url), "utf8");
  const mertonEngine = await readFile(new URL("../app/lib/pde-engine/merton-hjb.ts", import.meta.url), "utf8");
  assert.match(productEngine, /blackScholesDigitalPrice/);
  assert.match(productEngine, /blackScholesBarrierPrice/);
  assert.match(productEngine, /projectedSor/);
  assert.match(productEngine, /calculateGreeks/);
  assert.match(rateEngine, /vasicekBondPrice/);
  assert.match(rateEngine, /hullWhiteTheta/);
  assert.match(rateEngine, /solveShortRateProduct/);
  assert.match(rateEngine, /maximumBasisPointError/);
  assert.match(hestonEngine, /hestonSemiAnalyticPrice/);
  assert.match(hestonEngine, /mcs-adi/);
  assert.match(hestonEngine, /hv-adi/);
  assert.match(hestonEngine, /nine-point nonuniform/);
  assert.match(hestonEngine, /degenerateVarianceCoefficients/);
  assert.match(mertonEngine, /solveMertonHjb/);
  assert.match(mertonEngine, /optimiseControl/);
  assert.match(mertonEngine, /howard-implicit/);
  assert.match(mertonEngine, /stateConstraintBoundary/);
  assert.match(phaseZero, /Status: \*\*complete and locked for the MVP\*\*/);
  assert.match(phaseThree, /Status: \*\*complete\*\*/);
  assert.match(phaseThree, /Curve-fit exit gate/);
  assert.match(phaseFour, /Status: \*\*complete\*\*/);
  assert.match(phaseFour, /Published acceptance set/);
  assert.match(phaseFive, /Status: \*\*complete\*\*/);
  assert.match(phaseFive, /Constraint and convergence evidence/);
  assert.match(phaseSix, /Status: \*\*complete\*\*/);
  assert.match(phaseSix, /Exit criterion/);
  assert.match(phaseSix, /look-ahead/i);
  assert.match(phaseSeven, /Status: \*\*complete\*\*/);
  assert.match(phaseSeven, /Exit criterion/);
  assert.match(phaseSeven, /background/i);
  assert.match(phaseSeven, /cache/i);
  assert.match(phaseZero, /Knock-in barriers.*outside the MVP/s);

  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
