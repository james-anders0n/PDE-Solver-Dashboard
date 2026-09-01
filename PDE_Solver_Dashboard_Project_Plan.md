# Interactive PDE Solver Dashboard — Project Plan

## 1\. Project goal

Build an interactive quantitative-finance dashboard that:

1. lets the user select a **model**, **contract/control problem**, and **numerical scheme**;
2. displays the governing equation, terminal condition, boundary conditions, and active assumptions;
3. solves the problem with finite differences;
4. compares the finite-difference result with an analytic, semi-analytic, or Monte Carlo benchmark;
5. visualises the solution surface, value slice at (t=0), error, convergence, and—where relevant—Greeks or optimal controls; and
6. optionally converts outputs from an economic prediction model into defensible scenarios, priors, or model inputs.

The five model families are:

* Black–Scholes;
* Heston stochastic volatility;
* Vasicek short rate;
* one-factor Hull–White short rate; and
* a specified Hamilton–Jacobi–Bellman control problem.

> \\\*\\\*Important design rule:\\\*\\\* the stochastic model determines the differential operator. The contract normally determines the payoff and boundary conditions. For example, European calls and puts obey the same Black–Scholes operator but have different terminal conditions. American exercise changes the problem into a variational inequality. The dashboard should present each selection as a different \\\*\\\*governing problem\\\*\\\*, without falsely claiming that every payoff has an entirely different operator.

\---

## 2\. Recommended scope

### MVP

Implement the following in this order:

1. Black–Scholes European call and put;
2. Black–Scholes digital and barrier options;
3. Black–Scholes American put;
4. Vasicek zero-coupon bond and bond option;
5. Hull–White zero-coupon bond and a simple rate derivative;
6. Heston European call and put;
7. one clearly specified HJB problem, preferably the Merton terminal-wealth allocation problem.

### Later extensions

* local volatility;
* dividends and discrete cash flows;
* callable bonds;
* caplets, caps, floors, and swaptions;
* two-factor Hull–White;
* Heston–Hull–White;
* Markov-switching or regime-coupled PDEs;
* transaction costs in the HJB problem;
* adaptive grids, finite elements, or sparse grids;
* automatic calibration to live market data.

Do not begin with a combined Heston–Hull–White solver. It is a three-dimensional PDE with mixed derivatives and is much harder to validate, debug, and run interactively.

\---

## 3\. Governing equations

Use time to maturity

\[
\\tau=T-t
]

internally where possible. This turns backward pricing problems into forward time-marching problems from (\\tau=0) to (\\tau=T).

### 3.1 Black–Scholes

Under the risk-neutral measure (Q),

\[
dS\_t=(r-q)S\_t,dt+\\sigma S\_t,dW\_t^Q.
]

The value (V(S,t)) satisfies

\[
\\frac{\\partial V}{\\partial t}
+\\frac{1}{2}\\sigma^2S^2\\frac{\\partial^2V}{\\partial S^2}
+(r-q)S\\frac{\\partial V}{\\partial S}
-rV=0.
]

Inputs:

* spot (S\_0);
* strike (K);
* maturity (T);
* risk-free rate (r);
* dividend yield (q);
* volatility (\\sigma);
* contract type;
* barrier (H), rebate, and monitoring convention where applicable.

Initial/terminal payoff examples:

\[
V(S,T)=\\max(S-K,0)
]

for a European call, and

\[
V(S,T)=\\max(K-S,0)
]

for a European put.

American options should be represented as the complementarity problem

\[
\\max\\left(
\\frac{\\partial V}{\\partial t}+\\mathcal{L}\_{BS}V-rV,,
\\Phi(S)-V
\\right)=0,
]

where (\\Phi) is the exercise payoff.

### 3.2 Heston

Under (Q),

\[
dS\_t=(r-q)S\_t,dt+\\sqrt{v\_t}S\_t,dW\_t^{S,Q},
]

\[
dv\_t=\\kappa(\\theta-v\_t),dt+\\xi\\sqrt{v\_t},dW\_t^{v,Q},
\\qquad
dW\_t^{S,Q}dW\_t^{v,Q}=\\rho,dt.
]

The pricing PDE is

\[
\\begin{aligned}
0={}\&V\_t
+\\frac{1}{2}vS^2V\_{SS}
+\\rho\\xi vS V\_{Sv}
+\\frac{1}{2}\\xi^2vV\_{vv}\\
\&+(r-q)SV\_S
+\\kappa(\\theta-v)V\_v
-rV.
\\end{aligned}
]

Inputs:

* all applicable contract inputs;
* initial variance (v\_0);
* mean-reversion speed (\\kappa);
* long-run variance (\\theta);
* volatility of variance (\\xi);
* correlation (\\rho);
* market-calibration metadata;
* (S)- and (v)-domain limits and grids.

The Feller condition

\[
2\\kappa\\theta\\geq \\xi^2
]

is useful diagnostic information, but violating it does not automatically invalidate the model or solver. It changes the behaviour near (v=0), so the degenerate boundary must be treated carefully.

### 3.3 Vasicek

Under (Q),

\[
dr\_t=a(b-r\_t),dt+\\sigma\_r,dW\_t^Q.
]

For a claim (V(r,t)),

\[
V\_t+a(b-r)V\_r+\\frac{1}{2}\\sigma\_r^2V\_{rr}-rV=0.
]

Inputs:

* current short rate (r\_0);
* mean-reversion speed (a);
* risk-neutral long-run mean (b);
* rate volatility (\\sigma\_r);
* maturity and contract inputs;
* lower and upper rate boundaries.

Use a rate grid that permits negative rates. Do not silently truncate the state at (r=0), because Vasicek is Gaussian.

### 3.4 One-factor Hull–White

Use the convention

\[
dr\_t=\\left\[\\vartheta(t)-ar\_t\\right]dt+\\sigma\_r,dW\_t^Q.
]

The claim value satisfies

\[
V\_t+\\left\[\\vartheta(t)-ar\\right]V\_r
+\\frac{1}{2}\\sigma\_r^2V\_{rr}-rV=0.
]

Inputs:

* current discount curve (P(0,T)) or instantaneous forward curve (f(0,T));
* mean reversion (a);
* rate volatility (\\sigma\_r);
* the derived time-dependent drift (\\vartheta(t));
* rate-domain and contract inputs.

The dashboard must state its Hull–White convention because authors use different definitions for (\\theta(t)), (\\vartheta(t)), and the shifted state variable. Derive the drift consistently from the observed initial curve and the chosen convention.

### 3.5 Hamilton–Jacobi–Bellman equation

There is no single generic, plug-in HJB equation. It must be generated from a specific:

* state process;
* admissible control set;
* reward or cost functional;
* horizon;
* terminal condition; and
* constraints.

A general controlled diffusion has HJB equation

\[
0=J\_t+\\sup\_{u\\in\\mathcal U}
\\left{
b(x,u,t)^\\top\\nabla J
+\\frac{1}{2}
\\operatorname{tr}\\left\[
\\Sigma(x,u,t)\\Sigma(x,u,t)^\\top\\nabla^2J
\\right]
+f(x,u,t)
\\right}.
]

For the first implementation, use the one-state Merton terminal-wealth problem:

\[
dW\_t=\\left\[rW\_t+\\pi\_t(\\mu-r)\\right]dt+\\pi\_t\\sigma,dB\_t,
]

\[
0=J\_t+\\max\_{\\pi\\in\\mathcal U}
\\left{
\\left\[rW+\\pi(\\mu-r)\\right]J\_W
+\\frac{1}{2}\\pi^2\\sigma^2J\_{WW}
\\right},
\\qquad
J(W,T)=U(W).
]

This creates a natural and defensible place to use predicted expected returns or regime probabilities because this is a real-world decision problem, not an arbitrage-free derivative-pricing equation.

\---

## 4\. Model and contract selection logic

Use separate selectors.

|Model selector|Contract/problem selector|Governing problem|
|-|-|-|
|Black–Scholes|European call/put|Linear 1D parabolic PDE|
|Black–Scholes|Digital|Same operator; discontinuous payoff|
|Black–Scholes|Barrier|Same interior operator; barrier boundary and truncated domain|
|Black–Scholes|American call/put|Variational inequality / linear complementarity problem|
|Heston|European call/put|Linear 2D PDE with a mixed derivative|
|Heston|Barrier|2D PDE with barrier boundary|
|Vasicek|Zero-coupon bond|Linear 1D short-rate PDE|
|Vasicek|Bond option|Same operator; different terminal payoff|
|Hull–White|Zero-coupon bond|Time-inhomogeneous 1D short-rate PDE|
|Hull–White|Rate derivative|Same operator with contract-specific payoff|
|HJB|Merton allocation|Nonlinear control PDE|

Each selection should dynamically load:

* equation in LaTeX;
* model assumptions;
* input form and valid ranges;
* terminal condition;
* lower and upper boundary conditions;
* recommended scheme;
* benchmark method;
* warnings, such as violated parameter constraints;
* relevant plots.

\---

## 5\. Recommended finite-difference schemes

### Default scheme matrix

|Problem|Recommended default|Alternatives|Main reason|
|-|-|-|-|
|Black–Scholes European|Crank–Nicolson with Rannacher start-up|Backward Euler; explicit FTCS for teaching|Accurate and efficient after smoothing payoff nonsmoothness|
|Black–Scholes digital/barrier|Rannacher-smoothed Crank–Nicolson on a fitted/nonuniform grid|Backward Euler|Reduces oscillations around discontinuities and barriers|
|Black–Scholes American|Backward Euler or Rannacher-CN plus projected SOR|Brennan–Schwartz; penalty method; policy iteration|Solves the early-exercise complementarity condition|
|Vasicek|Rannacher-CN on a nonuniform (r)-grid|Backward Euler|One-dimensional, stable, and easy to benchmark|
|Hull–White|Rannacher-CN with time-dependent coefficients|Backward Euler; shifted-state formulation|Robust for a time-inhomogeneous one-factor PDE|
|Heston|Modified Craig–Sneyd ADI, with Rannacher-style start-up|Hundsdorfer–Verwer ADI; Craig–Sneyd|Efficient treatment of two dimensions and the mixed derivative|
|HJB|Monotone implicit/upwind scheme plus Howard policy iteration|Semi-Lagrangian; monotone wide-stencil scheme|Preserves convergence to the viscosity solution|

### Scheme notes

#### Explicit FTCS

Implement only as an educational comparison. It is easy to understand but subject to a restrictive stability condition. The interface should calculate the relevant mesh ratios and warn the user when the selected grid violates the stability restriction.

#### Backward Euler

Use this as the robust baseline:

* first-order in time;
* unconditionally stable for the standard linear problems;
* generally more damping and less oscillation near nonsmooth payoffs;
* useful for reference solutions and the first start-up steps.

#### Crank–Nicolson

Use second-order centred spatial differences and Crank–Nicolson time marching for smooth regions. Because option payoffs often contain a kink or discontinuity, begin with several backward-Euler half-steps before switching to Crank–Nicolson. Make the number of Rannacher half-steps configurable, with four half-steps as a sensible initial default.

#### Drift discretisation

Centred differences are accurate when diffusion dominates. Add upwind or fitted discretisation when convection dominates, particularly:

* near the degenerate (v=0) Heston boundary;
* at extreme short rates;
* in HJB equations; and
* whenever a local mesh Péclet diagnostic indicates that centred differences may oscillate.

#### Heston ADI

Split the semi-discrete operator into:

* an (S)-direction component;
* a (v)-direction component; and
* a mixed-derivative/cross component.

Use Modified Craig–Sneyd (MCS) as the initial production default. Test parameters such as (\\theta\_{\\mathrm{ADI}}=1/3) rather than hard-coding a value without regression tests. Retain Hundsdorfer–Verwer as a selectable alternative. Use nonuniform grids concentrated near (S=K), (S=S\_0), and (v=v\_0).

#### HJB

Do not use ordinary centred Crank–Nicolson as the default for a nonlinear HJB equation. The convergence theory for viscosity solutions motivates schemes that are:

* consistent;
* stable; and
* monotone.

Use backward time marching, upwind derivatives where required, and Howard/policy iteration at each time layer. Validate both the value function and recovered optimal policy.

\---

## 6\. Boundary and grid design

Boundary conditions are part of the financial model, not a cosmetic numerical choice.

### Black–Scholes

* (S\_{\\min}=0);
* choose (S\_{\\max}) from strike, spot, maturity, and volatility rather than using one fixed multiple;
* use asymptotic Dirichlet or Neumann conditions appropriate to call/put and dividends;
* align a barrier exactly with a grid node;
* concentrate nodes around (K), (S\_0), and barriers.

### Heston

* use (S\\in\[0,S\_{\\max}]) and (v\\in\[0,v\_{\\max}]);
* derive (v\_{\\max}) from (v\_0,\\theta,\\xi,\\kappa,T), with a user override;
* use the reduced/degenerate PDE at (v=0), consistent with boundary classification;
* impose a tested far-variance condition at (v\_{\\max});
* use a nine-point stencil or equivalent treatment for (V\_{Sv});
* test positivity, stability, and behaviour as (\\rho\\to0).

### Vasicek and Hull–White

* select (\[r\_{\\min},r\_{\\max}]) from conditional mean plus several conditional standard deviations;
* permit negative (r\_{\\min});
* use one-sided or asymptotic conditions at rate boundaries;
* check that expanding the rate domain does not materially change the price.

### HJB

* define economically meaningful state constraints;
* prevent the wealth grid from crossing invalid values when utility is defined only for (W>0);
* define admissible controls explicitly;
* handle state-constraint boundaries consistently with the control problem.

\---

## 7\. Connecting the economic prediction model

### The measure problem

Historical/economic forecasting usually estimates dynamics under the real-world measure (P). Arbitrage-free derivative prices use dynamics under the risk-neutral measure (Q). Therefore:

* do **not** replace the Black–Scholes or Heston drift with a predicted equity return;
* do **not** treat a forecast policy rate as automatically equal to the pricing curve;
* do estimate or calibrate risk premia if converting (P)-measure forecasts into (Q)-measure parameters;
* show “historical/scenario” and “risk-neutral/calibrated” parameter sets separately.

### Defensible integration map

|Economic-model output|Best first use|Do not do|
|-|-|-|
|Predicted equity return (\\hat\\mu)|HJB portfolio-allocation input under (P)|Insert it as the Black–Scholes pricing drift|
|Rate/yield forecast|Scenario analysis and stress paths; calibration prior|Replace today’s market discount curve for an arbitrage-free base price|
|Current observed yield curve|Derive Hull–White drift and discounting inputs|Smooth it without recording the interpolation method|
|Predicted volatility/regime|Scenario-conditioned (v\_0), (\\sigma), or parameter prior|Call it implied volatility without market calibration|
|Growth/inflation/financial-conditions scores|Regime label, stress scenario, or bridge-model feature|Map scores directly to parameters with arbitrary hand-set coefficients|
|Regime probabilities|Weighted scenario dashboard or later regime-switching model|Average nonlinear parameters without validation|
|Expected risk premium|HJB and strategic allocation|Use directly in a (Q)-pricing PDE|

### Integration architecture

Create a separate **economic-to-PDE bridge**:

1. economic model produces forecasts, probabilities, and uncertainty intervals;
2. a versioned mapping layer converts them into scenario inputs or parameter priors;
3. constraints enforce valid domains, for example
\[
\\kappa>0,\\quad \\theta>0,\\quad \\xi>0,\\quad -1\\leq\\rho\\leq1;
]
4. the calibration layer combines priors with current market data where a risk-neutral price is required;
5. the dashboard labels each run as:

   * market-calibrated;
   * historical;
   * macro-conditioned scenario; or
   * hybrid/regularised calibration;
6. the run stores an audit record containing data timestamp, forecast horizon, model version, mapping version, and calibrated parameters.

### Strong future extension

If the economic model produces regime transition probabilities, build a Markov-switching PDE only after the independent solvers work. A regime-switching value function becomes a coupled system:

\[
\\frac{\\partial V\_i}{\\partial t}
+\\mathcal L\_iV\_i-r\_iV\_i
+\\sum\_j q\_{ij}V\_j=0,
]

where (i) indexes the economic regime and (Q=(q\_{ij})) is the transition generator. This is materially different from simply changing one parameter at each date.

\---

## 8\. Software architecture

Keep numerical code independent of the user interface.

```text
pde-solver/
├── app/
│   ├── pages/
│   ├── components/
│   └── state/
├── pde\\\_engine/
│   ├── grids/
│   ├── operators/
│   ├── boundary\\\_conditions/
│   ├── time\\\_steppers/
│   ├── linear\\\_solvers/
│   ├── complementarity/
│   └── control/
├── models/
│   ├── black\\\_scholes.py
│   ├── heston.py
│   ├── vasicek.py
│   ├── hull\\\_white.py
│   └── hjb\\\_merton.py
├── contracts/
├── calibration/
├── economic\\\_bridge/
├── benchmarks/
├── tests/
└── examples/
```

### Recommended first technology stack

* Python;
* NumPy and SciPy sparse matrices/linear solvers;
* Numba only after profiling;
* Plotly for interactive surfaces and convergence plots;
* Streamlit for the fastest MVP, or FastAPI plus React/TypeScript for a more polished long-term application;
* Pydantic/dataclasses for validated inputs;
* pytest for unit, convergence, and regression tests.

### Core interfaces

Each model should provide:

* `state\\\_dimensions`;
* `coefficients(state, time, params)`;
* `build\\\_operator(grid, time, params)`;
* `terminal\\\_condition(grid, contract)`;
* `boundary\\\_conditions(grid, time, contract, params)`;
* `recommended\\\_scheme`;
* `validation\\\_warnings`;
* `benchmark\\\_price` where available.

Each solver should return:

* price/value array;
* grids and time levels;
* interpolated value at the requested initial state;
* diagnostic messages;
* iterations and runtime;
* residual/error history;
* grid and scheme metadata.

\---

## 9\. Dashboard design

Follow the attached dark-dashboard concept with these panels.

### Left control panel

* model;
* contract/control problem;
* call/put where relevant;
* market and contract parameters;
* model-specific parameters;
* calibration/scenario source;
* grid limits and density;
* time steps;
* numerical scheme;
* benchmark settings;
* “Solve” button.

### Main result area

1. governing equation and active conditions;
2. finite-difference value;
3. analytic/semi-analytic/Monte Carlo benchmark;
4. absolute and relative error;
5. runtime and solver diagnostics;
6. solution surface or heatmap;
7. (t=0) value slice;
8. benchmark comparison;
9. convergence plot;
10. Greeks or optimal control;
11. parameter/scenario provenance.

For one-dimensional state models, a surface (V(x,t)) is appropriate. For Heston, the full object is (V(S,v,t)), so show:

* (V(S,v,t=0)) as a surface;
* (V(S,t)) at (v=v\_0);
* (V(v,t)) at (S=S\_0); and
* selectable heatmap slices.

Do not attempt to display a four-axis chart.

\---

## 10\. Validation and testing

### Benchmarks

|Model/problem|Benchmark|
|-|-|
|Black–Scholes European|Closed-form Black–Scholes price and Greeks|
|Black–Scholes American|High-resolution binomial/tree or trusted LCP reference|
|Heston European|Semi-analytic Fourier/integration formula|
|Vasicek bond|Analytic affine zero-coupon bond formula|
|Hull–White bond|Analytic bond formula consistent with the fitted curve|
|Merton HJB|Known closed-form solution for CRRA/log utility where applicable|

### Required test classes

1. **Unit tests:** coefficients, grids, interpolation, boundary values, matrix assembly.
2. **Manufactured or analytic solution tests:** verify the entire solver against known values.
3. **Grid-refinement tests:** halve (\\Delta S), (\\Delta r), (\\Delta v), and (\\Delta t); estimate observed convergence order.
4. **Domain tests:** expand (S\_{\\max}), (v\_{\\max}), and rate bounds.
5. **No-arbitrage tests:** positivity, intrinsic-value bounds, monotonicity in spot/strike where appropriate.
6. **Greek tests:** compare PDE derivatives with analytic Greeks and bump-and-reprice estimates.
7. **Stress tests:** near-zero volatility, short maturity, deep in/out of the money, extreme correlation, violated Feller condition.
8. **Regression tests:** store approved prices and tolerances for standard parameter fixtures.
9. **Performance tests:** runtime and memory as grid size increases.
10. **Economic-data tests:** strict timestamp alignment, no look-ahead leakage, forecast vintage preservation, and scenario reproducibility.

Report error as more than one number:

\[
E\_\\infty=\\max\_i |V\_i-V\_i^{\\mathrm{ref}}|,
\\qquad
E\_2=
\\left(
\\frac{1}{n}\\sum\_i|V\_i-V\_i^{\\mathrm{ref}}|^2
\\right)^{1/2}.
]

Also report the interpolation error at (S\_0), (r\_0), or ((S\_0,v\_0)).

\---

## 11\. Build roadmap

### Phase 0 — mathematical specification

* fix notation and (P)-versus-(Q) conventions;
* define supported contracts;
* derive terminal and boundary conditions;
* choose reference prices and tolerances;
* write parameter schemas.

**Exit criterion:** every MVP screen has a written governing problem and benchmark.

### Phase 1 — reusable 1D engine

* uniform and nonuniform grids;
* tridiagonal operator assembly;
* Thomas or sparse tridiagonal solve;
* explicit, backward Euler, and Crank–Nicolson steppers;
* Rannacher start-up;
* interpolation and diagnostics.

**Exit criterion:** Black–Scholes European prices converge to the analytic solution.

### Phase 2 — Black–Scholes products

* calls and puts;
* digitals;
* barriers;
* American put through projected SOR or policy iteration;
* payoff-aware grids and boundary conditions;
* Greeks and convergence views.

**Exit criterion:** all products pass price, boundary, refinement, and no-arbitrage tests.

### Phase 3 — short-rate models

* Vasicek PDE and analytic bond benchmark;
* negative-rate grid support;
* Hull–White initial-curve fitting;
* time-dependent coefficients;
* bond and simple rate-derivative payoffs.

**Exit criterion:** the Hull–White implementation reproduces the input discount curve within tolerance.

### Phase 4 — Heston 2D engine

* tensor/nonuniform (S)-(v) grid;
* cross-derivative stencil;
* MCS and HV ADI;
* degenerate (v=0) treatment;
* semi-analytic Heston benchmark;
* surface and slice visualisations.

**Exit criterion:** convergence and stability hold across a published parameter test set.

### Phase 5 — HJB

* specify Merton objective, utility, constraints, and terminal data;
* monotone spatial discretisation;
* control grid or analytic pointwise optimiser;
* Howard policy iteration;
* value and policy plots;
* closed-form comparison in the unconstrained case.

**Exit criterion:** both value function and control converge to the known solution.

### Phase 6 — economic-model bridge

* define an input contract for forecasts and regime probabilities;
* add timestamp and uncertainty metadata;
* implement constrained mappings;
* separate scenario and calibrated parameters;
* add parameter provenance and scenario comparison;
* test against look-ahead bias and invalid parameter combinations.

**Exit criterion:** every displayed economic input has a traceable transformation and financial interpretation.

### Phase 7 — interface and deployment

* reproduce the dashboard layout;
* move heavy solves into background jobs if necessary;
* cache identical runs;
* add downloadable results and configuration;
* profile and optimise;
* add user-facing explanations and warnings.

\---

## 12\. Research checklist

### Mathematics

* Feynman–Kac representation and risk-neutral valuation;
* change of measure and market price of risk;
* parabolic PDE classification;
* terminal, Dirichlet, Neumann, Robin, asymptotic, and state-constraint boundaries;
* consistency, stability, convergence, and the Lax equivalence principle for linear problems;
* truncation error and observed convergence order;
* monotone schemes and viscosity solutions for HJB equations;
* complementarity problems and free boundaries for American options.

### Numerical methods

* nonuniform coordinate transformations;
* Rannacher time stepping;
* sparse and tridiagonal linear systems;
* M-matrices, positivity, and discrete maximum principles;
* upwinding, fitted schemes, and local Péclet numbers;
* ADI splitting with mixed derivatives;
* projected SOR, penalty methods, and policy iteration;
* interpolation errors and Greek calculation;
* domain truncation and boundary sensitivity;
* solver residuals versus true discretisation error.

### Quantitative finance

* implied-volatility calibration and Heston parameter identifiability;
* the Feller boundary and variance-process simulation;
* yield-curve bootstrapping, interpolation, and instantaneous forwards;
* Vasicek (P)- and (Q)-measure parameters;
* Hull–White conventions and calibration to curve plus volatility instruments;
* utility, admissible controls, and constraints in the Merton problem;
* regime-switching generators and coupled PDEs;
* risk premia needed to connect historical forecasts with pricing parameters.

### Data science and model-risk controls

* point-in-time economic vintages;
* forecast-horizon matching;
* look-ahead and revision bias;
* uncertainty propagation from forecasts to prices/policies;
* calibration regularisation;
* parameter stability and identifiability;
* sensitivity analysis and scenario attribution;
* reproducibility and audit trails.

\---

## 13\. Recommended implementation decisions

1. Use **Rannacher-smoothed Crank–Nicolson** as the main 1D pricing scheme.
2. Use **backward Euler** as the robust reference and start-up method.
3. Include **explicit FTCS** only for education and stability demonstrations.
4. Use **projected SOR or policy iteration** for the first American option.
5. Use **MCS-ADI** as the first Heston production scheme and compare it with HV-ADI.
6. Use **monotone implicit/upwind discretisation plus Howard iteration** for HJB.
7. Separate **model**, **contract**, and **scheme** selectors.
8. Implement Black–Scholes first, then rates, then Heston, then HJB.
9. Add the economic prediction model only after every solver independently passes analytic/semi-analytic tests.
10. Treat economic forecasts as scenario inputs or (P)-measure control inputs unless a documented calibration maps them into (Q)-measure parameters.

\---

## 14\. Useful starting references

* K. J. in ’t Hout and S. Foulon, [ADI Finite Difference Schemes for Option Pricing in the Heston Model with Correlation](https://www.math.ualberta.ca/ijnam/Volume-7-2010/No-2-10/2010-02-06.pdf).
* G. Barles and P. E. Souganidis, [Convergence of Approximation Schemes for Fully Nonlinear Second Order Equations](https://benjaminmoll.com/wp-content/uploads/2021/04/barles-souganidis.pdf).
* Y. Lee and D. Lee, [Finite Difference Method for the Hull–White Partial Differential Equation](https://www.mdpi.com/2227-7390/8/10/1719).
* T. Haentjens and K. J. in ’t Hout, [ADI Finite Difference Schemes for the Heston–Hull–White PDE](https://arxiv.org/pdf/1111.4087).
* Society of Actuaries Research Institute, [Calibrating Interest Rate Models](https://www.soa.org/globalassets/assets/files/resources/research-report/2023/interest-rate-model-calibration-study.pdf).

\---

## 15\. Definition of project completion

The project is complete when:

* every model has an explicit equation, conditions, assumptions, and parameter schema;
* numerical results converge under grid refinement;
* each solver agrees with an independent benchmark within a declared tolerance;
* the dashboard reports errors and warnings rather than only a price;
* economic-model inputs have a documented (P)- or (Q)-measure interpretation;
* all runs are reproducible from a saved configuration; and
* the numerical engine can run without the dashboard.

