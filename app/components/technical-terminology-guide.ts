import { createElement } from "react";

export const TECHNICAL_TERMS = [
  { term: "Q measure", meaning: "Risk-neutral pricing convention calibrated to today’s market. It is not a forecast of realised returns." },
  { term: "P measure", meaning: "Real-world probability convention used for historical estimates, economic scenarios, and investment opportunities." },
  { term: "Proxy / calibrated / derived", meaning: "A proxy substitutes a related source and is not equivalent; calibrated values are fitted to observations; derived values are calculated from other inputs." },
  { term: "OIS", meaning: "Overnight Index Swap curve, commonly used for collateralised discounting. A Treasury curve proxy must not be described as OIS." },
  { term: "Feller condition", meaning: "The Heston diagnostic 2κθ ≥ ξ². Passing is sufficient for strictly positive variance; failing is disclosed but does not automatically invalidate the numerical model." },
  { term: "ln(K/F)", meaning: "Forward log-moneyness: the natural log of strike K divided by forward F. Zero is at-the-money-forward." },
] as const;

export const SCHEME_EXPLANATIONS: Record<string, string> = {
  "explicit-euler": "Explicit Euler is simple and fast per step but conditionally stable.",
  "backward-euler": "Backward Euler is robust and strongly damping, with first-order time accuracy.",
  "crank-nicolson": "Crank–Nicolson is second-order in time but may oscillate near payoff kinks.",
  "rannacher-cn": "Rannacher–Crank–Nicolson starts with damping half-steps, then uses Crank–Nicolson.",
  "mcs-adi": "Modified Craig–Sneyd ADI splits the two-dimensional Heston operator efficiently.",
  "hv-adi": "Hundsdorfer–Verwer ADI is an alternative stable splitting for the Heston cross term.",
  "howard-implicit": "Howard implicit iteration alternates value solves and bounded HJB policy improvement.",
} as const;

export function TechnicalTerminologyGuide({ schemeOptions = [] }: { schemeOptions?: ReadonlyArray<{ id: string; label: string }> }) {
  return createElement("details", { className: "technical-terminology-guide" },
    createElement("summary", null,
      createElement("span", null, createElement("b", null, "First-use terminology"), createElement("small", null, "Measures, evidence classes, curve language, and numerical methods")),
      createElement("i", { "aria-hidden": "true" }, "+"),
    ),
    createElement("div", { className: "technical-term-grid" },
      ...TECHNICAL_TERMS.map((item) => createElement("article", { key: item.term }, createElement("b", null, item.term), createElement("p", null, item.meaning))),
      ...schemeOptions.map((scheme) => createElement("article", { key: scheme.id }, createElement("b", null, scheme.label), createElement("p", null, SCHEME_EXPLANATIONS[scheme.id] ?? "Model-compatible numerical scheme; see the advanced solver controls for its role."))),
    ),
  );
}

