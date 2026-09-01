import {
  MODEL_KEYS,
  MODEL_SPECS,
  getActiveParameters,
  type ModelKey,
  type ParameterSpec,
} from "./pde-spec.ts";
import type { DataClassification, ParameterProposal } from "./market-data/types.ts";

export type ControlHelp = {
  description: string;
  context: string;
};

export type MarketControlId =
  | "dataMode" | "symbol" | "asOfDate" | "currency"
  | "optionExpiration" | "optionView" | "atmMethod" | "maximumSpread" | "minimumOpenInterest" | "dividendMethod"
  | "firstExpiration" | "lastExpiration" | "minimumMoneyness" | "maximumMoneyness" | "minimumStrikes" | "minimumExpiries"
  | "calibrationObjective" | "multiStarts" | "maximumEvaluations" | "calibrationSeed" | "openInterestWeighting" | "vixPrior"
  | "fredPolicySeries" | "windowStart" | "windowEnd" | "sampling" | "measureMode" | "missingDays" | "outlierPolicy" | "minimumObservations" | "etfOverlays"
  | "curveMode" | "curveFamily" | "interpolation" | "fredTenors" | "maximumQuoteAge" | "etfOptionProxy"
  | "historyWindow" | "returnEstimator" | "volatilityWindow" | "opportunityRate" | "historyWeight" | "erpPrior" | "ewmaHalfLife" | "fredRegimeSet" | "usdRateProxy"
  | "previewWealth" | "previewRiskAversion";

export type SolverControlId =
  | "governingModel" | "contract" | "optionType" | "barrierType" | "scheme"
  | "stateSteps" | "spotSteps" | "varianceSteps" | "wealthSteps" | "timeSteps" | "spatialGrid"
  | "monteCarloEnabled" | "monteCarloPaths" | "monteCarloTimeSteps" | "monteCarloSeed";

export const MARKET_CONTROL_IDS_BY_MODEL = {
  "Black–Scholes": ["dataMode", "symbol", "asOfDate", "currency", "optionExpiration", "optionView", "atmMethod", "maximumSpread", "minimumOpenInterest", "dividendMethod"],
  Heston: ["dataMode", "symbol", "asOfDate", "currency", "firstExpiration", "lastExpiration", "minimumMoneyness", "maximumMoneyness", "maximumSpread", "minimumOpenInterest", "minimumStrikes", "minimumExpiries", "calibrationObjective", "multiStarts", "maximumEvaluations", "calibrationSeed", "openInterestWeighting", "vixPrior"],
  Vasicek: ["dataMode", "asOfDate", "currency", "fredPolicySeries", "windowStart", "windowEnd", "sampling", "measureMode", "missingDays", "outlierPolicy", "minimumObservations", "etfOverlays"],
  "Hull–White": ["dataMode", "asOfDate", "currency", "curveMode", "curveFamily", "interpolation", "fredTenors", "maximumQuoteAge", "etfOptionProxy"],
  HJB: ["dataMode", "symbol", "asOfDate", "currency", "historyWindow", "returnEstimator", "volatilityWindow", "opportunityRate", "historyWeight", "erpPrior", "ewmaHalfLife", "fredRegimeSet", "usdRateProxy"],
} as const satisfies Record<ModelKey, readonly MarketControlId[]>;

export const SOLVER_CONTROL_IDS = [
  "governingModel", "contract", "optionType", "barrierType", "scheme", "stateSteps", "spotSteps",
  "varianceSteps", "wealthSteps", "timeSteps", "spatialGrid", "monteCarloEnabled", "monteCarloPaths",
  "monteCarloTimeSteps", "monteCarloSeed",
] as const satisfies readonly SolverControlId[];

export const MARKET_CONTROL_HELP = {
  dataMode: { description: "Chooses deterministic fixtures or server-side live providers. It changes data acquisition only; fetching never applies values or starts a solver.", context: "Provider setting · measure-independent" },
  symbol: { description: "The market instrument whose quote, history or option chain is requested. Its provider currency is checked before rates or parameters are mapped.", context: "Observed identifier · measure-independent" },
  asOfDate: { description: "Point-in-time cutoff for observations and provider availability. Later or not-yet-available data is excluded to prevent look-ahead leakage.", context: "Date cutoff · measure-independent" },
  currency: { description: "Currency convention used to validate the instrument and rate source. Cross-currency rate use requires an explicit, recorded proxy choice.", context: "ISO currency · measure-independent" },
  optionExpiration: { description: "Listed option expiry used to construct the Black–Scholes smile and maturity. Implied volatility and rates are Q-measure inputs for that horizon.", context: "Listed date · Q-measure" },
  optionView: { description: "Selects call quotes, put quotes or both when building the displayed smile. It changes quote coverage, not the pricing equations.", context: "Observed option quotes · Q-measure" },
  atmMethod: { description: "Selects the strike nearest the forward in absolute log-moneyness |ln(K/F)|. The resulting midpoint implied volatility is the Q-measure volatility proposal.", context: "Derived selection rule · Q-measure" },
  maximumSpread: { description: "Rejects option quotes whose bid–ask spread is too large relative to the midpoint. Lower percentages enforce cleaner but potentially sparser calibration data.", context: "Decimal threshold · measure-independent filter" },
  minimumOpenInterest: { description: "Rejects option contracts below this open-interest count. Raising it favours liquidity but can reduce strike and expiry coverage.", context: "Contract count · measure-independent filter" },
  dividendMethod: { description: "Chooses how the continuous dividend yield q is estimated: put–call parity, trailing distributions or the current manual value. In pricing it is a Q-measure carry input.", context: "Annual continuous decimal · Q-measure" },
  firstExpiration: { description: "Earliest option expiry retained for the Heston surface. It defines the short end of the Q-measure calibration set.", context: "Listed date · Q-measure calibration filter" },
  lastExpiration: { description: "Latest option expiry retained for the Heston surface. A wider range adds term structure but increases calibration work.", context: "Listed date · Q-measure calibration filter" },
  minimumMoneyness: { description: "Lower forward log-moneyness bound ln(K/F) for retained options. More negative values admit deeper in-the-money strikes.", context: "Dimensionless log ratio · Q-measure filter" },
  maximumMoneyness: { description: "Upper forward log-moneyness bound ln(K/F) for retained options. Larger values admit further out-of-the-money strikes.", context: "Dimensionless log ratio · Q-measure filter" },
  minimumStrikes: { description: "Minimum usable strikes required within each retained expiry. It guards against calibrating Heston parameters to an under-sampled smile.", context: "Contract count · calibration quality gate" },
  minimumExpiries: { description: "Minimum usable expiries required for the volatility surface. It guards the term-structure dimension of the Heston calibration.", context: "Expiry count · calibration quality gate" },
  calibrationObjective: { description: "Chooses whether Heston minimises weighted implied-volatility errors or option-price errors. Both estimate Q-measure dynamics but weight market discrepancies differently.", context: "Q-measure calibration objective" },
  multiStarts: { description: "Number of deterministic starting points tried by the bounded Heston optimiser. More starts can reduce local-minimum risk and increase run time.", context: "Optimisation count · Q calibration" },
  maximumEvaluations: { description: "Maximum objective evaluations allowed per Heston calibration. Higher limits permit more search at greater computational cost.", context: "Optimisation budget · Q calibration" },
  calibrationSeed: { description: "Seed used to reproduce the deterministic set of Heston optimiser starting points. It does not change provider data.", context: "Integer seed · measure-independent" },
  openInterestWeighting: { description: "Multiplies spread-aware calibration weights by the square root of open interest. It gives more influence to liquid contracts without treating volume as a model parameter.", context: "Calibration weighting · Q-measure" },
  vixPrior: { description: "Loads VIXCLS only as a US equity-regime diagnostic or prior. VIX is never substituted for the selected asset’s variance or any Heston parameter.", context: "Scenario prior · not a direct Q parameter" },
  fredPolicySeries: { description: "FRED short-rate history used for the Vasicek fit or current-rate observation. Values are converted from percent to decimal with point-in-time vintage checks.", context: "Observed annual rate · P history or Q input by mode" },
  windowStart: { description: "First eligible observation date in the historical short-rate estimation window. Changing it changes the sample and P-measure estimates.", context: "Date · P-measure estimation window" },
  windowEnd: { description: "Last eligible observation date in the historical short-rate estimation window, capped by the as-of date.", context: "Date · P-measure estimation window" },
  sampling: { description: "Observation frequency used by the exact OU/AR(1) estimator. Weekly mode uses the last valid observation and a longer time increment.", context: "Daily or weekly · P-measure estimate" },
  measureMode: { description: "Separates a historical P-measure scenario fit from a cross-sectional Q-measure pricing calibration. P estimates cannot overwrite Q solver parameters.", context: "Measure guard · P versus Q" },
  missingDays: { description: "Controls how gaps in the FRED history are prepared: carry the previous valid rate or omit gap transitions. This changes the historical estimator sample.", context: "Data preparation · P-measure estimate" },
  outlierPolicy: { description: "Keeps, removes or winsorises observations beyond three sample standard deviations. The policy and removed points remain in provenance.", context: "Data preparation · P-measure estimate" },
  minimumObservations: { description: "Minimum prepared rate observations required before estimation. Raising it improves sample-size discipline but may reject short windows.", context: "Observation count · estimation quality gate" },
  etfOverlays: { description: "Adds SHY, IEF and TLT only as directional duration proxies. ETF prices are not zero-coupon bonds and never become Vasicek parameters.", context: "Observed proxy diagnostic · measure-independent" },
  curveMode: { description: "Chooses the documented method used to convert FRED Treasury quotes into an immutable discount-curve proxy. It never labels the result as an OIS curve.", context: "Curve construction · Q pricing input proxy" },
  curveFamily: { description: "Selects Treasury-only pillars or a SOFR front anchor plus Treasury tenors. This changes the source instruments used for P(0,T).", context: "Observed FRED family · Q curve proxy" },
  interpolation: { description: "Interpolates natural cubic splines in log discount factors. This preserves positive discounts and is stored with the curve snapshot.", context: "Curve convention · Q pricing input" },
  fredTenors: { description: "Selects the FRED maturity pillars included in curve construction. The required front anchor stays selected; broader tenor coverage shapes more of P(0,T).", context: "Observed tenor set · Q curve proxy" },
  maximumQuoteAge: { description: "Maximum allowed age, in calendar days, for a curve pillar at the as-of date. Older observations fail the freshness gate.", context: "Days · data-quality threshold" },
  etfOptionProxy: { description: "Loads SHY, IEF and TLT option volatility only as an amber rate-volatility scenario proxy. It is not swaption calibration data.", context: "Scenario proxy · not a Q calibration" },
  historyWindow: { description: "Number of adjusted total-return sessions used for the HJB opportunity set. Longer windows reduce sampling noise but may be less responsive to recent conditions.", context: "Trading sessions · P-measure estimate" },
  returnEstimator: { description: "Estimates the risky asset’s expected P-measure return. Sample means are uncertain; the default shrinkage estimator combines historical evidence with a prior instead of treating the raw average as precise.", context: "Annual decimal return · P-measure forecast" },
  volatilityWindow: { description: "Controls the adjusted-return sample used for annualised realised volatility. Short windows react faster; long windows are usually more stable.", context: "Trading sessions · P-measure volatility" },
  opportunityRate: { description: "P-measure risk-free investment opportunity taken from SOFR or DFF. A USD FRED rate cannot be applied to a non-USD asset unless explicit proxy mode is enabled.", context: "Annual decimal rate · P-measure" },
  historyWeight: { description: "Weight placed on the historical sample mean in the shrinkage return estimate; the remainder is placed on the rate-plus-ERP prior.", context: "Decimal weight from 0 to 1 · P-measure" },
  erpPrior: { description: "Equity-risk-premium prior added to the opportunity rate before shrinkage. It is an explicit annual decimal forecast assumption, not an observed return.", context: "Annual decimal · P-measure scenario prior" },
  ewmaHalfLife: { description: "Number of sessions over which an observation’s EWMA weight halves. Shorter half-lives make the P-measure return estimate more responsive and less stable.", context: "Trading sessions · P-measure estimator" },
  fredRegimeSet: { description: "Selects FRED signals used to version economic regimes: VIXCLS for market stress and T10Y2Y for curve slope. Neither is the asset’s volatility or a pricing parameter.", context: "Scenario signals · P-measure bridge" },
  usdRateProxy: { description: "Explicitly permits a USD SOFR or DFF opportunity-rate proxy for a non-USD asset. The mismatch is recorded and warned about in the snapshot.", context: "Proxy authorisation · P-measure" },
  previewWealth: { description: "Initial wealth used only in the analytic Merton allocation preview. It does not alter Solver Studio controls or run the HJB solver.", context: "Currency units · P-measure preview" },
  previewRiskAversion: { description: "CRRA risk-aversion coefficient used only in the allocation preview. Larger values generally reduce the unconstrained risky-asset allocation.", context: "Dimensionless scenario value · P-measure preview" },
} as const satisfies Record<MarketControlId, ControlHelp>;

export const SOLVER_CONTROL_HELP = {
  governingModel: { description: "Selects the governing PDE, measure convention, admissible contracts and model-specific controls. Changing it clears calculated results but does not fetch market data.", context: "Model selector · Q pricing or P control" },
  contract: { description: "Selects the payoff and boundary conditions solved under the current model. Contract-specific fields and validation update with this choice.", context: "Contract definition · measure-independent" },
  optionType: { description: "Chooses call or put payoff orientation. It changes terminal and boundary conditions while retaining the current model and numerical settings.", context: "Contract selector · Q-measure pricing" },
  barrierType: { description: "Chooses whether the continuously monitored zero-rebate barrier knocks out above or below the state. The barrier level remains a separate input.", context: "Contract selector · Q-measure pricing" },
  scheme: { description: "Time-stepping or operator-splitting method used by the PDE engine. Stability, smoothing and computational cost differ by scheme and model.", context: "Numerical method · measure-independent" },
  stateSteps: { description: "Number of spatial nodes along the one-dimensional pricing state. More steps improve resolution but increase memory and computation.", context: "Positive integer · finite-difference grid" },
  spotSteps: { description: "Number of Heston grid intervals in spot S. More steps improve spot resolution and increase the two-dimensional solve cost.", context: "Positive integer · finite-difference grid" },
  varianceSteps: { description: "Number of Heston grid intervals in variance v. More steps resolve the variance dimension better and increase ADI work.", context: "Positive integer · finite-difference grid" },
  wealthSteps: { description: "Number of grid intervals in positive wealth W. More steps resolve the feedback policy better and increase Howard-iteration work.", context: "Positive integer · finite-difference grid" },
  timeSteps: { description: "Number of backward time intervals. Increasing it generally improves temporal resolution but increases computation time.", context: "Positive integer · finite-difference grid" },
  spatialGrid: { description: "Chooses a uniform mesh or a fitted nonuniform mesh concentrated near the economically important state, such as strike, current rate or initial wealth.", context: "Grid geometry · measure-independent" },
  monteCarloEnabled: { description: "Runs the eligible model-specific simulation with the PDE job. It is off by default and does not replace the finite-difference calculation.", context: "Execution option · model measure" },
  monteCarloPaths: { description: "Number of simulated paths used in statistics. More paths reduce sampling error at roughly proportional computational cost.", context: "Positive integer · Monte Carlo" },
  monteCarloTimeSteps: { description: "Number of simulated time intervals per path. More steps improve path resolution for discretised dynamics and increase run time.", context: "Positive integer · Monte Carlo" },
  monteCarloSeed: { description: "Initialises the pseudorandom stream. The same complete configuration and seed reproduce the same simulated paths.", context: "Integer · reproducibility" },
} as const satisfies Record<SolverControlId, ControlHelp>;

const sourceContext: Record<ParameterSpec["source"], string> = {
  market: "market input",
  calibrated: "calibrated input",
  contract: "contract input",
  numerical: "numerical input",
  scenario: "scenario input",
};

const parameterOverrides: Partial<Record<`${ModelKey}:${string}`, string>> = {
  "Heston:kappa": "Q-measure speed at which variance returns toward long-run variance θ. Larger κ makes variance shocks decay faster.",
  "Heston:theta": "Q-measure long-run variance level toward which v reverts. It is variance in decimal-squared units, not volatility.",
  "Heston:v0": "Current Q-calibrated instantaneous variance at valuation time. Its square root is the corresponding instantaneous volatility.",
  "Heston:xi": "Q-measure volatility of the variance process. Larger ξ produces more variable variance paths and stronger smile dynamics.",
  "Heston:rho": "Q-measure instantaneous correlation between spot and variance shocks, bounded from −1 to 1. Negative values support equity skew.",
  "HJB:expectedReturn": "Versioned annual P-measure risky-asset return forecast μ. It drives the excess-return reward μ−r and carries estimation uncertainty.",
  "HJB:volatility": "Annualised P-measure risky-asset volatility σ. Higher σ increases risk and generally reduces the unconstrained risky allocation.",
  "HJB:riskAversion": "CRRA coefficient γ. Larger γ penalises risky wealth variation more strongly; γ=1 is outside this specification.",
  "Hull–White:curveId": "Identifier of the immutable Q-pricing discount-curve snapshot P(0,T). It fixes the initial term structure without changing a or σᵣ.",
};

const buildSolverParameterHelp = (model: ModelKey, spec: ParameterSpec): ControlHelp => ({
  description: parameterOverrides[`${model}:${spec.id}`] ?? `${spec.description} Changing it affects the ${model} ${MODEL_SPECS[model].measure}-measure problem wherever ${spec.symbol} appears.`,
  context: `${sourceContext[spec.source]} · ${MODEL_SPECS[model].measure}-measure${spec.unit ? spec.unit === "dec" ? " · percent shown; precise decimal retained" : ` · ${spec.unit}` : " · native units"}`,
});

export const SOLVER_PARAMETER_HELP: Readonly<Record<string, ControlHelp>> = Object.freeze(Object.fromEntries(
  MODEL_KEYS.flatMap((model) => MODEL_SPECS[model].contracts.flatMap((contract) =>
    getActiveParameters(model, contract.id).map((spec) => [`${model}:${spec.id}`, buildSolverParameterHelp(model, spec)]),
  )),
));

export function getSolverParameterHelp(model: ModelKey, spec: ParameterSpec): ControlHelp {
  const help = SOLVER_PARAMETER_HELP[`${model}:${spec.id}`];
  if (!help) throw new Error(`Missing Solver Studio help for ${model}:${spec.id}`);
  return help;
}

const classificationMeaning: Record<DataClassification, string> = {
  observed: "observed directly from a provider",
  derived: "derived from observed inputs",
  calibrated: "calibrated to market observations",
  scenario: "a scenario assumption",
  proxy: "an explicitly labelled proxy",
  manual: "a manual value retained unchanged",
};

export function getMarketProposalHelp(model: ModelKey, proposal: ParameterProposal): ControlHelp {
  const effect = getActiveParameters(model, MODEL_SPECS[model].contracts[0].id).find((item) => item.id === proposal.id)?.description
    ?? proposal.provenance.financialInterpretation;
  return {
    description: `${effect} This proposed value is ${classificationMeaning[proposal.classification]} and affects the ${proposal.provenance.measure}-measure ${model} ${proposal.applicable ? "input" : "diagnostic only"}.`,
    context: `${proposal.classification.toUpperCase()} · ${proposal.provenance.measure}-measure · ${proposal.provenance.unit} · ${proposal.provenance.compounding}`,
  };
}

export function assertControlHelpCoverage(): void {
  for (const model of MODEL_KEYS) {
    for (const id of MARKET_CONTROL_IDS_BY_MODEL[model]) {
      if (!MARKET_CONTROL_HELP[id]) throw new Error(`Missing Market Data help for ${model}:${id}`);
    }
    for (const contract of MODEL_SPECS[model].contracts) {
      for (const parameter of getActiveParameters(model, contract.id)) getSolverParameterHelp(model, parameter);
    }
  }
  for (const id of SOLVER_CONTROL_IDS) {
    if (!SOLVER_CONTROL_HELP[id]) throw new Error(`Missing Solver Studio help for ${id}`);
  }
}

if (process.env.NODE_ENV !== "production") assertControlHelpCoverage();
