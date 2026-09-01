export type Scheme = "explicit-euler" | "backward-euler" | "crank-nicolson" | "rannacher-cn";

export interface Coefficients1D {
  diffusion: (x: number, tau: number) => number;
  drift: (x: number, tau: number) => number;
  discount: (x: number, tau: number) => number;
}

export interface DirichletBoundaries {
  left: (tau: number) => number;
  right: (tau: number) => number;
}

export interface TimeLayer {
  tau: number;
  values: number[];
}

export interface SolverDiagnostics {
  runtimeMs: number;
  spaceIntervals: number;
  timeSteps: number;
  minSpaceStep: number;
  maxSpaceStep: number;
  timeStep: number;
  domain: [number, number];
  finite: boolean;
  minimumValue: number;
  maximumValue: number;
  maxLinearResidual: number;
  operatorOffDiagonalsNonnegative: boolean;
  minimumImplicitDiagonalMargin: number;
  explicitMonotonicityWarning: string | null;
  rannacherHalfSteps: number;
}

export interface Solve1DRequest {
  nodes: readonly number[];
  maturity: number;
  timeSteps: number;
  coefficients: Coefficients1D;
  initialCondition: (x: number) => number;
  boundaries: DirichletBoundaries;
  scheme: Scheme;
  rannacherHalfSteps?: number;
  captureEvery?: number;
}

export interface Solve1DResult {
  nodes: number[];
  values: number[];
  layers: TimeLayer[];
  scheme: Scheme;
  diagnostics: SolverDiagnostics;
}
