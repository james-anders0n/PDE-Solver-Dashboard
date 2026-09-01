/**
 * Challenging Heston cases I–III published by Andersen for weak-bias studies.
 *
 * Source: L. B. G. Andersen, "Simple and Efficient Simulation of the Heston
 * Stochastic Volatility Model", Journal of Computational Finance 11(3), 2008,
 * DOI 10.21314/JCF.2008.189. Spot and strike are normalised to 100 and q=0.
 */
export const ANDERSEN_HESTON_FIXTURES = [
  {
    id: "andersen-case-i-long-dated-fx",
    label: "Andersen case I · long-dated FX",
    spot: 100,
    strike: 100,
    maturity: 10,
    rate: 0,
    dividend: 0,
    v0: 0.04,
    kappa: 0.5,
    theta: 0.04,
    xi: 1,
    rho: -0.9,
    side: "Call" as const,
  },
  {
    id: "andersen-case-ii-long-dated-rates",
    label: "Andersen case II · long-dated rates",
    spot: 100,
    strike: 100,
    maturity: 15,
    rate: 0,
    dividend: 0,
    v0: 0.04,
    kappa: 0.3,
    theta: 0.04,
    xi: 0.9,
    rho: -0.5,
    side: "Call" as const,
  },
  {
    id: "andersen-case-iii-equity",
    label: "Andersen case III · equity",
    spot: 100,
    strike: 100,
    maturity: 5,
    rate: 0.05,
    dividend: 0,
    v0: 0.09,
    kappa: 1,
    theta: 0.09,
    xi: 1,
    rho: -0.3,
    side: "Call" as const,
  },
] as const;
