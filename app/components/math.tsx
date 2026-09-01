import katex from "katex";

type MathProps = {
  math: string;
  display?: boolean;
  className?: string;
  label?: string;
};

/** Render trusted application-authored TeX as accessible MathML and KaTeX HTML. */
export function Math({ math, display = false, className = "", label }: MathProps) {
  const markup = katex.renderToString(math, {
    displayMode: display,
    output: "htmlAndMathml",
    strict: false,
    throwOnError: false,
    trust: false,
  });

  return (
    <span
      className={`math ${display ? "math-display" : "math-inline"} ${className}`.trim()}
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

const SYMBOL_TEX: Record<string, string> = {
  "S₀": "S_0",
  "W₀": "W_0",
  "r₀": "r_0",
  "v₀": "v_0",
  "σ": "\\sigma",
  "σᵣ": "\\sigma_r",
  "μ": "\\mu",
  "γ": "\\gamma",
  "κ": "\\kappa",
  "θ": "\\theta",
  "ξ": "\\xi",
  "ρ": "\\rho",
  "πmin": "\\pi_{\\min}",
  "πmax": "\\pi_{\\max}",
  "P(0,·)": "P(0,\\cdot)",
};

export const symbolTex = (symbol: string) => SYMBOL_TEX[symbol] ?? symbol;

const ECONOMIC_FORMULA_TEX: Record<string, string> = {
  "μscenario = clamp(μforecast + regime return adjustment, −1, 2)": String.raw`\mu_{\mathrm{scenario}}=\operatorname{clamp}\!\left(\mu_{\mathrm{forecast}}+\text{regime return adjustment},-1,2\right)`,
  "σscenario = clamp(σforecast × regime volatility multiplier, 10⁻⁶, 5)": String.raw`\sigma_{\mathrm{scenario}}=\operatorname{clamp}\!\left(\sigma_{\mathrm{forecast}}\times\text{regime volatility multiplier},10^{-6},5\right)`,
  "rscenario = clamp(policy-rate forecast + regime rate shift, −0.25, 0.50)": String.raw`r_{\mathrm{scenario}}=\operatorname{clamp}\!\left(\text{policy-rate forecast}+\text{regime rate shift},-0.25,0.50\right)`,
  "v₀ scenario prior = clamp((σforecast × regime volatility multiplier)², 10⁻⁸, 4)": String.raw`v_{0,\mathrm{scenario}}=\operatorname{clamp}\!\left(\left(\sigma_{\mathrm{forecast}}\times\text{regime volatility multiplier}\right)^2,10^{-8},4\right)`,
  "bscenario = clamp(policy-rate forecast + regime rate shift, −0.25, 0.50)": String.raw`b_{\mathrm{scenario}}=\operatorname{clamp}\!\left(\text{policy-rate forecast}+\text{regime rate shift},-0.25,0.50\right)`,
  "r₀ scenario overlay = clamp(policy-rate forecast + regime rate shift, −0.25, 0.50)": String.raw`r_{0,\mathrm{scenario}}=\operatorname{clamp}\!\left(\text{policy-rate forecast}+\text{regime rate shift},-0.25,0.50\right)`,
};

export const economicFormulaTex = (formula: string) => ECONOMIC_FORMULA_TEX[formula] ?? null;

