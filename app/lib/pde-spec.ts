export type ModelKey = "Black–Scholes" | "Heston" | "Vasicek" | "Hull–White" | "HJB";
export type Measure = "Q" | "P";
export type OptionSide = "Call" | "Put";

export interface ParameterSpec {
  id: string;
  label: string;
  symbol: string;
  description: string;
  defaultValue: string;
  unit?: string;
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
  required: true;
  source: "market" | "calibrated" | "contract" | "numerical" | "scenario";
}

export interface AcceptanceTolerance {
  pointwiseAbsolute: number;
  maxNorm?: number;
  relative?: number;
  observedOrder?: number;
  note: string;
}

export interface ContractSpec {
  id: string;
  label: string;
  summary: string;
  optionSides?: readonly OptionSide[];
  parameters?: readonly ParameterSpec[];
  terminalCondition: Record<OptionSide | "None", string>;
  boundaryCondition: Record<OptionSide | "None", string>;
  benchmark: string;
  tolerance: AcceptanceTolerance;
  assumptions: readonly string[];
}

export interface ModelSpec {
  short: string;
  description: string;
  measure: Measure;
  measureMeaning: string;
  state: string;
  equation: string;
  scheme: string;
  parameters: readonly ParameterSpec[];
  contracts: readonly ContractSpec[];
  assumptions: readonly string[];
  diagnostics: readonly string[];
}

const numberParameter = (
  id: string,
  label: string,
  symbol: string,
  description: string,
  defaultValue: string,
  source: ParameterSpec["source"],
  options: Pick<ParameterSpec, "unit" | "min" | "max" | "exclusiveMin"> = {},
): ParameterSpec => ({ id, label, symbol, description, defaultValue, source, required: true, ...options });

const equityParameters = [
  numberParameter("spot", "Spot", "S₀", "Current underlying price.", "100", "market", { min: 0, exclusiveMin: true }),
  numberParameter("strike", "Strike", "K", "Contract strike.", "100", "contract", { min: 0, exclusiveMin: true }),
  numberParameter("maturity", "Maturity", "T", "Time to contract maturity.", "1.0", "contract", { unit: "yr", min: 0, exclusiveMin: true }),
  numberParameter("rate", "Risk-free rate", "r", "Continuously compounded risk-free rate under Q.", "0.05", "market", { unit: "dec", min: -0.25, max: 0.5 }),
  numberParameter("dividend", "Dividend yield", "q", "Continuous dividend yield.", "0.00", "market", { unit: "dec", min: -0.1, max: 0.5 }),
] as const;

const vanillaVolatility = numberParameter("volatility", "Volatility", "σ", "Annualised diffusion volatility.", "0.20", "calibrated", {
  unit: "dec",
  min: 0,
  max: 5,
  exclusiveMin: true,
});

const barrierParameter = numberParameter("barrier", "Barrier", "H", "Continuously monitored knock-out level.", "130", "contract", {
  min: 0,
  exclusiveMin: true,
});

const europeanTolerance: AcceptanceTolerance = {
  pointwiseAbsolute: 1e-3,
  maxNorm: 5e-3,
  relative: 1e-4,
  observedOrder: 1.8,
  note: "At S₀ on the standard fixture; max norm excludes two nodes around the payoff kink.",
};

export const MODEL_SPECS: Record<ModelKey, ModelSpec> = {
  "Black–Scholes": {
    short: "BS",
    description: "Lognormal equity diffusion",
    measure: "Q",
    measureMeaning: "Risk-neutral pricing measure; the equity drift is r − q, never a forecast return.",
    state: String.raw`S\in[0,S_{\max}],\quad \tau=T-t`,
    equation: String.raw`\frac{\partial V}{\partial t}+\frac{1}{2}\sigma^2S^2\frac{\partial^2V}{\partial S^2}+(r-q)S\frac{\partial V}{\partial S}-rV=0`,
    scheme: "Rannacher–Crank–Nicolson",
    parameters: [...equityParameters, vanillaVolatility],
    assumptions: [
      "Constant r, q and σ over the horizon.",
      "Frictionless market with continuous trading and no arbitrage.",
      "Continuous paths and continuous barrier monitoring; no discrete cash dividends.",
    ],
    diagnostics: ["domain expansion", "mesh Péclet number", "positivity", "monotonicity", "grid-refinement order"],
    contracts: [
      {
        id: "european",
        label: "European",
        summary: "Cash-settled European vanilla option.",
        optionSides: ["Call", "Put"],
        terminalCondition: {
          Call: String.raw`V(S,T)=\max(S-K,0)`,
          Put: String.raw`V(S,T)=\max(K-S,0)`,
          None: "",
        },
        boundaryCondition: {
          Call: String.raw`V(0,t)=0;\qquad V(S_{\max},t)=S_{\max}e^{-q(T-t)}-Ke^{-r(T-t)}`,
          Put: String.raw`V(0,t)=Ke^{-r(T-t)};\qquad V(S_{\max},t)=0`,
          None: "",
        },
        benchmark: "Closed-form Black–Scholes price and analytic Greeks",
        tolerance: europeanTolerance,
        assumptions: ["European exercise only.", "Payoff kink handled with four backward-Euler half-steps."],
      },
      {
        id: "digital",
        label: "Digital",
        summary: "Unit cash-or-nothing European digital.",
        optionSides: ["Call", "Put"],
        terminalCondition: {
          Call: String.raw`V(S,T)=\mathbf{1}_{\{S>K\}}`,
          Put: String.raw`V(S,T)=\mathbf{1}_{\{S<K\}}`,
          None: "",
        },
        boundaryCondition: {
          Call: String.raw`V(0,t)=0;\qquad V(S_{\max},t)=e^{-r(T-t)}`,
          Put: String.raw`V(0,t)=e^{-r(T-t)};\qquad V(S_{\max},t)=0`,
          None: "",
        },
        benchmark: "Closed-form cash-or-nothing Black–Scholes price",
        tolerance: {
          pointwiseAbsolute: 3e-3,
          maxNorm: 2e-2,
          relative: 5e-3,
          observedOrder: 0.9,
          note: "Discontinuous payoff: pointwise check must not sample exactly at K.",
        },
        assumptions: ["Unit cash payout.", "The value at S=K uses the strict-indicator convention shown."],
      },
      {
        id: "barrier",
        label: "Barrier",
        summary: "Continuously monitored, zero-rebate knock-out option.",
        optionSides: ["Call", "Put"],
        parameters: [barrierParameter],
        terminalCondition: {
          Call: String.raw`V(S,T)=\max(S-K,0)\quad\text{on the surviving domain}`,
          Put: String.raw`V(S,T)=\max(K-S,0)\quad\text{on the surviving domain}`,
          None: "",
        },
        boundaryCondition: {
          Call: String.raw`V(H,t)=0;\qquad \text{the opposite boundary uses the vanilla asymptotic condition}`,
          Put: String.raw`V(H,t)=0;\qquad \text{the opposite boundary uses the vanilla asymptotic condition}`,
          None: "",
        },
        benchmark: "Closed-form continuously monitored zero-rebate barrier formula",
        tolerance: {
          pointwiseAbsolute: 5e-3,
          maxNorm: 2e-2,
          relative: 1e-3,
          observedOrder: 1.5,
          note: "H must coincide with a grid node; compare away from the barrier and strike.",
        },
        assumptions: ["Only up-and-out and down-and-out variants are MVP.", "Zero rebate and continuous monitoring."],
      },
      {
        id: "american-put",
        label: "American put",
        summary: "American put as a linear complementarity problem.",
        optionSides: ["Put"],
        terminalCondition: { Call: "", Put: String.raw`V(S,T)=\max(K-S,0)`, None: "" },
        boundaryCondition: {
          Call: "",
          Put: String.raw`V(0,t)=K;\qquad V(S_{\max},t)=0;\qquad V(S,t)\geq\max(K-S,0)`,
          None: "",
        },
        benchmark: "High-resolution Cox–Ross–Rubinstein tree and LCP residual checks",
        tolerance: {
          pointwiseAbsolute: 1e-2,
          maxNorm: 3e-2,
          relative: 2e-3,
          observedOrder: 1,
          note: "Check price and free-boundary location; convergence is reduced near the exercise boundary.",
        },
        assumptions: ["American puts only in the MVP.", "Projected SOR is the first complementarity solver."],
      },
    ],
  },
  Heston: {
    short: "HE",
    description: "Stochastic variance model",
    measure: "Q",
    measureMeaning: "Risk-neutral pricing measure; all variance dynamics are Q-calibrated parameters.",
    state: String.raw`(S,v)\in[0,S_{\max}]\times[0,v_{\max}],\quad \tau=T-t`,
    equation: String.raw`\frac{\partial V}{\partial t}+\frac{1}{2}vS^2\frac{\partial^2V}{\partial S^2}+\rho\xi vS\frac{\partial^2V}{\partial S\,\partial v}+\frac{1}{2}\xi^2v\frac{\partial^2V}{\partial v^2}+(r-q)S\frac{\partial V}{\partial S}+\kappa(\theta-v)\frac{\partial V}{\partial v}-rV=0`,
    scheme: "Modified Craig–Sneyd ADI",
    parameters: [
      ...equityParameters,
      numberParameter("v0", "Initial variance", "v₀", "Current instantaneous variance.", "0.04", "calibrated", { min: 0, max: 4 }),
      numberParameter("kappa", "Mean reversion", "κ", "Variance mean-reversion speed.", "2.0", "calibrated", { min: 0, max: 20, exclusiveMin: true }),
      numberParameter("theta", "Long-run variance", "θ", "Long-run variance level.", "0.04", "calibrated", { min: 0, max: 4, exclusiveMin: true }),
      numberParameter("xi", "Vol of variance", "ξ", "Volatility of the variance process.", "0.30", "calibrated", { min: 0, max: 5, exclusiveMin: true }),
      numberParameter("rho", "Correlation", "ρ", "Spot/variance Brownian correlation.", "-0.70", "calibrated", { min: -1, max: 1 }),
    ],
    assumptions: ["Constant Q parameters.", "The v=0 boundary uses the reduced degenerate PDE.", "Feller violation is a diagnostic, not an automatic rejection."],
    diagnostics: ["Feller ratio", "ADI residual", "rho→0 limit", "domain expansion", "positivity"],
    contracts: [
      {
        id: "european",
        label: "European",
        summary: "European vanilla call or put under stochastic variance.",
        optionSides: ["Call", "Put"],
        terminalCondition: {
          Call: String.raw`V(S,v,T)=\max(S-K,0)`,
          Put: String.raw`V(S,v,T)=\max(K-S,0)`,
          None: "",
        },
        boundaryCondition: {
          Call: String.raw`\begin{gathered}V(0,v,t)=0;\quad \text{call asymptotic at }S_{\max};\\ \text{reduced PDE at }v=0;\quad \left.\frac{\partial V}{\partial v}\right|_{v=v_{\max}}=0\end{gathered}`,
          Put: String.raw`\begin{gathered}V(0,v,t)=Ke^{-r(T-t)};\quad V(S_{\max},v,t)=0;\\ \text{reduced PDE at }v=0;\quad \left.\frac{\partial V}{\partial v}\right|_{v=v_{\max}}=0\end{gathered}`,
          None: "",
        },
        benchmark: "Heston semi-analytic Fourier price with independent quadrature",
        tolerance: {
          pointwiseAbsolute: 5e-3,
          maxNorm: 2e-2,
          relative: 1e-3,
          observedOrder: 1.5,
          note: "Acceptance set includes both Feller-satisfying and Feller-violating fixtures.",
        },
        assumptions: ["European exercise only.", "Variance far boundary uses a tested zero-gradient condition."],
      },
    ],
  },
  Vasicek: {
    short: "VA",
    description: "Mean-reverting Gaussian short rate",
    measure: "Q",
    measureMeaning: "Risk-neutral short-rate parameters; historical estimates require a documented market-price-of-risk conversion.",
    state: String.raw`r\in[r_{\min},r_{\max}],\quad r_{\min}<0,\quad \tau=T-t`,
    equation: String.raw`\frac{\partial V}{\partial t}+a(b-r)\frac{\partial V}{\partial r}+\frac{1}{2}\sigma_r^2\frac{\partial^2V}{\partial r^2}-rV=0`,
    scheme: "Rannacher–Crank–Nicolson",
    parameters: [
      numberParameter("shortRate", "Short rate", "r₀", "Current continuously compounded short rate.", "0.03", "market", { unit: "dec", min: -0.25, max: 0.5 }),
      numberParameter("meanReversion", "Mean reversion", "a", "Risk-neutral mean-reversion speed.", "0.15", "calibrated", { min: 0, max: 10, exclusiveMin: true }),
      numberParameter("longRunRate", "Long-run rate", "b", "Risk-neutral long-run short-rate mean.", "0.04", "calibrated", { unit: "dec", min: -0.25, max: 0.5 }),
      numberParameter("rateVolatility", "Rate volatility", "σᵣ", "Annualised short-rate volatility.", "0.01", "calibrated", { unit: "dec", min: 0, max: 1, exclusiveMin: true }),
      numberParameter("maturity", "Claim maturity", "T", "Claim maturity.", "5.0", "contract", { unit: "yr", min: 0, max: 50, exclusiveMin: true }),
    ],
    assumptions: ["Gaussian rates may be negative.", "Q parameters are constant.", "Rate bounds use conditional mean ± six standard deviations."],
    diagnostics: ["rate-domain expansion", "curve monotonicity", "analytic affine residual", "grid-refinement order"],
    contracts: [
      {
        id: "zero-coupon-bond",
        label: "Zero-coupon bond",
        summary: "Unit-notional discount bond maturing at T.",
        terminalCondition: { Call: "", Put: "", None: String.raw`P(r,T;T)=1` },
        boundaryCondition: { Call: "", Put: "", None: String.raw`\text{Affine analytic asymptotics at }r_{\min}\text{ and }r_{\max}` },
        benchmark: "Analytic Vasicek affine zero-coupon bond formula",
        tolerance: { pointwiseAbsolute: 1e-5, maxNorm: 5e-5, relative: 1e-5, observedOrder: 1.8, note: "Must remain stable when both rate bounds expand by 25%." },
        assumptions: ["Unit notional.", "No default or liquidity spread."],
      },
      {
        id: "bond-option",
        label: "Bond option",
        summary: "European call on a Vasicek zero-coupon bond.",
        parameters: [
          numberParameter("bondMaturity", "Bond maturity", "S", "Underlying bond maturity, strictly after option expiry T.", "10", "contract", { unit: "yr", min: 0, max: 60, exclusiveMin: true }),
          numberParameter("strike", "Bond strike", "K", "Strike per unit bond notional.", "0.75", "contract", { min: 0, max: 2, exclusiveMin: true }),
        ],
        terminalCondition: { Call: String.raw`V(r,T)=\max(P(T,S)-K,0)`, Put: "", None: String.raw`V(r,T)=\max(P(T,S)-K,0)` },
        boundaryCondition: { Call: "", Put: "", None: String.raw`\text{Option value induced by affine bond asymptotics at }r_{\min}\text{ and }r_{\max}` },
        benchmark: "Analytic Vasicek European bond-option formula",
        tolerance: { pointwiseAbsolute: 1e-4, maxNorm: 5e-4, relative: 2e-4, observedOrder: 1.8, note: "Require S > T and expand the short-rate domain in validation." },
        assumptions: ["Call only in the MVP.", "Unit underlying bond notional."],
      },
    ],
  },
  "Hull–White": {
    short: "HW",
    description: "Curve-fitted Gaussian short rate",
    measure: "Q",
    measureMeaning: "Risk-neutral dynamics fitted exactly to today’s discount curve under the stated ϑ(t) convention.",
    state: String.raw`r\in[r_{\min},r_{\max}],\quad r_{\min}<0,\quad \tau=T-t`,
    equation: String.raw`\frac{\partial V}{\partial t}+[\vartheta(t)-ar]\frac{\partial V}{\partial r}+\frac{1}{2}\sigma_r^2\frac{\partial^2V}{\partial r^2}-rV=0`,
    scheme: "Time-dependent Rannacher–Crank–Nicolson",
    parameters: [
      numberParameter("shortRate", "Short rate", "r₀", "Current instantaneous short rate implied by the curve.", "0.03", "market", { unit: "dec", min: -0.25, max: 0.5 }),
      numberParameter("meanReversion", "Mean reversion", "a", "Risk-neutral mean-reversion speed.", "0.10", "calibrated", { min: 0, max: 10, exclusiveMin: true }),
      numberParameter("rateVolatility", "Rate volatility", "σᵣ", "Constant short-rate volatility.", "0.01", "calibrated", { unit: "dec", min: 0, max: 1, exclusiveMin: true }),
      numberParameter("maturity", "Claim maturity", "T", "Claim maturity.", "5.0", "contract", { unit: "yr", min: 0, max: 50, exclusiveMin: true }),
      numberParameter("curveId", "Curve snapshot", "P(0,·)", "Versioned discount-curve snapshot identifier.", "AUD-OIS-demo-2026-07-29", "market"),
    ],
    assumptions: ["Convention: dr=[ϑ(t)−ar]dt+σᵣdWᵠ.", "The input curve is positive, decreasing and interpolated in log-discount factors.", "a and σᵣ are constant."],
    diagnostics: ["input-curve reproduction", "rate-domain expansion", "theta reconstruction", "grid-refinement order"],
    contracts: [
      {
        id: "zero-coupon-bond",
        label: "Zero-coupon bond",
        summary: "Unit-notional discount bond consistent with the fitted curve.",
        terminalCondition: { Call: "", Put: "", None: String.raw`P(r,T;T)=1` },
        boundaryCondition: { Call: "", Put: "", None: String.raw`\text{Curve-consistent affine asymptotics at }r_{\min}\text{ and }r_{\max}` },
        benchmark: "Analytic Hull–White bond formula and reproduction of P(0,T)",
        tolerance: { pointwiseAbsolute: 1e-5, maxNorm: 5e-5, relative: 1e-5, observedOrder: 1.8, note: "Every curve pillar must be reproduced within 1 bp of discount factor relative error." },
        assumptions: ["Unit notional.", "No default or liquidity spread."],
      },
      {
        id: "bond-option",
        label: "Bond option",
        summary: "European call on a Hull–White zero-coupon bond.",
        parameters: [
          numberParameter("bondMaturity", "Bond maturity", "S", "Underlying bond maturity, strictly after option expiry T.", "10", "contract", { unit: "yr", min: 0, max: 60, exclusiveMin: true }),
          numberParameter("strike", "Bond strike", "K", "Strike per unit bond notional.", "0.75", "contract", { min: 0, max: 2, exclusiveMin: true }),
        ],
        terminalCondition: { Call: String.raw`V(r,T)=\max(P(T,S)-K,0)`, Put: "", None: String.raw`V(r,T)=\max(P(T,S)-K,0)` },
        boundaryCondition: { Call: "", Put: "", None: String.raw`\text{Option value induced by curve-consistent affine asymptotics}` },
        benchmark: "Analytic one-factor Hull–White European bond-option formula",
        tolerance: { pointwiseAbsolute: 2e-4, maxNorm: 1e-3, relative: 5e-4, observedOrder: 1.8, note: "Benchmark must use the same curve interpolation and ϑ(t) convention." },
        assumptions: ["Call only in the MVP.", "Unit underlying bond notional."],
      },
    ],
  },
  HJB: {
    short: "HJ",
    description: "Merton terminal-wealth allocation",
    measure: "P",
    measureMeaning: "Real-world decision measure; μ is a forecast return with provenance, not a pricing drift.",
    state: String.raw`W\in[W_{\min},W_{\max}],\quad W>0,\quad \tau=T-t`,
    equation: String.raw`\frac{\partial J}{\partial t}+\max_{\pi}\left\{[rW+\pi(\mu-r)]\frac{\partial J}{\partial W}+\frac{1}{2}\pi^2\sigma^2\frac{\partial^2J}{\partial W^2}\right\}=0`,
    scheme: "Monotone implicit fitted/upwind + Howard iteration",
    parameters: [
      numberParameter("wealth", "Initial wealth", "W₀", "Initial positive wealth.", "100", "scenario", { min: 0, exclusiveMin: true }),
      numberParameter("maturity", "Horizon", "T", "Allocation horizon.", "1.0", "contract", { unit: "yr", min: 0, max: 50, exclusiveMin: true }),
      numberParameter("rate", "Risk-free rate", "r", "Real-world risk-free investment rate.", "0.03", "market", { unit: "dec", min: -0.25, max: 0.5 }),
      numberParameter("expectedReturn", "Expected return", "μ", "Versioned P-measure risky-asset return forecast.", "0.08", "scenario", { unit: "dec", min: -1, max: 2 }),
      numberParameter("volatility", "Volatility", "σ", "P-measure annualised risky-asset volatility.", "0.20", "scenario", { unit: "dec", min: 0, max: 5, exclusiveMin: true }),
      numberParameter("riskAversion", "Risk aversion", "γ", "CRRA coefficient; γ=1 is excluded and handled as log utility later.", "3", "scenario", { min: 0, max: 20, exclusiveMin: true }),
      numberParameter("controlMin", "Minimum control", "πmin", "Minimum dollar risky-asset position.", "-100", "contract", { min: -10000, max: 10000 }),
      numberParameter("controlMax", "Maximum control", "πmax", "Maximum dollar risky-asset position.", "200", "contract", { min: -10000, max: 10000 }),
    ],
    assumptions: ["CRRA utility U(W)=W¹⁻ᵞ/(1−γ), γ>0 and γ≠1.", "Dollar control π is bounded and wealth remains positive.", "Forecast inputs carry timestamp, horizon and model-version provenance."],
    diagnostics: ["Bellman residual", "policy-iteration residual", "control-bound activity", "monotonicity", "closed-form unconstrained limit"],
    contracts: [
      {
        id: "merton-allocation",
        label: "Merton allocation",
        summary: "Constrained terminal-wealth maximisation with CRRA utility.",
        terminalCondition: { Call: "", Put: "", None: String.raw`J(W,T)=\frac{W^{1-\gamma}}{1-\gamma}` },
        boundaryCondition: { Call: "", Put: "", None: String.raw`\text{Positive-wealth state constraint; one-sided monotone stencil at }W_{\min}\text{ and asymptotic CRRA growth at }W_{\max}` },
        benchmark: "Closed-form unconstrained Merton value and optimal policy when bounds are inactive",
        tolerance: { pointwiseAbsolute: 1e-3, maxNorm: 5e-3, relative: 1e-3, observedOrder: 0.9, note: "Validate both value and control; policy absolute tolerance is 2×10⁻³ of W₀ per year." },
        assumptions: ["Terminal utility only; no consumption.", "One risky asset with constant P-measure coefficients."],
      },
    ],
  },
};

export const MODEL_KEYS = Object.keys(MODEL_SPECS) as ModelKey[];

export function getContractSpec(model: ModelKey, contractId: string): ContractSpec {
  return MODEL_SPECS[model].contracts.find((item) => item.id === contractId) ?? MODEL_SPECS[model].contracts[0];
}

export function getActiveParameters(model: ModelKey, contractId: string): readonly ParameterSpec[] {
  const spec = MODEL_SPECS[model];
  const contract = getContractSpec(model, contractId);
  const seen = new Set<string>();
  return [...spec.parameters, ...(contract.parameters ?? [])].filter((parameter) => {
    if (seen.has(parameter.id)) return false;
    seen.add(parameter.id);
    return true;
  });
}

export function defaultParameters(model: ModelKey, contractId: string): Record<string, string> {
  return Object.fromEntries(getActiveParameters(model, contractId).map((parameter) => [parameter.id, parameter.defaultValue]));
}

export interface ParameterValidationIssue {
  fieldId: string;
  message: string;
}

export function validateParameterFields(
  model: ModelKey,
  contractId: string,
  values: Record<string, string>,
  options: { barrierType?: "Up & out" | "Down & out" } = {},
): ParameterValidationIssue[] {
  const issues: ParameterValidationIssue[] = [];
  const add = (fieldId: string, message: string) => {
    if (!issues.some((issue) => issue.fieldId === fieldId && issue.message === message)) issues.push({ fieldId, message });
  };
  for (const parameter of getActiveParameters(model, contractId)) {
    const raw = values[parameter.id];
    if (!raw?.trim()) {
      add(parameter.id, `${parameter.symbol} is required.`);
      continue;
    }
    if (parameter.id === "curveId") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      add(parameter.id, `${parameter.symbol} must be numeric.`);
      continue;
    }
    if (parameter.min !== undefined && (parameter.exclusiveMin ? value <= parameter.min : value < parameter.min)) {
      add(parameter.id, `${parameter.symbol} must be ${parameter.exclusiveMin ? ">" : "≥"} ${parameter.min}.`);
    }
    if (parameter.max !== undefined && value > parameter.max) add(parameter.id, `${parameter.symbol} must be ≤ ${parameter.max}.`);
  }

  const number = (id: string) => Number(values[id]);
  if (contractId === "bond-option" && number("bondMaturity") <= number("maturity")) add("bondMaturity", "Bond maturity S must be after option expiry T.");
  if (contractId === "barrier") {
    const spot = number("spot");
    const barrier = number("barrier");
    if (Number.isFinite(spot) && Number.isFinite(barrier)) {
      if (spot === barrier) add("barrier", "Barrier H cannot equal spot S₀ at inception.");
      if (options.barrierType === "Up & out" && barrier <= spot) add("barrier", "An up-and-out barrier H must be above spot S₀ for a live contract.");
      if (options.barrierType === "Down & out" && barrier >= spot) add("barrier", "A down-and-out barrier H must be below spot S₀ for a live contract.");
    }
  }
  if (model === "HJB") {
    if (number("controlMin") >= number("controlMax")) add("controlMax", "πmin must be strictly below πmax.");
    if (number("controlMin") > 0 || number("controlMax") < 0) add("controlMin", "The control interval must include π=0 for the positive-wealth state constraint.");
    if (Math.abs(number("riskAversion") - 1) < 1e-12) add("riskAversion", "γ=1 requires log utility and is outside this CRRA specification.");
  }
  return issues;
}

export function validateParameters(model: ModelKey, contractId: string, values: Record<string, string>): string[] {
  return validateParameterFields(model, contractId, values).map((issue) => issue.message);
}

export function diagnosticWarnings(model: ModelKey, values: Record<string, string>): string[] {
  if (model !== "Heston") return [];
  const kappa = Number(values.kappa);
  const theta = Number(values.theta);
  const xi = Number(values.xi);
  if ([kappa, theta, xi].every(Number.isFinite) && 2 * kappa * theta < xi * xi) {
    return ["Feller condition 2κθ ≥ ξ² is violated; retain the run but apply the v=0 boundary and flag it."];
  }
  return [];
}

export function toleranceLabel(tolerance: AcceptanceTolerance): string {
  return `|ΔV|₀ ≤ ${tolerance.pointwiseAbsolute.toExponential(0)}`;
}
