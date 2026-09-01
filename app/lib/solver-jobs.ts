import {
  blackScholesProductDomainExpansionDelta,
  hestonDomainExpansionDelta,
  mertonDomainExpansionDelta,
  runBlackScholesProductConvergence,
  runHestonConvergence,
  runMertonConvergence,
  runShortRateConvergence,
  shortRateDomainExpansionDelta,
  solveBlackScholesProduct,
  solveHestonEuropean,
  solveMertonHjb,
  solveShortRateProduct,
  type BlackScholesProductSolveRequest,
  type BlackScholesResult,
  type ConvergenceLevel,
  type HestonConvergenceLevel,
  type HestonResult,
  type HestonSolveRequest,
  type MertonConvergenceLevel,
  type MertonResult,
  type MertonSolveRequest,
  type ShortRateResult,
  type ShortRateSolveRequest,
} from "./pde-engine/index.ts";
import { throwIfCancelled, type ComputationControl } from "./computation-control.ts";
import {
  simulateBlackScholesMonteCarlo,
  simulateHestonMonteCarlo,
  simulateMertonPolicyMonteCarlo,
  simulateShortRateMonteCarlo,
  type BlackScholesMonteCarloConfig,
  type DashboardMonteCarloResult,
  type HestonMonteCarloConfig,
  type MertonMonteCarloConfig,
  type ShortRateMonteCarloConfig,
} from "./monte-carlo/index.ts";
import type { CpiScenarioIdentity } from "./economic-forecast/cpi-scenario.ts";

export type PricingResult = BlackScholesResult | ShortRateResult | HestonResult | MertonResult;
export type DashboardConvergenceLevel = ConvergenceLevel | HestonConvergenceLevel | MertonConvergenceLevel;

export type SolverJob = (
  | { model: "Black–Scholes"; request: BlackScholesProductSolveRequest; monteCarlo?: BlackScholesMonteCarloConfig }
  | { model: "Heston"; request: HestonSolveRequest; monteCarlo?: HestonMonteCarloConfig }
  | { model: "HJB"; request: MertonSolveRequest; monteCarlo?: MertonMonteCarloConfig }
  | { model: "Vasicek" | "Hull–White"; request: ShortRateSolveRequest; monteCarlo?: ShortRateMonteCarloConfig }
) & { scenarioIdentity?: CpiScenarioIdentity };

export interface SolverJobResult {
  result: PricingResult;
  convergence: DashboardConvergenceLevel[];
  domainExpansionDelta: number;
  monteCarlo?: DashboardMonteCarloResult;
}

export type SolverWorkerRequest =
  | { type: "run"; jobId: number; job: SolverJob }
  | { type: "cancel"; jobId: number };

export type SolverWorkerMessage =
  | { type: "progress"; jobId: number; progress: number; stage: string }
  | { type: "complete"; jobId: number; cacheHit: boolean; elapsedMs: number; payload: SolverJobResult }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

function sortForKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForKey);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortForKey(entry)]),
    );
  }
  return value;
}

export function createSolverJobKey(job: SolverJob): string {
  const identity = { ...job } as Record<string, unknown>;
  if ("monteCarlo" in identity && !(identity.monteCarlo as { enabled?: boolean } | undefined)?.enabled) {
    delete identity.monteCarlo;
  }
  return JSON.stringify(sortForKey(identity));
}

function attachMonteCarlo(
  job: Extract<SolverJob, { model: "Black–Scholes" | "Heston" }>,
  pdeResult: SolverJobResult,
  reportProgress: (progress: number, stage: string) => void,
  control?: ComputationControl,
): SolverJobResult {
  if (!job.monteCarlo?.enabled) return pdeResult;
  throwIfCancelled(control);
  reportProgress(90, job.model === "Heston"
    ? "Simulating correlated Heston stock and variance paths"
    : job.request.contract === "barrier"
      ? "Simulating exact GBM paths with continuous Brownian-bridge barrier monitoring"
      : "Simulating exact risk-neutral GBM paths");
  const monteCarlo = job.model === "Heston"
    ? simulateHestonMonteCarlo({
        spot: job.request.spot,
        strike: job.request.strike,
        maturity: job.request.maturity,
        rate: job.request.rate,
        dividend: job.request.dividend,
        v0: job.request.v0,
        kappa: job.request.kappa,
        theta: job.request.theta,
        xi: job.request.xi,
        rho: job.request.rho,
        side: job.request.side,
        config: job.monteCarlo,
      }, control)
    : (() => {
        if (job.request.contract === "american-put") {
          throw new Error("American-put Monte Carlo requires a separately validated out-of-sample Longstaff–Schwartz policy and is not enabled in Phase 7.");
        }
        return simulateBlackScholesMonteCarlo({
          spot: job.request.spot,
          strike: job.request.strike,
          maturity: job.request.maturity,
          rate: job.request.rate,
          dividend: job.request.dividend,
          volatility: job.request.volatility,
          side: job.request.side,
          contract: job.request.contract,
          barrier: job.request.barrier,
          barrierDirection: job.request.barrierDirection,
          config: job.monteCarlo,
        }, control);
      })();
  throwIfCancelled(control);
  reportProgress(96, "Monte Carlo statistics and confidence interval complete");
  return { ...pdeResult, monteCarlo };
}

export function executeSolverJob(
  job: SolverJob,
  reportProgress: (progress: number, stage: string) => void,
  control?: ComputationControl,
): SolverJobResult {
  throwIfCancelled(control);
  if (job.model === "Black–Scholes" && job.monteCarlo?.enabled && job.request.contract === "american-put") {
    throw new Error("American-put Monte Carlo requires a separately validated out-of-sample Longstaff–Schwartz policy and is not enabled in Phase 7.");
  }
  reportProgress(18, "Assembling finite-difference operator");

  if (job.model === "Black–Scholes") {
    const request = job.request;
    const result = solveBlackScholesProduct(request);
    throwIfCancelled(control);
    reportProgress(58, "Running independent benchmark and refinement study");
    const convergence = runBlackScholesProductConvergence({
      spot: request.spot,
      strike: request.strike,
      maturity: request.maturity,
      rate: request.rate,
      dividend: request.dividend,
      volatility: request.volatility,
      side: request.side,
      contract: request.contract,
      barrier: request.barrier,
      barrierDirection: request.barrierDirection,
      scheme: request.scheme,
      gridKind: request.gridKind,
    });
    throwIfCancelled(control);
    reportProgress(86, "Checking domain expansion");
    const pdeResult = { result, convergence, domainExpansionDelta: blackScholesProductDomainExpansionDelta(request) };
    return attachMonteCarlo(job, pdeResult, reportProgress, control);
  }

  if (job.model === "Heston") {
    const request = job.request;
    const result = solveHestonEuropean(request);
    throwIfCancelled(control);
    reportProgress(58, "Running Fourier benchmark and tensor refinement study");
    const convergence = runHestonConvergence({
      spot: request.spot,
      strike: request.strike,
      maturity: request.maturity,
      rate: request.rate,
      dividend: request.dividend,
      v0: request.v0,
      kappa: request.kappa,
      theta: request.theta,
      xi: request.xi,
      rho: request.rho,
      side: request.side,
      scheme: request.scheme,
      gridKind: "uniform",
    }, [16, 32, 64]);
    throwIfCancelled(control);
    reportProgress(86, "Checking spot and variance domains");
    const pdeResult = {
      result,
      convergence,
      domainExpansionDelta: hestonDomainExpansionDelta({ ...request, spaceSteps: 40, varianceSteps: 20, timeSteps: 80 }),
    };
    return attachMonteCarlo(job, pdeResult, reportProgress, control);
  }

  if (job.model === "HJB") {
    const request = job.request;
    const result = solveMertonHjb(request);
    throwIfCancelled(control);
    reportProgress(58, "Validating value and constrained policy");
    const convergence = runMertonConvergence({
      wealth: request.wealth,
      maturity: request.maturity,
      rate: request.rate,
      expectedReturn: request.expectedReturn,
      volatility: request.volatility,
      riskAversion: request.riskAversion,
      controlMin: request.controlMin,
      controlMax: request.controlMax,
      gridKind: "nonuniform",
    }, [50, 100, 200]);
    throwIfCancelled(control);
    reportProgress(86, "Checking wealth-domain expansion");
    const pdeResult = {
      result,
      convergence,
      domainExpansionDelta: mertonDomainExpansionDelta({ ...request, spaceSteps: 100, timeSteps: 100 }),
    };
    if (!job.monteCarlo?.enabled) return pdeResult;
    throwIfCancelled(control);
    reportProgress(90, "Simulating controlled wealth under the interpolated HJB feedback policy");
    const monteCarlo = simulateMertonPolicyMonteCarlo({ solved: result, config: job.monteCarlo }, control);
    throwIfCancelled(control);
    reportProgress(96, "Expected utility and policy-bound diagnostics complete");
    return { ...pdeResult, monteCarlo };
  }

  const request = job.request;
  const result = solveShortRateProduct(request);
  throwIfCancelled(control);
  reportProgress(58, "Running affine benchmark and refinement study");
  const convergence = runShortRateConvergence({
    model: request.model,
    contract: request.contract,
    shortRate: request.shortRate,
    meanReversion: request.meanReversion,
    longRunRate: request.longRunRate,
    rateVolatility: request.rateVolatility,
    maturity: request.maturity,
    bondMaturity: request.bondMaturity,
    strike: request.strike,
    curveId: request.curveId,
    discountCurve: request.discountCurve,
    scheme: request.scheme,
    gridKind: "uniform",
  }, [100, 200, 400]);
  throwIfCancelled(control);
  reportProgress(86, "Checking short-rate domain expansion");
  const pdeResult = { result, convergence, domainExpansionDelta: shortRateDomainExpansionDelta(request) };
  if (!job.monteCarlo?.enabled) return pdeResult;
  throwIfCancelled(control);
  reportProgress(90, `Simulating exact Gaussian ${request.model} rates and discount integrals`);
  const monteCarlo = simulateShortRateMonteCarlo({
    model: request.model,
    contract: request.contract,
    shortRate: request.shortRate,
    meanReversion: request.meanReversion,
    longRunRate: request.longRunRate,
    rateVolatility: request.rateVolatility,
    maturity: request.maturity,
    bondMaturity: request.bondMaturity,
    strike: request.strike,
    curveId: request.curveId,
    discountCurve: request.discountCurve,
    config: job.monteCarlo,
  }, control);
  throwIfCancelled(control);
  reportProgress(96, "Monte Carlo discount-factor statistics and confidence interval complete");
  return { ...pdeResult, monteCarlo };
}
