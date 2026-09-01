"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MODEL_KEYS,
  MODEL_SPECS,
  defaultParameters,
  diagnosticWarnings,
  getActiveParameters,
  getContractSpec,
  toleranceLabel,
  validateParameterFields,
  type ModelKey,
  type OptionSide,
} from "@/app/lib/pde-spec";
import {
  buildEconomicBridge,
  DEFAULT_ECONOMIC_BRIDGE_INPUT,
} from "@/app/lib/economic-bridge";
import {
  blackScholesProductDomainExpansionDelta,
  runBlackScholesProductConvergence,
  solveBlackScholesProduct,
  type BarrierDirection,
  type BlackScholesContract,
  type BlackScholesProductSolveRequest,
  type GridKind,
  type HestonResult,
  type HestonScheme,
  type HestonSolveRequest,
  type MertonResult,
  type MertonScheme,
  type MertonSolveRequest,
  type Scheme,
  type ShortRateResult,
  type ShortRateSolveRequest,
} from "@/app/lib/pde-engine";
import type {
  DashboardConvergenceLevel,
  PricingResult,
  SolverJob,
  SolverWorkerMessage,
  SolverWorkerRequest,
} from "@/app/lib/solver-jobs";
import type {
  ParameterUncertaintyRequest,
  ParameterUncertaintyResult,
} from "@/app/lib/parameter-uncertainty";
import type {
  ParameterUncertaintyWorkerMessage,
  ParameterUncertaintyWorkerRequest,
} from "@/app/workers/parameter-uncertainty.worker";
import {
  MONTE_CARLO_CSV_COLUMNS,
  MONTE_CARLO_DISPLAY_PATH_LIMIT,
  MONTE_CARLO_QUANTILES,
  createMonteCarloCsvRows,
  createMonteCarloManifest,
  isMonteCarloResultTabAvailable,
  validateMonteCarloControls,
  type DashboardMonteCarloResult,
} from "@/app/lib/monte-carlo";
import { formatDollarAllocation, presentMertonPolicy } from "@/app/lib/merton-policy-presentation";
import {
  alignParametersToOptionQuote,
  assessOptionValuation,
  findMatchingOptionQuote,
  findRepresentativeOptionQuote,
  type OptionQuoteEvidence,
} from "@/app/lib/option-valuation-assessment";
import { evaluateNumericalAcceptance } from "@/app/lib/numerical-acceptance";
import { createDefaultCaseDefinition, validateCaseDefinition } from "@/app/lib/case-definition";
import { MonteCarloResults } from "@/app/components/monte-carlo-results";
import { ShortRateMonteCarloResults } from "@/app/components/short-rate-monte-carlo-results";
import { MertonPolicyMonteCarloResults } from "@/app/components/merton-policy-monte-carlo-results";
import { Math as Formula, economicFormulaTex } from "@/app/components/math";
import { ControlHelpLabel } from "@/app/components/control-help-label";
import { MarketDataWorkspace } from "@/app/components/market-data-workspace";
import { ParameterUncertaintyResults } from "@/app/components/parameter-uncertainty-results";
import { SolverStudioWorkspace } from "@/app/components/solver-studio-workspace";
import { ConditionWorkbench } from "@/app/components/condition-workbench";
import { DecideWorkspace, type DecideEvidenceSection, type DecideMetric } from "@/app/components/decide-workspace";
import type { DownloadArtifact } from "@/app/components/download-feedback";
import { ConvergenceLevelLabel, convergenceLevelKey } from "@/app/components/convergence-level";
import { CaseTimelineDrawer } from "@/app/components/case-timeline-drawer";
import {
  CaseDefinitionWorkspace,
  CaseNextActionBar,
  CaseWorkbenchChrome,
  type CaseStage,
} from "@/app/components/case-workbench";
import {
  ECONOMIC_FORECAST_FIXTURE,
  type CpiPdeScenarioHandoff,
  type EconomicForecastApiResponse,
} from "@/app/lib/economic-forecast";
import {
  acceptHestonCalibration,
  applySnapshot,
  createVasicekHistoricalScenario,
  defaultMarketRequest,
  getMarketAdapter,
  HULL_WHITE_SERIES,
  restoreSnapshotInputs,
  selectedChangedProposalIds,
  type AppWorkspace,
  type AppliedSnapshotHistory,
  type MarketDataRequest,
  type MarketSnapshot,
  type VasicekHistoricalScenario,
} from "@/app/lib/market-data";
import type { HestonCalibrationWorkerRequest, HestonCalibrationWorkerResponse } from "@/app/workers/heston-calibration.worker";
import {
  MARKET_CONTROL_HELP,
  SOLVER_CONTROL_HELP,
} from "@/app/lib/control-help";
import {
  completeCaseRun,
  approveCaseConditioning,
  branchCaseToMarketBase,
  branchCaseWithEconomicScenario,
  changeCaseContractRevision,
  createCase,
  createCaseInputFingerprint,
  checkModelSnapshotCompatibility,
  deriveCaseReadiness,
  finishCaseRun,
  findCompatibleModelDraft,
  getCaseModelCompatibilityIssues,
  queueCaseRun,
  restoreCaseRevision,
  switchCaseModelRevision,
  synchroniseCaseInputs,
  type Case,
  type CaseCore,
  type CaseEconomicScenario,
  type CaseInputs,
  type CaseMarketBase,
} from "@/app/lib/case-state";

type ViewMode = "3D surface" | "Heatmap";
type HestonSliceAxis = "Spot × time" | "Variance × time";
type NumericalScheme = Scheme | HestonScheme | MertonScheme;
type SurfaceView = { yaw: number; pitch: number; zoom: number; panX: number; panY: number };
type SurfaceDrag = { pointerId: number; x: number; y: number; action: "orbit" | "pan" };
type StoredRunPayload = { result: PricingResult; convergence: DashboardConvergenceLevel[]; domainExpansionDelta: number; monteCarlo: DashboardMonteCarloResult | null };
const DEFAULT_SURFACE_VIEW: SurfaceView = { yaw: -0.5, pitch: 0.55, zoom: 1, panX: 0, panY: 0 };
const isHestonResult = (result: PricingResult): result is HestonResult => "varianceNodes" in result.solution;
const isShortRateResult = (result: PricingResult): result is ShortRateResult => "shortRate" in result.parameters;
const isMertonResult = (result: PricingResult): result is MertonResult => "policies" in result.solution;
const CASE_BOOTSTRAP_TIMESTAMP = "2026-08-21T00:00:00.000Z";

function initialDashboardCaseInputs(model: ModelKey = "Black–Scholes", options: { sample?: boolean } = {}): CaseInputs {
  const request = defaultMarketRequest(model);
  const initialContract = MODEL_SPECS[model].contracts[0];
  const initialParameters = defaultParameters(model, initialContract.id);
  const contractSpec = getContractSpec(model, initialContract.id);
  const scheme = model === "Heston" ? "mcs-adi" : model === "HJB" ? "howard-implicit" : "rannacher-cn";
  return {
    definition: createDefaultCaseDefinition({
      model,
      instrument: request.instrument,
      valuationDate: request.asOfDate,
      caseName: `${request.instrument} · ${contractSpec.label}${options.sample ? " sample" : ""}`,
    }),
    marketBase: {
      model,
      source: "manual",
      snapshotId: null,
      applicationId: null,
      instrument: request.instrument,
      currency: request.currency,
      asOfDate: request.asOfDate,
      measure: MODEL_SPECS[model].measure,
      appliedAt: null,
      parameters: initialParameters,
    },
    economicScenario: null,
    conditionApproval: null,
    solverConfiguration: {
      model,
      contractId: initialContract.id,
      scheme,
      gridKind: "nonuniform",
      spaceSteps: model === "Heston" ? 80 : 200,
      varianceSteps: model === "Heston" ? 40 : null,
      timeSteps: model === "Heston" ? 160 : 200,
      parameters: initialParameters,
      monteCarlo: { enabled: false, paths: null, timeSteps: null, seed: null },
      validationIssues: [],
    },
  };
}

const SCHEME_LABELS: Record<NumericalScheme, string> = {
  "explicit-euler": "Explicit Euler / FTCS",
  "backward-euler": "Backward Euler",
  "crank-nicolson": "Crank–Nicolson",
  "rannacher-cn": "Rannacher–Crank–Nicolson",
  "mcs-adi": "Modified Craig–Sneyd ADI",
  "hv-adi": "Hundsdorfer–Verwer ADI",
  "howard-implicit": "Monotone implicit + Howard iteration",
};

const ONE_DIMENSIONAL_SCHEMES: Scheme[] = ["explicit-euler", "backward-euler", "crank-nicolson", "rannacher-cn"];
const HESTON_SCHEMES: HestonScheme[] = ["mcs-adi", "hv-adi"];
const MERTON_SCHEMES: MertonScheme[] = ["howard-implicit"];
const formatMoney = (value: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

const formatBridgeValue = (value: number | null) => value === null
  ? "Excluded"
  : Math.abs(value) < 0.01 ? value.toExponential(3) : value.toFixed(4);

const toleranceTex = (value: number) => String.raw`\lvert\Delta V\rvert_0\le ${value.toExponential(0)}`;

const formatSurfaceTick = (value: number, span: number) => {
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 10000) return value.toExponential(1);
  const decimals = span < 0.01 ? 4 : span < 0.1 ? 3 : span < 2 ? 2 : span < 20 ? 1 : 0;
  return value.toFixed(decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/u, "$1");
};

function useCanvasSize(canvasRef: React.RefObject<HTMLCanvasElement | null>, draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(ctx, rect.width, rect.height);
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef, draw]);
}

function SurfaceChart({ mode, model, seed, result }: { mode: ViewMode; model: ModelKey; seed: number; result?: PricingResult | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<SurfaceDrag | null>(null);
  const [surfaceView, setSurfaceView] = useState<SurfaceView>(DEFAULT_SURFACE_VIEW);
  const [dragging, setDragging] = useState(false);
  const draw = useMemo(
    () => (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      const isRate = model === "Vasicek" || model === "Hull–White";
      const isHeston = result ? "varianceNodes" in result.solution : false;
      const rows = 17;
      const cols = 30;
      const sampledValue = (x: number, y: number) => {
        if (!result) return null;
        if ("varianceNodes" in result.solution) {
          const varianceIndex = Math.round((y / (rows - 1)) * (result.solution.varianceNodes.length - 1));
          const spotIndex = Math.round((x / (cols - 1)) * (result.solution.spotNodes.length - 1));
          return result.solution.values[varianceIndex]?.[spotIndex] ?? 0;
        }
        const layerIndex = Math.round((y / (rows - 1)) * (result.solution.layers.length - 1));
        const nodeIndex = Math.round((x / (cols - 1)) * (result.solution.nodes.length - 1));
        return result.solution.layers[layerIndex]?.values[nodeIndex] ?? 0;
      };
      const resultValues = result
        ? "varianceNodes" in result.solution
          ? result.solution.values.flat()
          : result.solution.layers.flatMap((layer) => layer.values)
        : [0, 1];
      const resultMinimum = Math.min(...resultValues);
      const resultMaximum = Math.max(...resultValues);
      const resultRange = Math.max(1e-12, resultMaximum - resultMinimum);
      const normalise = (value: number) => (value - resultMinimum) / resultRange;

      if (mode === "Heatmap") {
        const pad = { l: 58, r: 26, t: 25, b: 40 };
        const cw = (width - pad.l - pad.r) / cols;
        const ch = (height - pad.t - pad.b) / rows;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const nx = x / (cols - 1);
            const ny = y / (rows - 1);
            const ridge = Math.max(0, nx - 0.46) * (1 - ny * 0.72);
            const pulse = Math.exp(-Math.pow(nx - 0.58, 2) * 26) * (0.16 + ny * 0.08);
            const computed = sampledValue(x, y);
            const z = computed === null ? Math.min(1, ridge * 1.7 + pulse + seed * 0.002) : Math.min(1, Math.max(0, normalise(computed)));
            const hue = 184 - z * 18;
            const light = 13 + z * 48;
            ctx.fillStyle = `hsl(${hue} 62% ${light}%)`;
            ctx.fillRect(pad.l + x * cw, pad.t + y * ch, cw + 0.6, ch + 0.6);
          }
        }
        ctx.strokeStyle = "rgba(142,163,187,.24)";
        ctx.lineWidth = 1;
        ctx.strokeRect(pad.l, pad.t, width - pad.l - pad.r, height - pad.t - pad.b);
        ctx.fillStyle = "#718098";
        ctx.font = "11px Geist Mono, monospace";
        ctx.fillText(model === "HJB" ? "WEALTH W" : isRate ? "RATE r" : "SPOT S", width / 2 - 24, height - 12);
        ctx.save();
        ctx.translate(16, height / 2 + 22);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(isHeston ? "VARIANCE v" : "TIME TO MATURITY τ", 0, 0);
        ctx.restore();
        return;
      }

      const centerX = width * 0.51 + surfaceView.panX;
      const centerY = height * 0.55 + surfaceView.panY;
      const scale = Math.min(width / 42, height / 26) * surfaceView.zoom;
      const cosYaw = Math.cos(surfaceView.yaw);
      const sinYaw = Math.sin(surfaceView.yaw);
      const cosPitch = Math.cos(surfaceView.pitch);
      const sinPitch = Math.sin(surfaceView.pitch);
      const point = (x: number, y: number, z: number) => {
        const worldX = x - (cols - 1) / 2;
        const worldY = y - (rows - 1) / 2;
        const worldZ = z * 0.95 - 3.5;
        const screenX = worldX * cosYaw - worldY * sinYaw;
        const forward = worldX * sinYaw + worldY * cosYaw;
        return {
          x: centerX + screenX * scale,
          y: centerY + (forward * sinPitch - worldZ * cosPitch) * scale,
          depth: forward * cosPitch + worldZ * sinPitch,
        };
      };
      const value = (x: number, y: number) => {
        const computed = sampledValue(x, y);
        if (computed !== null) return 12 * normalise(computed);
        const nx = x / (cols - 1);
        const ny = y / (rows - 1);
        const strike = isRate ? 0.42 : 0.49;
        const intrinsic = Math.max(0, nx - strike) * (15 + 5 * (1 - ny));
        const timeValue = Math.exp(-Math.pow(nx - strike, 2) * 20) * (1 - ny) * 2.5;
        return intrinsic + timeValue + seed * 0.01;
      };

      const divisions = width < 620 ? 4 : 5;
      const ticks = Array.from({ length: divisions + 1 }, (_, index) => index / divisions);
      const xAxisValues = result
        ? "varianceNodes" in result.solution ? result.solution.spotNodes : result.solution.nodes
        : ticks.map((fraction) => fraction);
      const yAxisValues = result
        ? "varianceNodes" in result.solution
          ? result.solution.varianceNodes
          : result.solution.layers.map((layer) => layer.tau)
        : ticks.map((fraction) => fraction);
      const syntheticValues = result ? [] : Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => value(x, y))).flat();
      const zMinimum = result ? resultMinimum : Math.min(...syntheticValues);
      const zMaximum = result ? resultMaximum : Math.max(...syntheticValues);
      const zSpan = Math.max(1e-12, zMaximum - zMinimum);
      const axisValueAt = (values: readonly number[], fraction: number) => values[Math.round(fraction * (values.length - 1))] ?? 0;
      const xSpan = Math.abs((xAxisValues.at(-1) ?? 1) - (xAxisValues[0] ?? 0));
      const ySpan = Math.abs((yAxisValues.at(-1) ?? 1) - (yAxisValues[0] ?? 0));
      const maxX = cols - 1;
      const maxY = rows - 1;
      const maxZ = 12;
      const midX = maxX / 2;
      const midY = maxY / 2;
      const midZ = maxZ / 2;
      const drawLine = (a: ReturnType<typeof point>, b: ReturnType<typeof point>, colour: string, lineWidth = 1) => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = colour;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      };

      const farY = point(midX, 0, midZ).depth > point(midX, maxY, midZ).depth ? 0 : maxY;
      const farX = point(0, midY, midZ).depth > point(maxX, midY, midZ).depth ? 0 : maxX;
      const nearY = farY === 0 ? maxY : 0;
      const nearX = farX === 0 ? maxX : 0;

      ctx.setLineDash([3, 4]);
      ticks.forEach((fraction) => {
        const x = fraction * maxX;
        const y = fraction * maxY;
        const z = fraction * maxZ;
        drawLine(point(x, 0, 0), point(x, maxY, 0), "rgba(126,148,173,.16)");
        drawLine(point(0, y, 0), point(maxX, y, 0), "rgba(126,148,173,.16)");
        drawLine(point(x, farY, 0), point(x, farY, maxZ), "rgba(126,148,173,.12)");
        drawLine(point(0, farY, z), point(maxX, farY, z), "rgba(126,148,173,.12)");
        drawLine(point(farX, y, 0), point(farX, y, maxZ), "rgba(126,148,173,.12)");
        drawLine(point(farX, 0, z), point(farX, maxY, z), "rgba(126,148,173,.12)");
      });
      ctx.setLineDash([]);

      const corners = {
        b00: point(0, 0, 0), b10: point(maxX, 0, 0), b11: point(maxX, maxY, 0), b01: point(0, maxY, 0),
        t00: point(0, 0, maxZ), t10: point(maxX, 0, maxZ), t11: point(maxX, maxY, maxZ), t01: point(0, maxY, maxZ),
      };
      const frameEdges = [
        [corners.b00, corners.b10], [corners.b10, corners.b11], [corners.b11, corners.b01], [corners.b01, corners.b00],
        [corners.t00, corners.t10], [corners.t10, corners.t11], [corners.t11, corners.t01], [corners.t01, corners.t00],
        [corners.b00, corners.t00], [corners.b10, corners.t10], [corners.b11, corners.t11], [corners.b01, corners.t01],
      ] as const;
      const centreDepth = point(midX, midY, midZ).depth;
      frameEdges
        .filter(([a, b]) => (a.depth + b.depth) / 2 >= centreDepth)
        .forEach(([a, b]) => drawLine(a, b, "rgba(126,148,173,.20)", 1));

      const surfaceCells: Array<{
        points: ReturnType<typeof point>[];
        average: number;
        depth: number;
      }> = [];
      for (let y = 0; y < rows - 1; y++) {
        for (let x = 0; x < cols - 1; x++) {
          const z1 = value(x, y);
          const z2 = value(x + 1, y);
          const z3 = value(x + 1, y + 1);
          const z4 = value(x, y + 1);
          const points = [point(x, y, z1), point(x + 1, y, z2), point(x + 1, y + 1, z3), point(x, y + 1, z4)];
          surfaceCells.push({
            points,
            average: (z1 + z2 + z3 + z4) / 4,
            depth: points.reduce((sum, projected) => sum + projected.depth, 0) / points.length,
          });
        }
      }
      surfaceCells.sort((a, b) => b.depth - a.depth).forEach((cell) => {
        ctx.beginPath();
        ctx.moveTo(cell.points[0].x, cell.points[0].y);
        cell.points.slice(1).forEach((projected) => ctx.lineTo(projected.x, projected.y));
        ctx.closePath();
        ctx.fillStyle = `hsla(${186 - cell.average * 1.5}, ${50 + cell.average * 1.4}%, ${15 + cell.average * 2.8}%, .92)`;
        ctx.fill();
        ctx.strokeStyle = "rgba(99, 224, 211, .12)";
        ctx.lineWidth = 0.7;
        ctx.stroke();
      });

      frameEdges
        .filter(([a, b]) => (a.depth + b.depth) / 2 < centreDepth)
        .forEach(([a, b]) => drawLine(a, b, "rgba(142,163,187,.45)", 1.15));

      const plotCentre = point(midX, midY, midZ);
      const labelBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      const outwardFromCentre = (projected: ReturnType<typeof point>) => {
        const deltaX = projected.x - plotCentre.x;
        const deltaY = projected.y - plotCentre.y;
        const length = Math.hypot(deltaX, deltaY) || 1;
        return { x: deltaX / length, y: deltaY / length };
      };
      const placeLabel = (text: string, projected: ReturnType<typeof point>, outward: { x: number; y: number }, distance: number, title = false) => {
        ctx.font = `${title ? 10 : 9}px Geist Mono, monospace`;
        const textWidth = ctx.measureText(text).width;
        for (const extra of [0, 9, 18]) {
          const rawX = projected.x + outward.x * (distance + extra);
          const rawY = projected.y + outward.y * (distance + extra);
          const x = Math.max(textWidth / 2 + 5, Math.min(width - textWidth / 2 - 5, rawX));
          const y = Math.max(8, Math.min(height - 8, rawY));
          const box = { left: x - textWidth / 2 - 3, right: x + textWidth / 2 + 3, top: y - 7, bottom: y + 7 };
          const overlaps = labelBoxes.some((placed) => !(box.right < placed.left || box.left > placed.right || box.bottom < placed.top || box.top > placed.bottom));
          if (overlaps) continue;
          if (title) {
            ctx.fillStyle = "rgba(7,12,18,.82)";
            ctx.fillRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
          }
          ctx.fillStyle = title ? "#91a2b8" : "#74839a";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(text, x, y);
          labelBoxes.push(box);
          return;
        }
      };
      const drawAxisTicks = (
        positions: ReturnType<typeof point>[],
        labels: string[],
        title: string,
      ) => {
        positions.forEach((projected, index) => {
          const outward = outwardFromCentre(projected);
          const tickEnd = { ...projected, x: projected.x + outward.x * 5, y: projected.y + outward.y * 5 };
          drawLine(projected, tickEnd, "rgba(142,163,187,.62)", 1);
          placeLabel(labels[index], projected, outward, 13);
        });
        const midpoint = positions[Math.floor(positions.length / 2)];
        placeLabel(title, midpoint, outwardFromCentre(midpoint), 31, true);
      };

      const xPositions = ticks.map((fraction) => point(fraction * maxX, nearY, 0));
      const yPositions = ticks.map((fraction) => point(nearX, fraction * maxY, 0));
      const zPositions = ticks.map((fraction) => point(nearX, nearY, fraction * maxZ));
      drawAxisTicks(
        xPositions,
        ticks.map((fraction) => formatSurfaceTick(axisValueAt(xAxisValues, fraction), xSpan)),
        model === "HJB" ? "WEALTH W" : isRate ? "SHORT RATE r" : "SPOT S",
      );
      drawAxisTicks(
        yPositions,
        ticks.map((fraction) => formatSurfaceTick(axisValueAt(yAxisValues, fraction), ySpan)),
        isHeston ? "VARIANCE v" : "TIME τ",
      );
      drawAxisTicks(
        zPositions,
        ticks.map((fraction) => formatSurfaceTick(zMinimum + fraction * zSpan, zSpan)),
        model === "HJB" ? "VALUE J" : "VALUE V",
      );
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    },
    [mode, model, seed, result, surfaceView],
  );
  useCanvasSize(ref, draw);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || mode !== "3D surface") return;
    const zoomSurface = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const zoomFactor = Math.exp(-event.deltaY * 0.0012);
      setSurfaceView((current) => ({ ...current, zoom: Math.max(0.45, Math.min(2.8, current.zoom * zoomFactor)) }));
    };
    canvas.addEventListener("wheel", zoomSurface, { passive: false });
    return () => canvas.removeEventListener("wheel", zoomSurface);
  }, [mode]);
  const beginDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "3D surface") return;
    event.preventDefault();
    const action = event.button === 2 || event.button === 1 ? "pan" : "orbit";
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, action };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setSurfaceView((current) => drag.action === "pan"
      ? { ...current, panX: current.panX + deltaX, panY: current.panY + deltaY }
      : {
          ...current,
          yaw: current.yaw + deltaX * 0.009,
          pitch: Math.max(-1.45, Math.min(1.45, current.pitch - deltaY * 0.009)),
        });
  };
  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <canvas
      ref={ref}
      className={`chart-canvas${mode === "3D surface" ? ` interactive${dragging ? " dragging" : ""}` : ""}`}
      aria-label={`${mode} of the current ${model} solution${mode === "3D surface" ? ". Drag to orbit, scroll to zoom, and right-drag to pan." : ""}`}
      title={mode === "3D surface" ? "Drag to orbit · Scroll to zoom · Right-drag to pan · Double-click to reset" : undefined}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(event) => { if (mode === "3D surface") event.preventDefault(); }}
      onDoubleClick={() => { if (mode === "3D surface") setSurfaceView(DEFAULT_SURFACE_VIEW); }}
    />
  );
}

function LineChart({ price, seed, result }: { price: number; seed: number; result?: PricingResult | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(
    () => (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      const p = { l: 48, r: 18, t: 22, b: 36 };
      const w = width - p.l - p.r;
      const h = height - p.t - p.b;
      const isRate = result ? isShortRateResult(result) : false;
      const isMerton = result ? isMertonResult(result) : false;
      const resultNodes: number[] = result ? isHestonResult(result) ? result.solution.spotNodes : result.solution.nodes : [];
      const resultValues: number[] = result ? isHestonResult(result) ? result.spotSliceValues : result.solution.values : [];
      const analyticValues: number[] = result?.analyticValues ?? [];
      const xMinimum = result && (isShortRateResult(result) || isMertonResult(result)) ? result.solution.nodes[0] : 0;
      const xMaximum = result
        ? isHestonResult(result)
          ? Math.min(result.solution.spotNodes.at(-1) ?? 200, 2 * Math.max(result.parameters.spot, result.parameters.strike))
          : isShortRateResult(result)
            ? result.solution.nodes.at(-1)!
            : isMertonResult(result)
              ? Math.min(result.solution.nodes.at(-1)!, 2 * result.parameters.wealth)
            : Math.min(result.solution.nodes.at(-1) ?? 200, 2 * Math.max(result.parameters.spot, result.parameters.strike))
        : 135;
      const visibleIndices = result
        ? resultNodes.map((_, index) => index).filter((index) => resultNodes[index] <= xMaximum)
        : [];
      const yMaximum = result
        ? Math.max(1, ...visibleIndices.flatMap((index) => [resultValues[index], analyticValues[index]])) * 1.08
        : 30;
      ctx.font = "10px Geist Mono, monospace";
      for (let i = 0; i <= 4; i++) {
        const y = p.t + (h * i) / 4;
        ctx.strokeStyle = "rgba(118,139,163,.16)";
        ctx.beginPath();
        ctx.moveTo(p.l, y);
        ctx.lineTo(width - p.r, y);
        ctx.stroke();
        ctx.fillStyle = "#68778e";
        ctx.fillText(`${(yMaximum * (1 - i / 4)).toFixed(1)}`, 10, y + 3);
      }
      const series = (analytic: boolean) => {
        ctx.beginPath();
        const points = result
          ? visibleIndices.map((index) => ({ xValue: resultNodes[index], value: analytic ? analyticValues[index] : resultValues[index] }))
          : Array.from({ length: 101 }, (_, i) => {
              const xValue = i * 1.35;
              const payoff = Math.max(0, xValue - 100);
              const value = payoff * 0.78 + Math.exp(-Math.pow((xValue - 99) / 31, 2)) * (price + (analytic ? 0.18 : 0)) + seed * 0.004;
              return { xValue, value };
            });
        points.forEach((point, i) => {
          const x = p.l + ((point.xValue - xMinimum) / (xMaximum - xMinimum)) * w;
          const y = p.t + h - Math.min(yMaximum, point.value) / yMaximum * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = analytic ? "#f6b94f" : "#53d4c8";
        ctx.lineWidth = analytic ? 1.4 : 2.4;
        if (analytic) ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      series(false);
      series(true);
      const spot = result ? isShortRateResult(result) ? result.parameters.shortRate : isMertonResult(result) ? result.parameters.wealth : result.parameters.spot : 100;
      const spotX = p.l + ((spot - xMinimum) / (xMaximum - xMinimum)) * w;
      ctx.strokeStyle = "#f06671";
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(spotX, p.t);
      ctx.lineTo(spotX, p.t + h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f27d86";
      ctx.fillText(`${isRate ? "r₀" : isMerton ? "W₀" : "S₀"} = ${spot.toFixed(isRate ? 3 : 0)}`, spotX - 22, 13);
      ctx.fillStyle = "#6f7f95";
      ctx.fillText(isRate ? "SHORT RATE r" : isMerton ? "WEALTH W" : "SPOT S", width / 2 - 18, height - 7);
    },
    [price, seed, result],
  );
  useCanvasSize(ref, draw);
  return <canvas ref={ref} className="chart-canvas small" aria-label="Value at time zero compared with analytic payoff" />;
}

function HestonTimeSliceChart({ result, axis }: { result: HestonResult; axis: HestonSliceAxis }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(
    () => (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      const pad = { l: 48, r: 18, t: 20, b: 36 };
      const chartWidth = width - pad.l - pad.r;
      const chartHeight = height - pad.t - pad.b;
      const spotAxis = axis === "Spot × time";
      const nodes = spotAxis ? result.solution.spotNodes : result.solution.varianceNodes;
      const layers = result.solution.layers;
      const selectedLayers = layers.filter((_, index) => index === 0 || index === layers.length - 1 || index % Math.max(1, Math.floor((layers.length - 1) / 4)) === 0);
      const valuesForLayer = (layer: HestonResult["solution"]["layers"][number]) => {
        if (spotAxis) {
          const lower = result.interpolation.varianceLowerIndex;
          const upper = result.interpolation.varianceUpperIndex;
          return nodes.map((_, spotIndex) => result.interpolation.varianceLowerWeight * layer.values[lower][spotIndex]
            + result.interpolation.varianceUpperWeight * layer.values[upper][spotIndex]);
        }
        const lower = result.interpolation.spotLowerIndex;
        const upper = result.interpolation.spotUpperIndex;
        return nodes.map((_, varianceIndex) => result.interpolation.spotLowerWeight * layer.values[varianceIndex][lower]
          + result.interpolation.spotUpperWeight * layer.values[varianceIndex][upper]);
      };
      const layerSeries = selectedLayers.map((layer) => ({ tau: layer.tau, values: valuesForLayer(layer) }));
      const maximum = Math.max(1e-12, ...layerSeries.flatMap((series) => series.values)) * 1.08;
      ctx.font = "10px Geist Mono, monospace";
      for (let index = 0; index <= 4; index += 1) {
        const y = pad.t + chartHeight * index / 4;
        ctx.strokeStyle = "rgba(118,139,163,.16)";
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(width - pad.r, y);
        ctx.stroke();
        ctx.fillStyle = "#68778e";
        ctx.fillText((maximum * (1 - index / 4)).toFixed(1), 8, y + 3);
      }
      layerSeries.forEach((series, seriesIndex) => {
        ctx.beginPath();
        series.values.forEach((value, index) => {
          const x = pad.l + index / (nodes.length - 1) * chartWidth;
          const y = pad.t + chartHeight - Math.max(0, value) / maximum * chartHeight;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        const progress = seriesIndex / Math.max(1, layerSeries.length - 1);
        ctx.strokeStyle = `hsla(${205 - progress * 25}, ${35 + progress * 35}%, ${42 + progress * 22}%, ${0.35 + progress * 0.65})`;
        ctx.lineWidth = seriesIndex === layerSeries.length - 1 ? 2.4 : 1.1;
        ctx.stroke();
      });
      ctx.fillStyle = "#6f7f95";
      ctx.fillText(spotAxis ? "SPOT S · fixed v₀" : "VARIANCE v · fixed S₀", width / 2 - 60, height - 8);
      ctx.fillStyle = "#53d4c8";
      ctx.fillText(`t=0 · ${layerSeries.length} time layers`, width - 154, 13);
    },
    [axis, result],
  );
  useCanvasSize(ref, draw);
  return <canvas ref={ref} className="chart-canvas small" aria-label={`Heston ${axis} value slices`} />;
}

function MertonPolicyChart({ result }: { result: MertonResult }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(
    () => (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      const pad = { l: 52, r: 18, t: 22, b: 38 };
      const chartWidth = width - pad.l - pad.r;
      const chartHeight = height - pad.t - pad.b;
      const nodes = result.solution.nodes;
      const analytic = nodes.map((wealth) => (result.parameters.expectedReturn - result.parameters.rate) * wealth
        / (result.parameters.riskAversion * result.parameters.volatility ** 2));
      const minimum = Math.min(result.parameters.controlMin, ...result.solution.policies, ...analytic);
      const maximum = Math.max(result.parameters.controlMax, ...result.solution.policies, ...analytic);
      const range = Math.max(1e-12, maximum - minimum);
      const x = (index: number) => pad.l + index / (nodes.length - 1) * chartWidth;
      const y = (value: number) => pad.t + (maximum - value) / range * chartHeight;
      ctx.font = "10px Geist Mono, monospace";
      for (let index = 0; index <= 4; index += 1) {
        const value = maximum - range * index / 4;
        const lineY = y(value);
        ctx.strokeStyle = "rgba(118,139,163,.16)";
        ctx.beginPath();
        ctx.moveTo(pad.l, lineY);
        ctx.lineTo(width - pad.r, lineY);
        ctx.stroke();
        ctx.fillStyle = "#68778e";
        ctx.fillText(value.toFixed(0), 8, lineY + 3);
      }
      const series = (values: readonly number[], colour: string, dashed: boolean) => {
        ctx.beginPath();
        values.forEach((value, index) => index === 0 ? ctx.moveTo(x(index), y(value)) : ctx.lineTo(x(index), y(value)));
        ctx.strokeStyle = colour;
        ctx.lineWidth = dashed ? 1.4 : 2.4;
        ctx.setLineDash(dashed ? [5, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      series(analytic, "#f6b94f", true);
      series(result.solution.policies, "#53d4c8", false);
      const wealthIndex = nodes.reduce((best, node, index) => Math.abs(node - result.parameters.wealth) < Math.abs(nodes[best] - result.parameters.wealth) ? index : best, 0);
      ctx.strokeStyle = "#f06671";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x(wealthIndex), pad.t);
      ctx.lineTo(x(wealthIndex), pad.t + chartHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#6f7f95";
      ctx.fillText("WEALTH W", width / 2 - 24, height - 8);
      ctx.fillStyle = "#53d4c8";
      ctx.fillText("HOWARD POLICY", width - 110, 13);
    },
    [result],
  );
  useCanvasSize(ref, draw);
  return <canvas ref={ref} className="chart-canvas small" aria-label="Merton optimal dollar-control policy and unconstrained benchmark" />;
}

function ComparisonChart({ pde, benchmark }: { pde: number; benchmark: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = useMemo(
    () => (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      ctx.clearRect(0, 0, width, height);
      const vals = [pde, benchmark];
      const colors = ["#50cec3", "#f6b93b"];
      const labels = ["PDE", "ANALYTIC"];
      const max = Math.max(1e-14, ...vals.map(Math.abs)) * 1.18;
      const top = 26;
      const bottom = height - 34;
      const chartH = bottom - top;
      ctx.font = "10px Geist Mono, monospace";
      for (let i = 0; i <= 4; i++) {
        const y = top + (chartH * i) / 4;
        ctx.strokeStyle = "rgba(118,139,163,.16)";
        ctx.beginPath();
        ctx.moveTo(38, y);
        ctx.lineTo(width - 12, y);
        ctx.stroke();
      }
      vals.forEach((val, i) => {
        const slot = (width - 58) / 2;
        const bw = Math.min(68, slot * 0.54);
        const x = 42 + slot * i + (slot - bw) / 2;
        const bh = (Math.abs(val) / max) * chartH;
        const grad = ctx.createLinearGradient(0, bottom - bh, 0, bottom);
        grad.addColorStop(0, colors[i]);
        grad.addColorStop(1, `${colors[i]}99`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, bottom - bh, bw, bh, 5);
        ctx.fill();
        ctx.fillStyle = "#c8d1dd";
        ctx.textAlign = "center";
        ctx.fillText(val.toFixed(4), x + bw / 2, bottom - bh - 8);
        ctx.fillStyle = "#74839a";
        ctx.fillText(labels[i], x + bw / 2, height - 12);
      });
      ctx.textAlign = "left";
    },
    [pde, benchmark],
  );
  useCanvasSize(ref, draw);
  return <canvas ref={ref} className="chart-canvas small" aria-label="PDE and analytic benchmark comparison" />;
}

export default function Home() {
  const [activeWorkspace, setActiveWorkspace] = useState<AppWorkspace>("results");
  const [activeStage, setActiveStage] = useState<CaseStage>("define");
  const [conditionWorkspace, setConditionWorkspace] = useState<"market-data" | "economic-forecast">("market-data");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineMarketBaseOverride, setTimelineMarketBaseOverride] = useState<CaseMarketBase | null>(null);
  const [timelineScenarioOverride, setTimelineScenarioOverride] = useState<CaseEconomicScenario | null>(null);
  const [model, setModel] = useState<ModelKey>("Black–Scholes");
  const [caseName, setCaseName] = useState("AAPL · European sample");
  const [definitionInstrument, setDefinitionInstrument] = useState("AAPL");
  const [definitionValuationDate, setDefinitionValuationDate] = useState("2026-08-21");
  const [definitionObjective, setDefinitionObjective] = useState(MODEL_SPECS["Black–Scholes"].contracts[0].summary);
  const [definitionConfirmedAt, setDefinitionConfirmedAt] = useState<string | null>(null);
  const [definitionConsequence, setDefinitionConsequence] = useState("Bundled defaults are ready to review. Save the definition to begin your own workflow.");
  const [contract, setContract] = useState("european");
  const [side, setSide] = useState<OptionSide | null>("Call");
  const [barrierType, setBarrierType] = useState("Up & out");
  const [parameters, setParameters] = useState<Record<string, string>>(() => defaultParameters("Black–Scholes", "european"));
  const [spaceSteps, setSpaceSteps] = useState("200");
  const [varianceSteps, setVarianceSteps] = useState("40");
  const [timeSteps, setTimeSteps] = useState("200");
  const [scheme, setScheme] = useState<NumericalScheme>("rannacher-cn");
  const [gridKind, setGridKind] = useState<GridKind>("nonuniform");
  const [viewMode, setViewMode] = useState<ViewMode>("3D surface");
  const [hestonSliceAxis, setHestonSliceAxis] = useState<HestonSliceAxis>("Spot × time");
  const [mainTab, setMainTab] = useState("Overview");
  const [controlsOpen, setControlsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(100);
  const [workerStage, setWorkerStage] = useState("Background solver ready");
  const [lastExecution, setLastExecution] = useState<"fixture" | "worker" | "cache">("fixture");
  const [workerGeneration, setWorkerGeneration] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const activeJobIdRef = useRef(0);
  const activeRunDefinitionRef = useRef({ model: "Black–Scholes" as ModelKey, contractId: "european" });
  const parameterUncertaintyWorkerRef = useRef<Worker | null>(null);
  const parameterUncertaintyJobIdRef = useRef(0);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [monteCarloResult, setMonteCarloResult] = useState<DashboardMonteCarloResult | null>(null);
  const [monteCarloEnabled, setMonteCarloEnabled] = useState(false);
  const [monteCarloPaths, setMonteCarloPaths] = useState("10000");
  const [monteCarloTimeSteps, setMonteCarloTimeSteps] = useState("252");
  const [monteCarloSeed, setMonteCarloSeed] = useState("20250308");
  const [seed, setSeed] = useState(0);
  const [lastRun, setLastRun] = useState("Bundled sample result");
  const [solverError, setSolverError] = useState<string | null>(null);
  const [bridgeScenarioId, setBridgeScenarioId] = useState("baseline");
  const [appliedBridgeScenarioId, setAppliedBridgeScenarioId] = useState<string | null>(null);
  const [bridgeCalibrationBase, setBridgeCalibrationBase] = useState<Record<string, string | number> | null>(null);
  const [marketRequest, setMarketRequest] = useState<MarketDataRequest>(() => defaultMarketRequest("Black–Scholes"));
  const [marketSnapshots, setMarketSnapshots] = useState<Partial<Record<ModelKey, MarketSnapshot>>>({});
  const [selectedMarketProposalIds, setSelectedMarketProposalIds] = useState<Set<string>>(new Set());
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [economicForecast, setEconomicForecast] = useState(ECONOMIC_FORECAST_FIXTURE);
  const [, setEconomicForecastLoading] = useState(true);
  const [, setEconomicForecastError] = useState<string | null>(null);
  const [, setEconomicForecastWarning] = useState<string | null>(null);
  const [, setEconomicForecastSource] = useState("bundled-fallback");
  const [, setEconomicForecastRefreshEnabled] = useState(false);
  const [appliedCpiScenario, setAppliedCpiScenario] = useState<CpiPdeScenarioHandoff | null>(null);
  const [appliedEconomicScenarioAt, setAppliedEconomicScenarioAt] = useState<string | null>(null);
  const [parameterUncertaintyResult, setParameterUncertaintyResult] = useState<ParameterUncertaintyResult | null>(null);
  const [parameterUncertaintyRunning, setParameterUncertaintyRunning] = useState(false);
  const [parameterUncertaintyProgress, setParameterUncertaintyProgress] = useState(0);
  const [parameterUncertaintyStage, setParameterUncertaintyStage] = useState("Ready for reviewed propagation");
  const [parameterUncertaintyError, setParameterUncertaintyError] = useState<string | null>(null);
  const [parameterUncertaintyBudget, setParameterUncertaintyBudget] = useState("64");
  const [parameterUncertaintyCacheHit, setParameterUncertaintyCacheHit] = useState(false);
  const [hestonCalibrating, setHestonCalibrating] = useState(false);
  const [hestonCalibrationStatus, setHestonCalibrationStatus] = useState("Prepared surface has not been calibrated");
  const hestonCalibrationWorkerRef = useRef<Worker | null>(null);
  const hestonCalibrationJobIdRef = useRef(0);
  const [marketHistory, setMarketHistory] = useState<AppliedSnapshotHistory[]>([]);
  const [vasicekHistoricalScenarios, setVasicekHistoricalScenarios] = useState<VasicekHistoricalScenario[]>([]);
  const [vasicekScenarioStatus, setVasicekScenarioStatus] = useState("P estimate has not been saved as a scenario");
  const [activeMarketSnapshotId, setActiveMarketSnapshotId] = useState<string | null>(null);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 720px)");
    const frame = window.requestAnimationFrame(() => {
      if (mobile.matches) setViewMode("Heatmap");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const closeParameterControls = () => {
    setControlsOpen(false);
    setSidebarCollapsed(true);
  };

  const openWorkspace = (workspace: AppWorkspace) => {
    setActiveWorkspace(workspace);
    if (workspace === "market-data" || workspace === "economic-forecast") {
      setConditionWorkspace(workspace);
      setActiveStage("condition");
    } else if (workspace === "solver-studio") {
      closeParameterControls();
      setActiveStage("solve");
    } else {
      closeParameterControls();
      setActiveWorkspace("results");
      setActiveStage("decide");
    }
  };

  const selectCaseStage = (stage: CaseStage) => {
    closeParameterControls();
    setActiveStage(stage);
    if (stage === "condition") setActiveWorkspace(conditionWorkspace);
    if (stage === "solve") setActiveWorkspace("solver-studio");
    if (stage === "decide") setActiveWorkspace("results");
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/economic-forecast", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("Economic forecast API unavailable.");
        const payload = await response.json() as EconomicForecastApiResponse;
        if (!active) return;
        setEconomicForecast(payload.snapshot);
        setEconomicForecastSource(payload.source);
        setEconomicForecastWarning(payload.warning);
        setEconomicForecastRefreshEnabled(payload.refresh.enabled);
      } catch (error) {
        if (active) {
          setEconomicForecastError(error instanceof Error ? error.message : "Economic forecast API unavailable.");
          setEconomicForecastWarning("Bundled last-known-good snapshot retained.");
        }
      } finally {
        if (active) setEconomicForecastLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);
  const [solverResult, setSolverResult] = useState<PricingResult | null>(() => {
    const initial = solveBlackScholesProduct({
      spot: 100,
      strike: 100,
      maturity: 1,
      rate: 0.05,
      dividend: 0,
      volatility: 0.2,
      side: "Call",
      contract: "european",
      spaceSteps: 200,
      timeSteps: 200,
      scheme: "rannacher-cn",
      gridKind: "nonuniform",
    });
    // The initial server and client render must be byte-for-byte deterministic.
    initial.solution.diagnostics.runtimeMs = 0;
    initial.solution.diagnostics.maxLinearResidual = 0;
    return initial;
  });
  const [caseRecord, setCaseRecord] = useState<Case>(() => {
    const created = createCase(initialDashboardCaseInputs("Black–Scholes", { sample: true }), {
      id: "case-current",
      now: CASE_BOOTSTRAP_TIMESTAMP,
    });
    const queued = queueCaseRun(created, {
      id: "fixture-initial",
      now: CASE_BOOTSTRAP_TIMESTAMP,
      execution: "fixture",
      origin: "sample",
    });
    return completeCaseRun(queued, "fixture-initial", {
      now: CASE_BOOTSTRAP_TIMESTAMP,
      execution: "fixture",
      summary: {
        primaryValue: solverResult?.price ?? null,
        benchmarkValue: solverResult?.analyticPrice ?? null,
        accepted: solverResult ? solverResult.solution.diagnostics.finite : null,
        warningCount: 0,
      },
    });
  });
  const [convergence, setConvergence] = useState<DashboardConvergenceLevel[]>(() => runBlackScholesProductConvergence({
    spot: 100,
    strike: 100,
    maturity: 1,
    rate: 0.05,
    dividend: 0,
    volatility: 0.2,
    side: "Call",
    contract: "european",
    scheme: "rannacher-cn",
    gridKind: "nonuniform",
  }));
  const [domainExpansionDelta, setDomainExpansionDelta] = useState(() => blackScholesProductDomainExpansionDelta({
    spot: 100,
    strike: 100,
    maturity: 1,
    rate: 0.05,
    dividend: 0,
    volatility: 0.2,
    side: "Call",
    contract: "european",
    spaceSteps: 200,
    timeSteps: 200,
    scheme: "rannacher-cn",
    gridKind: "nonuniform",
  }));
  const completedRunPayloadsRef = useRef<Record<string, StoredRunPayload>>({});

  useEffect(() => {
    if (!solverResult || completedRunPayloadsRef.current["fixture-initial"]) return;
    completedRunPayloadsRef.current["fixture-initial"] = {
      result: solverResult,
      convergence,
      domainExpansionDelta,
      monteCarlo: monteCarloResult,
    };
  }, [convergence, domainExpansionDelta, monteCarloResult, solverResult]);

  useEffect(() => {
    const solverWorker = new Worker(new URL("./workers/solver.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = solverWorker;

    solverWorker.onmessage = (event: MessageEvent<SolverWorkerMessage>) => {
      const message = event.data;
      if (message.jobId !== activeJobIdRef.current) return;
      if (message.type === "progress") {
        setProgress(message.progress);
        setWorkerStage(message.stage);
        return;
      }
      if (message.type === "error") {
        setCaseRecord((current) => finishCaseRun(current, `solver-job-${message.jobId}`, "failed", { error: message.message }));
        setSolverError(message.message);
        setWorkerStage("Background job failed");
        setProgress(100);
        setRunning(false);
        return;
      }
      if (message.type === "cancelled") {
        setCaseRecord((current) => finishCaseRun(current, `solver-job-${message.jobId}`, "cancelled", {}));
        setWorkerStage("Background job cancelled");
        setLastRun("Run cancelled — previous completed result retained");
        setProgress(100);
        setRunning(false);
        return;
      }

      setSolverResult(message.payload.result);
      completedRunPayloadsRef.current[`solver-job-${message.jobId}`] = {
        result: message.payload.result,
        convergence: message.payload.convergence,
        domainExpansionDelta: message.payload.domainExpansionDelta,
        monteCarlo: message.payload.monteCarlo ?? null,
      };
      const runDefinition = activeRunDefinitionRef.current;
      const runTolerance = getContractSpec(runDefinition.model, runDefinition.contractId).tolerance;
      const acceptance = evaluateNumericalAcceptance({
        result: message.payload.result,
        convergence: message.payload.convergence,
        tolerance: runTolerance,
      });
      setCaseRecord((current) => completeCaseRun(current, `solver-job-${message.jobId}`, {
        execution: message.cacheHit ? "cache" : "worker",
        summary: {
          primaryValue: message.payload.result.price,
          benchmarkValue: message.payload.result.analyticPrice,
          accepted: acceptance.accepted,
          warningCount: acceptance.issues.length,
          acceptanceIssues: acceptance.issues,
        },
      }));
      setMonteCarloResult(message.payload.monteCarlo ?? null);
      setConvergence(message.payload.convergence);
      setDomainExpansionDelta(message.payload.domainExpansionDelta);
      setLastExecution(message.cacheHit ? "cache" : "worker");
      setSeed((current) => current + 1);
      setLastRun(message.cacheHit ? "Identical run restored from cache" : `Background job completed in ${Math.round(message.elapsedMs)} ms`);
      setWorkerStage(message.cacheHit ? "Cache hit restored with its acceptance outcome" : "Background validation complete");
      setProgress(100);
      setRunning(false);
    };

    solverWorker.onerror = () => {
      setSolverError("The background solver could not start. Reload the dashboard and try again.");
      setWorkerStage("Background worker unavailable");
      setRunning(false);
    };

    return () => {
      solverWorker.terminate();
      if (workerRef.current === solverWorker) workerRef.current = null;
    };
  }, [workerGeneration]);

  useEffect(() => {
    const worker = new Worker(new URL("./workers/parameter-uncertainty.worker.ts", import.meta.url), { type: "module" });
    parameterUncertaintyWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<ParameterUncertaintyWorkerMessage>) => {
      const message = event.data;
      if (message.jobId !== parameterUncertaintyJobIdRef.current) return;
      if (message.type === "progress") {
        setParameterUncertaintyProgress(message.progress);
        setParameterUncertaintyStage(message.stage);
      } else if (message.type === "complete") {
        setParameterUncertaintyResult(message.result);
        setParameterUncertaintyCacheHit(message.cacheHit);
        setParameterUncertaintyProgress(100);
        setParameterUncertaintyStage(message.cacheHit ? "Identical propagation restored from cache" : "Propagation and stability checks complete");
        setParameterUncertaintyRunning(false);
      } else if (message.type === "cancelled") {
        setParameterUncertaintyStage("Propagation cancelled; previous result retained");
        setParameterUncertaintyRunning(false);
      } else {
        setParameterUncertaintyError(message.message);
        setParameterUncertaintyStage("Propagation failed; previous result retained");
        setParameterUncertaintyRunning(false);
      }
    };
    worker.onerror = () => {
      setParameterUncertaintyError("The parameter-propagation worker could not start.");
      setParameterUncertaintyRunning(false);
    };
    return () => {
      worker.terminate();
      if (parameterUncertaintyWorkerRef.current === worker) parameterUncertaintyWorkerRef.current = null;
    };
  }, []);

  useEffect(() => () => hestonCalibrationWorkerRef.current?.terminate(), []);

  useEffect(() => {
    const firstFrame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!controlsOpen || !window.matchMedia("(max-width: 800px)").matches) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => sidebarCloseRef.current?.focus());
    const handleDrawerKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector(".info-popover")) return;
        event.preventDefault();
        setControlsOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(sidebarRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDrawerKeyboard);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleDrawerKeyboard);
      previousFocusRef.current?.focus();
    };
  }, [controlsOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 801px)");
    const closeDrawerAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setControlsOpen(false);
    };
    desktop.addEventListener("change", closeDrawerAtDesktop);
    return () => desktop.removeEventListener("change", closeDrawerAtDesktop);
  }, []);

  const config = MODEL_SPECS[model];
  const contractSpec = getContractSpec(model, contract);
  const activeParameters = getActiveParameters(model, contract);
  const candidateMarketSnapshot = marketSnapshots[model] ?? null;
  const currentMarketSnapshot = candidateMarketSnapshot?.model === model ? candidateMarketSnapshot : null;
  const lastAppliedMarketSnapshot = marketHistory.find((item) => item.snapshot.model === model
    && item.snapshot.measure === config.measure
    && !item.restoredAt) ?? null;
  const activeMarketApplication = activeMarketSnapshotId
    ? marketHistory.find((item) => item.snapshot.id === activeMarketSnapshotId
      && item.snapshot.model === model
      && item.snapshot.measure === config.measure
      && !item.restoredAt) ?? null
    : null;
  const parameterValidationIssues = validateParameterFields(model, contract, parameters, {
    barrierType: contract === "barrier" ? barrierType as "Up & out" | "Down & out" : undefined,
  });
  const validationIssues = [...new Set(parameterValidationIssues.map((issue) => issue.message))];
  const minimumSpaceSteps = model === "Heston" ? 8 : model === "HJB" ? 20 : model === "Vasicek" || model === "Hull–White" ? 10 : 4;
  if (!Number.isInteger(Number(spaceSteps)) || Number(spaceSteps) < minimumSpaceSteps) {
    validationIssues.push(`${model === "Heston" ? "Spot" : model === "HJB" ? "Wealth" : model === "Vasicek" || model === "Hull–White" ? "Rate" : "Space"} steps must be an integer of at least ${minimumSpaceSteps}.`);
  }
  if (model === "Heston" && (!Number.isInteger(Number(varianceSteps)) || Number(varianceSteps) < 4)) {
    validationIssues.push("Variance steps must be an integer of at least 4.");
  }
  if (!Number.isInteger(Number(timeSteps)) || Number(timeSteps) < 1) {
    validationIssues.push("Time steps must be a positive integer.");
  }
  const warnings = diagnosticWarnings(model, parameters);
  const displaySide = side && contractSpec.optionSides?.includes(side) ? side : contractSpec.optionSides?.[0];

  const isShortRateModel = model === "Vasicek" || model === "Hull–White";
  const isHestonModel = model === "Heston";
  const isHjbModel = model === "HJB";
  const monteCarloEligible = (model === "Black–Scholes" && (contract === "european" || contract === "digital" || contract === "barrier"))
    || (model === "Heston" && contract === "european")
    || (isShortRateModel && (contract === "zero-coupon-bond" || contract === "bond-option"))
    || (isHjbModel && contract === "merton-allocation");
  validationIssues.push(...validateMonteCarloControls({
    enabled: monteCarloEnabled,
    eligible: monteCarloEligible,
    paths: monteCarloPaths,
    timeSteps: monteCarloTimeSteps,
    seed: monteCarloSeed,
    requiresEvenPaths: model === "Heston",
  }));
  const monteCarloTabAvailable = isMonteCarloResultTabAvailable(monteCarloEligible, Boolean(monteCarloResult));
  const economicBridge = useMemo(
    () => appliedCpiScenario?.model === model
      ? appliedCpiScenario.bridge
      : buildEconomicBridge(model === "HJB" && currentMarketSnapshot?.mertonOpportunity
        ? currentMarketSnapshot.mertonOpportunity.bridgeInput
        : DEFAULT_ECONOMIC_BRIDGE_INPUT, model, bridgeCalibrationBase ?? parameters),
    [appliedCpiScenario, model, currentMarketSnapshot, bridgeCalibrationBase, parameters],
  );
  const selectedBridgeScenario = economicBridge.scenarios.find((scenario) => scenario.id === bridgeScenarioId)
    ?? economicBridge.scenarios[0];
  const activeScenarioIdentity = appliedCpiScenario?.model === model ? {
    forecastRunId: appliedCpiScenario.forecastRunId,
    distributionMethod: appliedCpiScenario.distributionMethod,
    distributionMethodVersion: appliedCpiScenario.distributionMethodVersion,
    distributionSeed: appliedCpiScenario.distributionSeed,
    mappingVersion: appliedCpiScenario.mappingVersion,
    scenarioInputs: appliedCpiScenario.scenarioInputs,
  } : undefined;
  const solverAvailable = (model === "Black–Scholes"
    && ["european", "digital", "barrier", "american-put"].includes(contract)
    && (displaySide === "Call" || displaySide === "Put"))
    || (isShortRateModel && ["zero-coupon-bond", "bond-option"].includes(contract))
    || (isHestonModel && contract === "european" && (displaySide === "Call" || displaySide === "Put"))
    || (isHjbModel && contract === "merton-allocation");
  const phaseLabel = isHjbModel ? "Phase 5" : isHestonModel ? "Phase 4" : isShortRateModel ? "Phase 3" : "Phase 2";
  const basePrice = solverResult?.price ?? Number.NaN;
  const benchmark = solverResult?.analyticPrice ?? Number.NaN;
  const absoluteError = solverResult?.absoluteError ?? Number.NaN;
  const withinTolerance = solverResult ? solverResult.absoluteError <= contractSpec.tolerance.pointwiseAbsolute : false;
  const latestObservedOrder = convergence.at(-1)?.observedOrder;
  const runWarnings = solverResult ? [
    !withinTolerance ? `Point error ${absoluteError.toExponential(3)} exceeds the ${contractSpec.tolerance.pointwiseAbsolute.toExponential(1)} acceptance limit. Treat this run as diagnostic, not accepted.` : null,
    contractSpec.tolerance.maxNorm !== undefined && solverResult.maxNormError > contractSpec.tolerance.maxNorm
      ? `Maximum-norm error ${solverResult.maxNormError.toExponential(3)} exceeds ${contractSpec.tolerance.maxNorm.toExponential(1)}.`
      : null,
    contractSpec.tolerance.observedOrder !== undefined && latestObservedOrder != null && latestObservedOrder < contractSpec.tolerance.observedOrder
      ? `Observed refinement order ${latestObservedOrder.toFixed(2)} is below the ${contractSpec.tolerance.observedOrder.toFixed(2)} target.`
      : null,
    !solverResult.solution.diagnostics.finite ? "The solution contains non-finite values and must not be used." : null,
  ].filter((message): message is string => Boolean(message)) : [];
  const caseEconomicScenario = useMemo<CaseEconomicScenario | null>(() => {
    if (appliedCpiScenario?.model === model) {
      return {
        model,
        source: "forecast",
        scenarioId: appliedCpiScenario.id,
        forecastRunId: appliedCpiScenario.forecastRunId,
        mappingId: appliedCpiScenario.bridge.mappingId,
        mappingVersion: appliedCpiScenario.mappingVersion,
        scenarioMeasure: "P",
        baseMarketSnapshotId: activeMarketApplication?.snapshot.id ?? null,
        appliedAt: appliedEconomicScenarioAt,
        parameters: appliedCpiScenario.affectedParameters.map((item) => ({
          id: item.id,
          baseValue: item.baseValue,
          scenarioValue: item.scenarioValue,
          targetMeasure: item.measure,
        })),
      };
    }
    if (!appliedBridgeScenarioId) return null;
    const scenario = economicBridge.scenarios.find((item) => item.id === appliedBridgeScenarioId);
    if (!scenario) return null;
    return {
      model,
      source: "economic-bridge",
      scenarioId: scenario.id,
      forecastRunId: null,
      mappingId: economicBridge.mappingId,
      mappingVersion: economicBridge.mappingVersion,
      scenarioMeasure: "P",
      baseMarketSnapshotId: activeMarketApplication?.snapshot.id ?? null,
      appliedAt: appliedEconomicScenarioAt,
      parameters: scenario.transformations.flatMap((item) => item.targetParameter ? [{
        id: item.targetParameter,
        baseValue: economicBridge.calibratedParameters[item.targetParameter] ?? "",
        scenarioValue: scenario.parameters[item.targetParameter] ?? item.mappedValue ?? "",
        targetMeasure: item.measure,
      }] : []),
    };
  }, [activeMarketApplication, appliedBridgeScenarioId, appliedCpiScenario, appliedEconomicScenarioAt, economicBridge, model]);
  const caseValidationKey = validationIssues.join("\u001f");
  const marketBaseParameters = bridgeCalibrationBase
    ?? activeMarketApplication?.appliedParameters
    ?? parameters;
  const currentCaseInputs: CaseInputs = {
    definition: {
      caseName,
      instrument: definitionInstrument,
      valuationDate: definitionValuationDate,
      model,
      contractId: contract,
      contractLabel: contractSpec.label,
      side: displaySide ?? null,
      measure: config.measure,
      objective: definitionObjective,
      confirmedAt: definitionConfirmedAt,
    },
    marketBase: timelineMarketBaseOverride
      && checkModelSnapshotCompatibility({ model, measure: config.measure }, timelineMarketBaseOverride).length === 0
      ? timelineMarketBaseOverride
      : {
          model,
          source: activeMarketApplication ? "snapshot" : "manual",
          snapshotId: activeMarketApplication?.snapshot.id ?? null,
          applicationId: activeMarketApplication?.id ?? null,
          instrument: activeMarketApplication?.snapshot.instrument ?? marketRequest.instrument,
          currency: activeMarketApplication?.snapshot.currency ?? marketRequest.currency,
          asOfDate: activeMarketApplication?.snapshot.asOfDate ?? marketRequest.asOfDate,
          measure: config.measure,
          appliedAt: activeMarketApplication?.appliedAt ?? null,
          parameters: { ...marketBaseParameters },
        },
    economicScenario: timelineScenarioOverride?.model === model ? timelineScenarioOverride : caseEconomicScenario,
    conditionApproval: caseRecord.core.conditionApproval ?? null,
    solverConfiguration: {
      model,
      contractId: contract,
      scheme,
      gridKind,
      spaceSteps: Number(spaceSteps),
      varianceSteps: isHestonModel ? Number(varianceSteps) : null,
      timeSteps: Number(timeSteps),
      parameters: { ...parameters },
      monteCarlo: {
        enabled: monteCarloEnabled,
        paths: monteCarloEnabled ? Number(monteCarloPaths) : null,
        timeSteps: monteCarloEnabled ? Number(monteCarloTimeSteps) : null,
        seed: monteCarloEnabled ? Number(monteCarloSeed) : null,
      },
      validationIssues: caseValidationKey ? caseValidationKey.split("\u001f") : [],
    },
  };
  const definitionIssues = validateCaseDefinition(currentCaseInputs.definition);
  const canSaveDefinition = validateCaseDefinition({
    ...currentCaseInputs.definition,
    confirmedAt: currentCaseInputs.definition.confirmedAt ?? CASE_BOOTSTRAP_TIMESTAMP,
  }).length === 0;
  const liveCaseRecord = synchroniseCaseInputs(caseRecord, currentCaseInputs, {
    reason: "Capture changed dashboard inputs",
    revisionId: "pending-input-change",
    now: caseRecord.updatedAt,
  });
  const caseReadiness = deriveCaseReadiness(liveCaseRecord);
  const approveMarketBase = () => {
    const approvedAt = new Date().toISOString();
    try {
      const synchronised = synchroniseCaseInputs(caseRecord, currentCaseInputs, {
        reason: "Capture inputs before Condition approval",
        revisionId: `before-condition-approval-${approvedAt.replaceAll(":", "-")}`,
        now: approvedAt,
      });
      const approved = approveCaseConditioning(synchronised, {
        reason: "Approve market base",
        revisionId: `condition-approved-${approvedAt.replaceAll(":", "-")}`,
        now: approvedAt,
      });
      setCaseRecord(approved);
      setSolverError(null);
      selectCaseStage("solve");
    } catch (error) {
      setSolverError(error instanceof Error ? error.message : "The market base could not be approved.");
    }
  };
  const caseExecutionReady = caseReadiness.definition === "complete"
    && caseReadiness.conditioning === "complete"
    && caseReadiness.blockingReasons.length === 0;
  const solveMatchingQuote = findMatchingOptionQuote({
    snapshot: activeMarketApplication?.snapshot ?? null,
    definition: currentCaseInputs.definition,
    parameters,
  });
  const solveQuotedContract = solveMatchingQuote ?? findRepresentativeOptionQuote({
    snapshot: activeMarketApplication?.snapshot ?? null,
    definition: currentCaseInputs.definition,
    parameters,
  });
  const completedCoreCandidates: CaseCore[] = [
    liveCaseRecord.core,
    ...[...liveCaseRecord.revisions].reverse().map((revision) => revision.snapshot),
  ];
  const isCompletedRunSnapshot = (core: CaseCore) => core.latestRun?.status === "completed"
    && createCaseInputFingerprint(core).combined === core.latestRun.inputFingerprint.combined;
  const completedRunCore = completedCoreCandidates.find((core) => {
    const latestRun = liveCaseRecord.core.latestRun;
    return latestRun?.status === "completed"
      && isCompletedRunSnapshot(core)
      && core.latestRun?.id === latestRun.id;
  }) ?? null;
  const decideRun = completedRunCore?.latestRun ?? (liveCaseRecord.core.latestRun?.status === "completed" ? liveCaseRecord.core.latestRun : null);
  const decideDefinition = completedRunCore?.definition ?? currentCaseInputs.definition;
  const decideScenario = completedRunCore?.economicScenario ?? null;
  const expectedBaseSolverConfiguration = completedRunCore ? {
    ...completedRunCore.solverConfiguration,
    parameters: {
      ...completedRunCore.solverConfiguration.parameters,
      ...Object.fromEntries((decideScenario?.parameters ?? []).map((parameter) => [
        parameter.id,
        completedRunCore.marketBase.parameters[parameter.id] ?? parameter.baseValue,
      ])),
    },
  } : null;
  const matchingBaseCore = completedCoreCandidates.find((core) => isCompletedRunSnapshot(core)
    && !core.economicScenario
    && JSON.stringify(core.definition) === JSON.stringify(decideDefinition)
    && JSON.stringify(core.marketBase) === JSON.stringify(completedRunCore?.marketBase)
    && JSON.stringify(core.solverConfiguration) === JSON.stringify(expectedBaseSolverConfiguration));
  const decideMertonResult = decideDefinition.model === "HJB" && solverResult && isMertonResult(solverResult) ? solverResult : null;
  const decideMertonPolicy = decideMertonResult ? presentMertonPolicy(decideMertonResult) : null;
  const decidePrimaryLabel = decideMertonResult ? "Optimal risky allocation" : decideDefinition.model === "HJB" ? "Value function" : "Model value";
  const decidePrimaryValue = decideMertonResult
    ? decideMertonPolicy?.nativeValue ?? "—"
    : decideRun?.summary?.primaryValue != null ? formatMoney(decideRun.summary.primaryValue) : "—";
  const decideSecondaryLabel = decideMertonResult ? "Allocation / current wealth" : "Independent benchmark";
  const decideSecondaryValue = decideMertonResult
    ? decideMertonPolicy?.shareOfWealthValue ?? "—"
    : decideRun?.summary?.benchmarkValue != null ? formatMoney(decideRun.summary.benchmarkValue) : "—";
  const decideBaseNumeric = matchingBaseCore?.latestRun?.summary?.primaryValue ?? (decideScenario ? null : decideRun?.summary?.primaryValue ?? null);
  const decideScenarioNumeric = decideScenario ? decideRun?.summary?.primaryValue ?? null : null;
  const decideMarketSnapshot = completedRunCore?.marketBase.snapshotId
    ? marketHistory.find((item) => item.snapshot.id === completedRunCore.marketBase.snapshotId
      && item.snapshot.model === decideDefinition.model)?.snapshot ?? null
    : null;
  const decideQuote = findMatchingOptionQuote({
    snapshot: decideMarketSnapshot,
    definition: decideDefinition,
    parameters: completedRunCore?.solverConfiguration.parameters ?? {},
  });
  const decideSuggestedQuote = decideQuote ? null : findRepresentativeOptionQuote({
    snapshot: decideMarketSnapshot,
    definition: decideDefinition,
    parameters: completedRunCore?.solverConfiguration.parameters ?? {},
  });
  const decideMonteCarloEstimate = monteCarloResult
    ? "expectedUtility" in monteCarloResult
      ? monteCarloResult.expectedUtility
      : "payoff" in monteCarloResult
        ? monteCarloResult.payoff.discountedValue
        : monteCarloResult.discountedValue
    : null;
  const valuationAssessment = assessOptionValuation({
    definition: decideDefinition,
    resultFreshness: caseReadiness.status.resultFreshness,
    accepted: Boolean(decideRun?.summary?.accepted),
    modelValue: decideDefinition.model === "HJB" ? null : decideRun?.summary?.primaryValue ?? null,
    numericalError: solverResult?.absoluteError ?? null,
    monteCarloInterval: decideMonteCarloEstimate?.confidence95 ?? null,
    parameterStandardDeviation: parameterUncertaintyResult?.summary.standardDeviation ?? null,
    quote: decideQuote,
    suggestedQuote: decideSuggestedQuote,
    numericalAcceptanceIssues: decideRun?.summary?.acceptanceIssues,
  });
  const decideReliability: DecideMetric[] = solverResult ? [
    { label: "Acceptance", value: decideRun?.summary?.accepted ? "Passed" : "Review", detail: decideRun?.summary?.accepted ? "Independent checks accepted" : "Inspect the evidence before use" },
    { label: "Benchmark gap", value: solverResult.absoluteError.toExponential(3), detail: `${(solverResult.relativeError * 100).toFixed(4)}% relative` },
    { label: "Domain check", value: Number.isFinite(domainExpansionDelta) ? domainExpansionDelta.toExponential(3) : "—", detail: "Expansion sensitivity" },
    ...(latestObservedOrder == null ? [] : [{ label: "Observed order", value: latestObservedOrder.toFixed(2), detail: "Latest refinement level" }]),
  ] : [];
  const decideUncertainty: DecideMetric[] = [];
  if (parameterUncertaintyResult) {
    decideUncertainty.push(
      { label: "P10 — P90", value: `${formatMoney(parameterUncertaintyResult.summary.p10)} — ${formatMoney(parameterUncertaintyResult.summary.p90)}`, detail: `${parameterUncertaintyResult.sampleBudget} mapped macro outcomes` },
      { label: "Standard deviation", value: formatMoney(parameterUncertaintyResult.summary.standardDeviation), detail: parameterUncertaintyResult.stability.stable ? "Propagation stable" : "Stability review required" },
    );
  }
  if (monteCarloResult && decideMonteCarloEstimate) {
    decideUncertainty.push({
      label: "Monte Carlo 95% interval",
      value: `${formatMoney(decideMonteCarloEstimate.confidence95[0])} — ${formatMoney(decideMonteCarloEstimate.confidence95[1])}`,
      detail: `${monteCarloResult.simulatedPaths.toLocaleString("en-US")} paths · SE ${decideMonteCarloEstimate.standardError.toExponential(2)}`,
    });
  }
  const decideSensitivities: DecideMetric[] = solverResult
    ? "greeks" in solverResult
      ? [
          { label: "Delta", value: solverResult.greeks.delta.toFixed(6) },
          { label: "Gamma", value: solverResult.greeks.gamma.toFixed(6) },
          { label: "Vega", value: solverResult.greeks.vega.toFixed(6) },
          { label: "Theta", value: solverResult.greeks.theta.toFixed(6) },
          { label: "Rho", value: solverResult.greeks.rho.toFixed(6) },
        ]
      : isMertonResult(solverResult)
        ? (() => {
            const policy = presentMertonPolicy(solverResult);
            return [
              { label: "Dollar allocation", value: policy.nativeValue, detail: `Closed form ${policy.analyticNativeValue}` },
              ...(policy.shareOfWealthValue ? [{ label: "Share of current wealth", value: policy.shareOfWealthValue, detail: `${policy.nativeValue} of ${policy.wealthValue}` }] : []),
              { label: "Control bounds", value: policy.boundsValue, detail: "Dollar risky-asset position" },
              { label: "Policy gap", value: policy.absoluteErrorValue },
              { label: "Max policy error", value: formatDollarAllocation(solverResult.maxPolicyError) },
              { label: "Value function", value: formatMoney(solverResult.value), detail: `Closed form ${formatMoney(solverResult.analyticValue)}` },
            ];
          })()
        : isShortRateResult(solverResult)
          ? [
              { label: "Rate delta", value: solverResult.sensitivities.rateDelta.toFixed(6) },
              { label: "Rate gamma", value: solverResult.sensitivities.rateGamma.toFixed(6) },
              { label: "Volatility", value: solverResult.sensitivities.volatilitySensitivity.toFixed(6) },
            ]
          : [
              { label: "Spot delta", value: solverResult.sensitivities.delta.toFixed(6) },
              { label: "Spot gamma", value: solverResult.sensitivities.gamma.toFixed(6) },
              { label: "Variance delta", value: solverResult.sensitivities.varianceDelta.toFixed(6) },
            ]
    : [];
  const decideEvidence: DecideEvidenceSection[] = decideRun ? [
    ...(convergence.length > 0 ? [{
      title: "Convergence",
      summary: `${convergence.length} refinement levels · latest order ${latestObservedOrder?.toFixed(2) ?? "not estimated"}`,
      metrics: convergence.slice(-4).map((level, index) => ({
        label: `Level ${Math.max(0, convergence.length - 4) + index + 1}`,
        value: `${level.spaceSteps} × ${"varianceSteps" in level ? `${level.varianceSteps} × ` : ""}${level.timeSteps}`,
        detail: `Error ${level.absoluteError.toExponential(3)}${level.observedOrder == null ? "" : ` · order ${level.observedOrder.toFixed(2)}`}`,
      })),
    }] : []),
    {
      title: "Run details",
      summary: `${decideRun.execution} execution · ${decideRun.id}`,
      metrics: [
        { label: "Queued", value: new Date(decideRun.queuedAt).toLocaleString("en-AU") },
        { label: "Completed", value: decideRun.completedAt ? new Date(decideRun.completedAt).toLocaleString("en-AU") : "—" },
        { label: "Scheme", value: completedRunCore?.solverConfiguration.scheme ?? "—" },
        { label: "Grid", value: completedRunCore ? `${completedRunCore.solverConfiguration.spaceSteps} × ${completedRunCore.solverConfiguration.timeSteps}` : "—", detail: completedRunCore?.solverConfiguration.gridKind },
      ],
    },
    {
      title: "Run manifest",
      summary: "Fingerprints and reproducibility identifiers",
      metrics: [
        { label: "Run ID", value: decideRun.id },
        { label: "Combined input", value: decideRun.inputFingerprint.combined },
        { label: "Definition", value: decideRun.inputFingerprint.definition },
        { label: "Market base", value: decideRun.inputFingerprint.marketBase },
        { label: "Economic scenario", value: decideRun.inputFingerprint.economicScenario },
        { label: "Solver configuration", value: decideRun.inputFingerprint.solverConfiguration, detail: "Download the full JSON manifest from the completed run card." },
      ],
    },
    {
      title: "Provenance",
      summary: decideScenario ? "Market base plus an explicit macro branch" : "Calibrated market base only",
      metrics: [
        { label: "Market source", value: completedRunCore?.marketBase.source ?? "—", detail: completedRunCore?.marketBase.snapshotId ?? "Manual inputs" },
        { label: "Market timestamp", value: completedRunCore?.marketBase.asOfDate ?? "—" },
        ...(decideScenario ? [
          { label: "Scenario", value: decideScenario.scenarioId, detail: `${decideScenario.scenarioMeasure}-measure source` },
          { label: "Mapping", value: decideScenario.mappingId, detail: decideScenario.mappingVersion },
        ] : []),
      ],
    },
  ] : [];
  const caseSummary = {
    caseLabel: caseName || "Unnamed case",
    definition: `${model} · ${config.measure}-measure`,
    market: activeMarketApplication
      ? `${activeMarketApplication.snapshot.instrument} · ${activeMarketApplication.snapshot.asOfDate}`
      : `Manual inputs · ${marketRequest.asOfDate}`,
    scenario: appliedCpiScenario
      ? `${appliedCpiScenario.scenarioInputs.quantile.toUpperCase()} · ${appliedCpiScenario.forecastRunId}`
      : appliedBridgeScenarioId
        ? appliedBridgeScenarioId
        : "Base case only",
  };
  const caseSystemStatus = caseReadiness.status.labels.headline;
  const parameterUncertaintyLockedReason = !appliedCpiScenario
    ? "Apply a reviewed CPI scenario first."
    : economicForecast.runId !== appliedCpiScenario.forecastRunId
      ? "The displayed forecast differs from the applied scenario source; review and apply it again."
      : economicForecast.status !== "accepted" || economicForecast.freshness !== "current" || !economicForecast.distribution.accepted
        ? "A current accepted CPI distribution is required."
        : !solverResult
          ? "Run the deterministic PDE solver for the applied scenario first."
          : runWarnings.length > 0
            ? "The current deterministic PDE convergence or acceptance gate requires review."
            : null;

  const clearCalculatedResult = () => {
    setTimelineMarketBaseOverride(null);
    setTimelineScenarioOverride(null);
    const staleJobId = activeJobIdRef.current;
    activeJobIdRef.current += 1;
    if (running) {
      workerRef.current?.postMessage({ type: "cancel", jobId: staleJobId } satisfies SolverWorkerRequest);
      setCaseRecord((current) => finishCaseRun(current, `solver-job-${staleJobId}`, "cancelled", {
        error: "Inputs changed while the run was in progress.",
      }));
      setWorkerGeneration((current) => current + 1);
      setRunning(false);
      setProgress(100);
      setWorkerStage("Inputs changed — background job cancelled");
    }
    setSolverError(null);
    setLastRun("Inputs changed — previous result retained as stale");
    const stalePropagationId = parameterUncertaintyJobIdRef.current;
    parameterUncertaintyJobIdRef.current += 1;
    if (parameterUncertaintyRunning) {
      parameterUncertaintyWorkerRef.current?.postMessage({ type: "cancel", jobId: stalePropagationId } satisfies ParameterUncertaintyWorkerRequest);
    }
    setParameterUncertaintyRunning(false);
    setParameterUncertaintyError(null);
    setParameterUncertaintyProgress(parameterUncertaintyResult ? 100 : 0);
    setParameterUncertaintyStage("Inputs changed — previous uncertainty retained as stale");
  };

  const applyQuotedContract = (quote: OptionQuoteEvidence | null) => {
    if (!quote || quote.instrument !== definitionInstrument || quote.snapshotId !== activeMarketApplication?.snapshot.id) return;
    setParameters((current) => ({
      ...current,
      strike: String(quote.strike),
      maturity: String(quote.maturity),
    }));
    clearCalculatedResult();
    setLastRun(`Quoted contract ${quote.contractSymbol} loaded — ready to run with the approved market base`);
  };

  const fetchMarketData = async () => {
    if (hestonCalibrating) {
      hestonCalibrationWorkerRef.current?.terminate();
      hestonCalibrationWorkerRef.current = null;
      hestonCalibrationJobIdRef.current += 1;
      setHestonCalibrating(false);
    }
    setMarketLoading(true);
    setMarketError(null);
    try {
      const request = { ...marketRequest, model, measureMode: config.measure };
      const snapshot = await getMarketAdapter(model).preview(request, parameters);
      const quoteAlignment = alignParametersToOptionQuote({
        snapshot,
        definition: currentCaseInputs.definition,
        parameters,
      });
      setMarketSnapshots((current) => ({ ...current, [model]: snapshot }));
      setSelectedMarketProposalIds(new Set(selectedChangedProposalIds(snapshot)));
      if (quoteAlignment.changed && quoteAlignment.quote) {
        setParameters(quoteAlignment.parameters);
        clearCalculatedResult();
        setLastRun(`Representative quoted contract ${quoteAlignment.quote.contractSymbol} selected automatically from fetched data — review and apply the market snapshot`);
      }
      if (snapshot.heston) setHestonCalibrationStatus("Surface prepared · seeds only · calibration required");
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "The market-data request failed.");
    } finally {
      setMarketLoading(false);
    }
  };

  const runHestonCalibration = () => {
    const snapshot = marketSnapshots.Heston;
    if (!snapshot?.heston || snapshot.validationIssues.length > 0 || hestonCalibrating) return;
    const worker = new Worker(new URL("./workers/heston-calibration.worker.ts", import.meta.url), { type: "module" });
    hestonCalibrationWorkerRef.current?.terminate();
    hestonCalibrationWorkerRef.current = worker;
    const jobId = hestonCalibrationJobIdRef.current + 1;
    hestonCalibrationJobIdRef.current = jobId;
    setHestonCalibrating(true);
    setMarketError(null);
    setHestonCalibrationStatus(`Calibrating ${snapshot.heston.instruments.filter((item) => !item.excluded).length} instruments in a background worker…`);
    worker.onmessage = (event: MessageEvent<HestonCalibrationWorkerResponse>) => {
      const message = event.data;
      if (message.jobId !== hestonCalibrationJobIdRef.current) return;
      if (message.type === "failed") {
        setMarketError(message.error);
        setHestonCalibrationStatus("Calibration failed · last accepted set preserved");
      } else {
        const accepted = acceptHestonCalibration(snapshot, message.result);
        setMarketSnapshots((current) => ({ ...current, Heston: accepted }));
        setSelectedMarketProposalIds(new Set(selectedChangedProposalIds(accepted)));
        setHestonCalibrationStatus(`Calibration converged · ${message.result.evaluations} evaluations · RMSE ${message.result.weightedRmse.toExponential(3)}`);
      }
      setHestonCalibrating(false);
      worker.terminate();
      if (hestonCalibrationWorkerRef.current === worker) hestonCalibrationWorkerRef.current = null;
    };
    worker.onerror = () => {
      if (jobId !== hestonCalibrationJobIdRef.current) return;
      setMarketError("The Heston calibration worker failed; the last accepted parameter set was preserved.");
      setHestonCalibrationStatus("Calibration failed · last accepted set preserved");
      setHestonCalibrating(false);
      worker.terminate();
      if (hestonCalibrationWorkerRef.current === worker) hestonCalibrationWorkerRef.current = null;
    };
    worker.postMessage({ type: "calibrate", jobId, snapshot, startedAt: new Date().toISOString() } satisfies HestonCalibrationWorkerRequest);
  };

  const cancelHestonCalibration = () => {
    if (!hestonCalibrating) return;
    hestonCalibrationJobIdRef.current += 1;
    hestonCalibrationWorkerRef.current?.terminate();
    hestonCalibrationWorkerRef.current = null;
    setHestonCalibrating(false);
    setHestonCalibrationStatus("Calibration cancelled · last accepted set preserved");
  };

  const toggleMarketProposal = (id: string) => {
    setSelectedMarketProposalIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyMarketData = () => {
    if (!currentMarketSnapshot) return;
    try {
      const compatibilityIssues = checkModelSnapshotCompatibility({ model, measure: config.measure }, currentMarketSnapshot);
      if (compatibilityIssues.length > 0) throw new Error(compatibilityIssues.join(" "));
      setTimelineMarketBaseOverride(null);
      setTimelineScenarioOverride(null);
      if (currentMarketSnapshot.heston && !currentMarketSnapshot.heston.calibration) throw new Error("Run and accept a Heston calibration before applying the calibrated set.");
      if (currentMarketSnapshot.vasicek?.requestedMeasureMode === "q-curve" && !currentMarketSnapshot.vasicek.qCalibration) throw new Error("A documented cross-sectional Q calibration is required before applying a Vasicek Q set.");
      const applicationIds = currentMarketSnapshot.heston
        ? new Set([...selectedMarketProposalIds, "v0", "kappa", "theta", "xi", "rho"])
        : currentMarketSnapshot.hullWhite
          ? new Set(["curveId", "shortRate"])
        : currentMarketSnapshot.vasicek?.requestedMeasureMode === "q-curve"
          ? new Set([...selectedMarketProposalIds, "shortRate", "meanReversion", "longRunRate", "rateVolatility"])
          : currentMarketSnapshot.vasicek
            ? new Set(["shortRate"])
        : selectedMarketProposalIds;
      const result = applySnapshot(parameters, currentMarketSnapshot, applicationIds);
      const quoteAlignment = alignParametersToOptionQuote({
        snapshot: currentMarketSnapshot,
        definition: currentCaseInputs.definition,
        parameters: result.parameters,
      });
      const appliedHistory = quoteAlignment.changed
        ? { ...result.history, appliedParameters: { ...quoteAlignment.parameters } }
        : result.history;
      setParameters(quoteAlignment.parameters);
      setMarketHistory((current) => [appliedHistory, ...current]);
      setActiveMarketSnapshotId(currentMarketSnapshot.id);
      if (currentMarketSnapshot.mertonOpportunity) {
        setAppliedBridgeScenarioId(null);
        setBridgeCalibrationBase(null);
        setBridgeScenarioId("baseline");
      }
      setMarketError(null);
      clearCalculatedResult();
      if (quoteAlignment.changed && quoteAlignment.quote) {
        setLastRun(`Representative quoted contract ${quoteAlignment.quote.contractSymbol} aligned automatically — approve the changed inputs, then run`);
      }
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "The market snapshot could not be applied.");
    }
  };

  const saveVasicekHistoricalScenario = () => {
    if (!currentMarketSnapshot?.vasicek) return;
    try {
      const scenario = createVasicekHistoricalScenario(currentMarketSnapshot);
      setVasicekHistoricalScenarios((current) => [scenario, ...current]);
      setVasicekScenarioStatus(`Historical P scenario saved · ${scenario.id}`);
      setMarketError(null);
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "The historical Vasicek scenario could not be saved.");
    }
  };

  const restoreMarketHistory = (historyId: string) => {
    const entry = marketHistory.find((item) => item.id === historyId);
    if (!entry) return;
    const compatibilityIssues = checkModelSnapshotCompatibility({ model, measure: config.measure }, entry.snapshot);
    if (compatibilityIssues.length > 0) {
      setMarketError(compatibilityIssues.join(" "));
      return;
    }
    setParameters(restoreSnapshotInputs(entry));
    setMarketHistory((current) => current.map((item) => item.id === historyId ? { ...item, restoredAt: new Date().toISOString() } : item));
    if (activeMarketSnapshotId === entry.snapshot.id) setActiveMarketSnapshotId(null);
    if (entry.snapshot.mertonOpportunity) {
      setAppliedBridgeScenarioId(null);
      setBridgeCalibrationBase(null);
    }
    clearCalculatedResult();
  };

  const restoreLatestMarketInputs = () => {
    if (lastAppliedMarketSnapshot) restoreMarketHistory(lastAppliedMarketSnapshot.id);
  };

  const applyTimelineCoreToWorkspace = (core: CaseCore, action: "restored" | "branched") => {
    const compatibilityIssues = getCaseModelCompatibilityIssues(core);
    if (compatibilityIssues.length > 0) {
      setSolverError(`The case revision cannot be opened: ${compatibilityIssues.join(" ")}`);
      return false;
    }
    setModel(core.definition.model);
    setCaseName(core.definition.caseName);
    setDefinitionInstrument(core.definition.instrument);
    setDefinitionValuationDate(core.definition.valuationDate);
    setDefinitionObjective(core.definition.objective);
    setDefinitionConfirmedAt(core.definition.confirmedAt);
    setContract(core.definition.contractId);
    setSide(core.definition.side);
    setParameters(Object.fromEntries(Object.entries(core.solverConfiguration.parameters).map(([id, value]) => [id, String(value)])));
    setScheme(core.solverConfiguration.scheme as NumericalScheme);
    setGridKind(core.solverConfiguration.gridKind as GridKind);
    setSpaceSteps(String(core.solverConfiguration.spaceSteps));
    setVarianceSteps(String(core.solverConfiguration.varianceSteps ?? 40));
    setTimeSteps(String(core.solverConfiguration.timeSteps));
    setMonteCarloEnabled(core.solverConfiguration.monteCarlo.enabled);
    setMonteCarloPaths(String(core.solverConfiguration.monteCarlo.paths ?? 10000));
    setMonteCarloTimeSteps(String(core.solverConfiguration.monteCarlo.timeSteps ?? 252));
    setMonteCarloSeed(String(core.solverConfiguration.monteCarlo.seed ?? 20250308));
    setMarketRequest({
      ...defaultMarketRequest(core.definition.model),
      instrument: core.marketBase.instrument,
      currency: core.marketBase.currency,
      asOfDate: core.marketBase.asOfDate,
    });
    setActiveMarketSnapshotId(core.marketBase.snapshotId);
    setTimelineMarketBaseOverride(core.marketBase);
    setTimelineScenarioOverride(core.economicScenario);
    setAppliedCpiScenario(null);
    setAppliedBridgeScenarioId(core.economicScenario?.scenarioId ?? null);
    setAppliedEconomicScenarioAt(core.economicScenario?.appliedAt ?? null);
    setBridgeCalibrationBase(core.economicScenario ? { ...core.marketBase.parameters } : null);
    const payload = core.latestRun ? completedRunPayloadsRef.current[core.latestRun.id] : null;
    if (payload) {
      setSolverResult(payload.result);
      setConvergence(payload.convergence);
      setDomainExpansionDelta(payload.domainExpansionDelta);
      setMonteCarloResult(payload.monteCarlo);
    } else {
      setSolverResult(null);
      setConvergence([]);
      setDomainExpansionDelta(Number.NaN);
      setMonteCarloResult(null);
    }
    setParameterUncertaintyResult(null);
    setParameterUncertaintyStage("Revision changed — propagate uncertainty again if required");
    setLastRun(`Case revision ${action} — solver has not been started automatically`);
    setDefinitionConsequence(`Case definition ${action} from the timeline. Review it before continuing.`);
    setTimelineOpen(false);
    return true;
  };

  const restoreTimelineRevision = (revisionId: string) => {
    const now = new Date().toISOString();
    const restored = restoreCaseRevision(liveCaseRecord, revisionId, {
      reason: `Restore case checkpoint ${revisionId}`,
      revisionId: `before-restore-${now.replaceAll(":", "-")}`,
      now,
    });
    if (getCaseModelCompatibilityIssues(restored.core).length === 0) {
      setCaseRecord(restored);
      applyTimelineCoreToWorkspace(restored.core, "restored");
    }
  };

  const branchTimelineRevision = (revisionId: string) => {
    const now = new Date().toISOString();
    const branched = restoreCaseRevision(liveCaseRecord, revisionId, {
      reason: `Create case branch from ${revisionId}`,
      revisionId: `before-branch-${now.replaceAll(":", "-")}`,
      now,
    });
    if (getCaseModelCompatibilityIssues(branched.core).length === 0) {
      setCaseRecord(branched);
      applyTimelineCoreToWorkspace(branched.core, "branched");
    }
  };

  const changeModel = (next: ModelKey) => {
    if (next === model) return;
    if (hestonCalibrating) cancelHestonCalibration();
    const changedAt = new Date().toISOString();
    clearCalculatedResult();
    const captured = synchroniseCaseInputs(liveCaseRecord, currentCaseInputs, {
      reason: `Capture ${model} draft before governing-model change`,
      revisionId: `before-model-change-${changedAt.replaceAll(":", "-")}`,
      now: changedAt,
    });
    const compatibleDraft = findCompatibleModelDraft(captured, next);
    const switched = switchCaseModelRevision(captured, next, initialDashboardCaseInputs(next), {
      reason: `Change governing model from ${model} to ${next}`,
      revisionId: `model-change-${changedAt.replaceAll(":", "-")}`,
      now: changedAt,
    });
    setCaseRecord(switched);
    applyTimelineCoreToWorkspace(switched.core, "restored");
    setSeed(0);
    setSelectedMarketProposalIds(new Set((marketSnapshots[next]?.proposals ?? [])
      .filter((proposal) => proposal.selected && proposal.applicable && proposal.currentValue !== proposal.proposedValue)
      .map((proposal) => proposal.id)));
    setMarketError(null);
    setDefinitionConsequence(compatibleDraft
      ? `New ${next} case revision created. Its compatible saved draft was restored; the ${model} revision remains in the timeline.`
      : `New ${next} case revision created with a manual base and its default compatible contract. The ${model} revision remains in the timeline.`);
  };

  const changeContract = (nextContractId: string) => {
    if (nextContractId === contract) return;
    const nextContract = getContractSpec(model, nextContractId);
    const changedAt = new Date().toISOString();
    const defaults = defaultParameters(model, nextContract.id);
    const nextParameters = Object.fromEntries(getActiveParameters(model, nextContract.id).map((parameter) => [
      parameter.id,
      parameters[parameter.id] ?? defaults[parameter.id],
    ]));
    const previousSide = displaySide ?? null;
    const nextSide = nextContract.optionSides
      ? previousSide && nextContract.optionSides.includes(previousSide) ? previousSide : nextContract.optionSides[0]
      : null;
    const revised = changeCaseContractRevision(liveCaseRecord, nextContract.id, nextParameters, {
      reason: `Change contract from ${contractSpec.label} to ${nextContract.label}`,
      revisionId: `contract-change-${changedAt.replaceAll(":", "-")}`,
      now: changedAt,
    });
    setCaseRecord(revised);
    setContract(nextContract.id);
    setSide(nextSide);
    setParameters(Object.fromEntries(Object.entries(nextParameters).map(([id, value]) => [id, String(value)])));
    setDefinitionObjective(revised.core.definition.objective);
    setDefinitionConfirmedAt(null);
    if (nextContract.id === "american-put" && scheme === "explicit-euler") setScheme("rannacher-cn");
    if (!(model === "Heston" && nextContract.id === "european")
      && !(model === "Black–Scholes" && (nextContract.id === "european" || nextContract.id === "digital" || nextContract.id === "barrier"))
      && !((model === "Vasicek" || model === "Hull–White") && (nextContract.id === "zero-coupon-bond" || nextContract.id === "bond-option"))
      && !(model === "HJB" && nextContract.id === "merton-allocation")) {
      setMonteCarloEnabled(false);
    }
    setAppliedBridgeScenarioId(null);
    setBridgeCalibrationBase(null);
    setAppliedCpiScenario(null);
    setAppliedEconomicScenarioAt(null);
    clearCalculatedResult();
    const sideMessage = previousSide !== nextSide
      ? ` Option side changed from ${previousSide ?? "not applicable"} to ${nextSide ?? "not applicable"}.`
      : "";
    setDefinitionConsequence(`New contract revision created for ${nextContract.label}.${sideMessage} Scenarios were cleared and the definition must be saved again.`);
  };

  const setParameter = (id: string, value: string) => {
    setParameters((current) => ({ ...current, [id]: value }));
    setAppliedBridgeScenarioId(null);
    setBridgeCalibrationBase(null);
    setAppliedCpiScenario(null);
    setAppliedEconomicScenarioAt(null);
    clearCalculatedResult();
  };

  const applyEconomicScenario = (scenarioId = bridgeScenarioId) => {
    setTimelineMarketBaseOverride(null);
    setTimelineScenarioOverride(null);
    if (model === "HJB" && currentMarketSnapshot?.mertonOpportunity && !bridgeCalibrationBase) {
      const appliedAt = new Date().toISOString();
      const baseApplication = applySnapshot(parameters, currentMarketSnapshot, new Set(["expectedReturn", "volatility", "rate"]));
      const opportunityBridge = buildEconomicBridge(currentMarketSnapshot.mertonOpportunity.bridgeInput, "HJB", baseApplication.parameters);
      const opportunityScenario = opportunityBridge.scenarios.find((item) => item.id === scenarioId) ?? opportunityBridge.scenarios[0];
      const mappedParameterIds = new Set(opportunityScenario.transformations.map((item) => item.targetParameter).filter((id): id is string => Boolean(id)));
      const scenarioParameters = Object.fromEntries(opportunityScenario.transformations.flatMap((item) => item.targetParameter ? [[item.targetParameter, opportunityScenario.parameters[item.targetParameter] ?? item.mappedValue ?? ""]] : []));
      const caseScenario: CaseEconomicScenario = {
        model: "HJB",
        source: "economic-bridge",
        scenarioId: opportunityScenario.id,
        forecastRunId: null,
        mappingId: opportunityBridge.mappingId,
        mappingVersion: opportunityBridge.mappingVersion,
        scenarioMeasure: "P",
        baseMarketSnapshotId: currentMarketSnapshot.id,
        appliedAt,
        parameters: opportunityScenario.transformations.flatMap((item) => item.targetParameter ? [{
          id: item.targetParameter,
          baseValue: opportunityBridge.calibratedParameters[item.targetParameter] ?? "",
          scenarioValue: opportunityScenario.parameters[item.targetParameter] ?? item.mappedValue ?? "",
          targetMeasure: item.measure,
        }] : []),
      };
      const baseInputs: CaseInputs = {
        ...currentCaseInputs,
        marketBase: {
          model: "HJB",
          source: "snapshot",
          snapshotId: currentMarketSnapshot.id,
          applicationId: baseApplication.history.id,
          instrument: currentMarketSnapshot.instrument,
          currency: currentMarketSnapshot.currency,
          asOfDate: currentMarketSnapshot.asOfDate,
          measure: currentMarketSnapshot.measure,
          appliedAt: baseApplication.history.appliedAt,
          parameters: { ...baseApplication.parameters },
        },
        solverConfiguration: { ...currentCaseInputs.solverConfiguration, parameters: { ...baseApplication.parameters } },
      };
      setCaseRecord((current) => branchCaseWithEconomicScenario(
        synchroniseCaseInputs(current, baseInputs, { reason: "Apply opportunity-set market base", now: appliedAt }),
        caseScenario,
        scenarioParameters,
        { reason: `Create economic regime branch ${opportunityScenario.id}`, revisionId: `before-regime-${appliedAt.replaceAll(":", "-")}`, now: appliedAt },
      ));
      setBridgeCalibrationBase({ ...baseApplication.parameters });
      setParameters(Object.fromEntries(Object.entries(baseApplication.parameters).map(([id, value]) => [id, mappedParameterIds.has(id) ? String(opportunityScenario.parameters[id]) : value])));
      setMarketHistory((current) => current.some((item) => item.snapshot.id === currentMarketSnapshot.id && !item.restoredAt) ? current : [baseApplication.history, ...current]);
      setActiveMarketSnapshotId(currentMarketSnapshot.id);
      setBridgeScenarioId(opportunityScenario.id);
      setAppliedBridgeScenarioId(opportunityScenario.id);
      setAppliedEconomicScenarioAt(appliedAt);
      setLastRun("Economic regime branch created — solver has not been run");
      return;
    }
    const scenario = economicBridge.scenarios.find((item) => item.id === scenarioId) ?? selectedBridgeScenario;
    if (!scenario) return;
    const appliedAt = new Date().toISOString();
    if (!bridgeCalibrationBase) setBridgeCalibrationBase({ ...parameters });
    const mappedParameterIds = new Set(scenario.transformations
      .map((transformation) => transformation.targetParameter)
      .filter((id): id is string => Boolean(id)));
    const scenarioParameters = Object.fromEntries(scenario.transformations.flatMap((item) => item.targetParameter ? [[item.targetParameter, scenario.parameters[item.targetParameter] ?? item.mappedValue ?? ""]] : []));
    const caseScenario: CaseEconomicScenario = {
      model,
      source: "economic-bridge",
      scenarioId: scenario.id,
      forecastRunId: null,
      mappingId: economicBridge.mappingId,
      mappingVersion: economicBridge.mappingVersion,
      scenarioMeasure: "P",
      baseMarketSnapshotId: currentCaseInputs.marketBase.snapshotId,
      appliedAt,
      parameters: scenario.transformations.flatMap((item) => item.targetParameter ? [{
        id: item.targetParameter,
        baseValue: economicBridge.calibratedParameters[item.targetParameter] ?? "",
        scenarioValue: scenario.parameters[item.targetParameter] ?? item.mappedValue ?? "",
        targetMeasure: item.measure,
      }] : []),
    };
    setCaseRecord((current) => branchCaseWithEconomicScenario(
      synchroniseCaseInputs(current, currentCaseInputs, { reason: "Capture inputs before economic branch", now: appliedAt }),
      caseScenario,
      scenarioParameters,
      { reason: `Create economic scenario branch ${scenario.id}`, revisionId: `before-scenario-${appliedAt.replaceAll(":", "-")}`, now: appliedAt },
    ));
    setParameters((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => [
      id,
      mappedParameterIds.has(id) ? String(scenario.parameters[id]) : value,
    ])));
    setBridgeScenarioId(scenario.id);
    setAppliedBridgeScenarioId(scenario.id);
    setAppliedEconomicScenarioAt(appliedAt);
    setLastRun("Economic scenario branch created — solver has not been run");
  };

  const restoreCalibratedParameters = () => {
    if (!bridgeCalibrationBase) return;
    setTimelineMarketBaseOverride(null);
    setTimelineScenarioOverride(null);
    const restoredAt = new Date().toISOString();
    setCaseRecord((current) => branchCaseToMarketBase(
      synchroniseCaseInputs(current, currentCaseInputs, { reason: "Capture macro branch before restoration", now: restoredAt }),
      { reason: "Create base-only branch", revisionId: `before-base-${restoredAt.replaceAll(":", "-")}`, now: restoredAt },
    ));
    setParameters(Object.fromEntries(Object.entries(bridgeCalibrationBase).map(([id, value]) => [id, String(value)])));
    setAppliedBridgeScenarioId(null);
    setBridgeCalibrationBase(null);
    setAppliedCpiScenario(null);
    setAppliedEconomicScenarioAt(null);
    setLastRun("Base-only branch created — solver has not been run");
    setParameterUncertaintyResult(null);
    setParameterUncertaintyStage("Conditioning branch changed — rerun deterministic solver first");
  };

  const prepareMatchingBaseRun = () => {
    if (!currentCaseInputs.economicScenario) {
      selectCaseStage("solve");
      return;
    }
    const restoredAt = new Date().toISOString();
    const restoredParameters = { ...currentCaseInputs.solverConfiguration.parameters };
    currentCaseInputs.economicScenario.parameters.forEach((parameter) => {
      restoredParameters[parameter.id] = currentCaseInputs.marketBase.parameters[parameter.id] ?? parameter.baseValue;
    });
    setCaseRecord((current) => branchCaseToMarketBase(
      synchroniseCaseInputs(current, currentCaseInputs, { reason: "Capture scenario inputs before matching base run", now: restoredAt }),
      { reason: "Prepare matching base run", revisionId: `before-matching-base-${restoredAt.replaceAll(":", "-")}`, now: restoredAt },
    ));
    setParameters(Object.fromEntries(Object.entries(restoredParameters).map(([id, value]) => [id, String(value)])));
    setAppliedBridgeScenarioId(null);
    setBridgeCalibrationBase(null);
    setAppliedCpiScenario(null);
    setAppliedEconomicScenarioAt(null);
    setLastRun("Matching base inputs restored — approve the exact base inputs before running");
    selectCaseStage("condition");
  };

  const changeSide = (next: OptionSide) => {
    setSide(next);
    setDefinitionConfirmedAt(null);
    setDefinitionConsequence(`Option side changed to ${next}. Save the definition again before continuing.`);
    clearCalculatedResult();
  };

  const editDefinition = (
    field: "caseName" | "instrument" | "valuationDate" | "objective",
    value: string,
  ) => {
    if (field === "caseName") setCaseName(value);
    if (field === "instrument") {
      setDefinitionInstrument(value);
      setMarketRequest((current) => ({ ...current, instrument: value }));
    }
    if (field === "valuationDate") {
      setDefinitionValuationDate(value);
      setMarketRequest((current) => ({ ...current, asOfDate: value }));
    }
    if (field === "objective") setDefinitionObjective(value);
    setDefinitionConfirmedAt(null);
    setDefinitionConsequence("Definition changed. Review and save it before continuing.");
    clearCalculatedResult();
  };

  const confirmDefinition = () => {
    const confirmedAt = new Date().toISOString();
    const definition = { ...currentCaseInputs.definition, confirmedAt };
    if (validateCaseDefinition(definition).length > 0) return;
    setDefinitionConfirmedAt(confirmedAt);
    setCaseRecord((current) => synchroniseCaseInputs(current, {
      ...currentCaseInputs,
      definition,
    }, {
      reason: `Confirm problem definition for ${definition.caseName}`,
      revisionId: `definition-confirmed-${confirmedAt.replaceAll(":", "-")}`,
      now: confirmedAt,
    }));
    setDefinitionConsequence(`Definition saved as a case revision. ${definition.model} · ${definition.contractLabel} · ${definition.measure}-measure.`);
  };

  const currentBlackScholesRequest = (): BlackScholesProductSolveRequest => ({
    spot: Number(parameters.spot),
    strike: Number(parameters.strike),
    maturity: Number(parameters.maturity),
    rate: Number(parameters.rate),
    dividend: Number(parameters.dividend),
    volatility: Number(parameters.volatility),
    side: displaySide as "Call" | "Put",
    contract: contract as BlackScholesContract,
    barrier: contract === "barrier" ? Number(parameters.barrier) : undefined,
    barrierDirection: (barrierType === "Up & out" ? "up-and-out" : "down-and-out") as BarrierDirection,
    spaceSteps: Number(spaceSteps),
    timeSteps: Number(timeSteps),
    scheme: scheme as Scheme,
    gridKind,
  });

  const currentShortRateRequest = (): ShortRateSolveRequest => ({
    model: model as "Vasicek" | "Hull–White",
    contract: contract as "zero-coupon-bond" | "bond-option",
    shortRate: Number(parameters.shortRate),
    meanReversion: Number(parameters.meanReversion),
    longRunRate: model === "Vasicek" ? Number(parameters.longRunRate) : undefined,
    rateVolatility: Number(parameters.rateVolatility),
    maturity: Number(parameters.maturity),
    bondMaturity: contract === "bond-option" ? Number(parameters.bondMaturity) : undefined,
    strike: contract === "bond-option" ? Number(parameters.strike) : undefined,
    curveId: model === "Hull–White" ? parameters.curveId : undefined,
    discountCurve: model === "Hull–White" && activeMarketApplication?.snapshot.hullWhite
      ? activeMarketApplication.snapshot.hullWhite.curve
      : undefined,
    spaceSteps: Number(spaceSteps),
    timeSteps: Number(timeSteps),
    scheme: scheme as Scheme,
    gridKind,
  });

  const currentHestonRequest = (): HestonSolveRequest => ({
    spot: Number(parameters.spot),
    strike: Number(parameters.strike),
    maturity: Number(parameters.maturity),
    rate: Number(parameters.rate),
    dividend: Number(parameters.dividend),
    v0: Number(parameters.v0),
    kappa: Number(parameters.kappa),
    theta: Number(parameters.theta),
    xi: Number(parameters.xi),
    rho: Number(parameters.rho),
    side: displaySide as "Call" | "Put",
    spaceSteps: Number(spaceSteps),
    varianceSteps: Number(varianceSteps),
    timeSteps: Number(timeSteps),
    scheme: scheme as HestonScheme,
    gridKind,
  });

  const currentMertonRequest = (): MertonSolveRequest => ({
    wealth: Number(parameters.wealth),
    maturity: Number(parameters.maturity),
    rate: Number(parameters.rate),
    expectedReturn: Number(parameters.expectedReturn),
    volatility: Number(parameters.volatility),
    riskAversion: Number(parameters.riskAversion),
    controlMin: Number(parameters.controlMin),
    controlMax: Number(parameters.controlMax),
    spaceSteps: Number(spaceSteps),
    timeSteps: Number(timeSteps),
    gridKind,
  });

  const runParameterUncertainty = () => {
    if (parameterUncertaintyRunning) {
      const jobId = parameterUncertaintyJobIdRef.current;
      parameterUncertaintyWorkerRef.current?.postMessage({ type: "cancel", jobId } satisfies ParameterUncertaintyWorkerRequest);
      setParameterUncertaintyStage("Cancellation requested; previous result retained");
      return;
    }
    if (parameterUncertaintyLockedReason || !appliedCpiScenario || !solverResult) return;
    const worker = parameterUncertaintyWorkerRef.current;
    if (!worker) {
      setParameterUncertaintyError("The parameter-propagation worker is still starting.");
      return;
    }
    const baseOverrides = Object.fromEntries(appliedCpiScenario.affectedParameters.map((item) => [item.id, Number(item.baseValue)]));
    const baseJob: SolverJob = model === "Black–Scholes"
      ? { model, request: { ...currentBlackScholesRequest(), ...baseOverrides } }
      : model === "Heston"
        ? { model, request: { ...currentHestonRequest(), ...baseOverrides } }
        : model === "HJB"
          ? { model, request: { ...currentMertonRequest(), ...baseOverrides } }
          : { model, request: { ...currentShortRateRequest(), ...baseOverrides } };
    const request: ParameterUncertaintyRequest = {
      snapshot: economicForecast,
      baseJob,
      config: {
        sampleBudget: Number(parameterUncertaintyBudget),
        seed: 20260824,
        outputHistogramBins: 24,
      },
      convergenceGate: {
        accepted: withinTolerance && runWarnings.length === 0,
        source: "current deterministic PDE result",
        pointwiseError: absoluteError,
        maxNormError: solverResult.maxNormError,
        domainExpansionDelta,
        observedOrder: latestObservedOrder ?? null,
      },
    };
    const jobId = parameterUncertaintyJobIdRef.current + 1;
    parameterUncertaintyJobIdRef.current = jobId;
    setParameterUncertaintyRunning(true);
    setParameterUncertaintyProgress(2);
    setParameterUncertaintyStage("Queued deterministic parameter propagation");
    setParameterUncertaintyError(null);
    setParameterUncertaintyCacheHit(false);
    worker.postMessage({ type: "run", jobId, request } satisfies ParameterUncertaintyWorkerRequest);
  };

  const runSolver = () => {
    const compatibilityIssues = getCaseModelCompatibilityIssues(liveCaseRecord.core);
    if (compatibilityIssues.length > 0) {
      setSolverError(`Solver execution blocked: ${compatibilityIssues.join(" ")}`);
      return;
    }
    if (running || validationIssues.length > 0 || !caseExecutionReady || !solverAvailable) return;
    const solverWorker = workerRef.current;
    if (!solverWorker) {
      setSolverError("The background solver is still starting. Try again in a moment.");
      return;
    }
    setRunning(true);
    setProgress(4);
    setWorkerStage("Queued in background worker");
    setSolverError(null);
    const baseJob: SolverJob = model === "Black–Scholes"
      ? {
          model,
          request: currentBlackScholesRequest(),
          ...(monteCarloEnabled && monteCarloEligible ? { monteCarlo: {
            model: "Black–Scholes" as const,
            enabled: true,
            paths: Number(monteCarloPaths),
            timeSteps: Number(monteCarloTimeSteps),
            seed: Number(monteCarloSeed),
            scheme: "exact-gbm" as const,
            displayPathLimit: MONTE_CARLO_DISPLAY_PATH_LIMIT,
            quantileLevels: MONTE_CARLO_QUANTILES,
          } } : {}),
        }
      : model === "Heston"
        ? {
            model,
            request: currentHestonRequest(),
            ...(monteCarloEnabled && monteCarloEligible ? { monteCarlo: {
              model: "Heston" as const,
              enabled: true,
              paths: Number(monteCarloPaths),
              timeSteps: Number(monteCarloTimeSteps),
              seed: Number(monteCarloSeed),
              scheme: "andersen-qe" as const,
              displayPathLimit: MONTE_CARLO_DISPLAY_PATH_LIMIT,
              quantileLevels: MONTE_CARLO_QUANTILES,
              varianceReduction: "antithetic" as const,
            } } : {}),
          }
        : model === "HJB"
          ? {
              model,
              request: currentMertonRequest(),
              ...(monteCarloEnabled && monteCarloEligible ? { monteCarlo: {
                model: "HJB" as const,
                enabled: true,
                paths: Number(monteCarloPaths),
                timeSteps: Number(monteCarloTimeSteps),
                seed: Number(monteCarloSeed),
                scheme: "feedback-policy-euler" as const,
                displayPathLimit: MONTE_CARLO_DISPLAY_PATH_LIMIT,
                quantileLevels: MONTE_CARLO_QUANTILES,
              } } : {}),
            }
          : {
              model,
              request: currentShortRateRequest(),
              ...(monteCarloEnabled && monteCarloEligible ? { monteCarlo: {
                model,
                enabled: true,
                paths: Number(monteCarloPaths),
                timeSteps: Number(monteCarloTimeSteps),
                seed: Number(monteCarloSeed),
                scheme: "exact-gaussian" as const,
                displayPathLimit: MONTE_CARLO_DISPLAY_PATH_LIMIT,
                quantileLevels: MONTE_CARLO_QUANTILES,
              } } : {}),
            };
    const job: SolverJob = activeScenarioIdentity ? { ...baseJob, scenarioIdentity: activeScenarioIdentity } : baseJob;
    const jobId = activeJobIdRef.current + 1;
    activeJobIdRef.current = jobId;
    activeRunDefinitionRef.current = { model, contractId: contract };
    setCaseRecord((current) => queueCaseRun(
      synchroniseCaseInputs(current, currentCaseInputs, { reason: "Capture solver inputs before execution" }),
      { id: `solver-job-${jobId}`, execution: "worker" },
    ));
    if (activeMarketSnapshotId) {
      const runId = `solver-job-${jobId}`;
      setMarketHistory((current) => current.map((item) => item.snapshot.id === activeMarketSnapshotId && !item.restoredAt
        ? { ...item, associatedSolverRunIds: item.associatedSolverRunIds.includes(runId) ? item.associatedSolverRunIds : [...item.associatedSolverRunIds, runId] }
        : item));
    }
    const request: SolverWorkerRequest = { type: "run", jobId, job };
    solverWorker.postMessage(request);
  };

  const cancelSolver = () => {
    const cancelledJobId = activeJobIdRef.current;
    workerRef.current?.postMessage({ type: "cancel", jobId: cancelledJobId } satisfies SolverWorkerRequest);
    setCaseRecord((current) => finishCaseRun(current, `solver-job-${cancelledJobId}`, "cancelled", {}));
    activeJobIdRef.current += 1;
    setWorkerGeneration((current) => current + 1);
    setRunning(false);
    setProgress(100);
    setWorkerStage("Background job cancelled");
    setLastRun("Run cancelled — previous completed result retained");
  };

  const downloadBlob = (contents: string, type: string, filename: string, fileType: DownloadArtifact["fileType"]): DownloadArtifact => {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    return { filename, fileType };
  };

  const exportRun = () => {
    const payload = {
      case: {
        schemaVersion: liveCaseRecord.schemaVersion,
        id: liveCaseRecord.id,
        createdAt: liveCaseRecord.createdAt,
        updatedAt: liveCaseRecord.updatedAt,
        core: liveCaseRecord.core,
        readiness: caseReadiness,
        revisionIds: liveCaseRecord.revisions.map((revision) => revision.id),
      },
      model,
      measure: config.measure,
      contract: contractSpec,
      side: displaySide ?? null,
      parameters,
      grid: { spaceSteps, varianceSteps: isHestonModel ? varianceSteps : undefined, timeSteps, scheme, gridKind, rannacherHalfSteps: scheme === "rannacher-cn" ? 4 : 0 },
      results: solverResult ? {
        pde: basePrice,
        benchmark,
        absoluteError,
        relativeError: solverResult.relativeError,
        maxNormError: solverResult.maxNormError,
        l2Error: solverResult.l2Error,
        diagnostics: solverResult.solution.diagnostics,
        convergence,
        domainExpansionDelta,
      } : null,
      ...(monteCarloResult ? { monteCarlo: createMonteCarloManifest(monteCarloResult) } : {}),
      ...(parameterUncertaintyResult ? { parameterUncertainty: parameterUncertaintyResult } : {}),
      acceptance: contractSpec.tolerance,
      validation: { issues: validationIssues, warnings },
      economicBridge: {
        runClassification: appliedBridgeScenarioId ? "macro-conditioned scenario" : isHjbModel ? "historical" : "market-calibrated",
        appliedScenarioId: appliedBridgeScenarioId,
        calibratedParameters: economicBridge.calibratedParameters,
        audit: economicBridge.audit,
        mapping: { id: economicBridge.mappingId, version: economicBridge.mappingVersion },
        scenarios: economicBridge.scenarios,
        sourceForecast: appliedCpiScenario ? {
          runId: appliedCpiScenario.forecastRunId,
          targetDate: appliedCpiScenario.sourceTargetDate,
          availabilityDate: appliedCpiScenario.sourceAvailabilityDate,
          distributionMethod: appliedCpiScenario.distributionMethod,
          distributionMethodVersion: appliedCpiScenario.distributionMethodVersion,
          distributionSeed: appliedCpiScenario.distributionSeed,
          mappingVersion: appliedCpiScenario.mappingVersion,
          scenarioInputs: appliedCpiScenario.scenarioInputs,
        } : null,
      },
      marketData: activeMarketSnapshotId ? {
        activeSnapshotId: activeMarketSnapshotId,
        snapshot: activeMarketApplication?.snapshot ?? null,
        application: activeMarketApplication,
      } : null,
      historicalRateScenarios: vasicekHistoricalScenarios,
      status: solverResult ? `${phaseLabel} calculated and benchmarked` : "No calculated result for the current inputs",
    };
    const runId = (decideRun?.id ?? "case").replaceAll(/[^a-zA-Z0-9_-]/g, "-");
    return downloadBlob(JSON.stringify({ ...payload, execution: { mode: lastExecution, cached: lastExecution === "cache" } }, null, 2), "application/json", `pde-run-manifest-${runId}.json`, "JSON");
  };

  const exportResults = () => {
    if (!solverResult) throw new Error("No result data is available for CSV export.");
    const escapeCsv = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
    const rows: Array<Array<string | number>> = monteCarloResult
      ? [[...MONTE_CARLO_CSV_COLUMNS]]
      : [["model", "state", "secondary_state", "finite_difference", "benchmark"]];
    if (monteCarloResult) {
      if (isHestonResult(solverResult)) {
        solverResult.solution.varianceNodes.forEach((variance, varianceIndex) => {
          solverResult.solution.spotNodes.forEach((spot, spotIndex) => {
            rows.push(["pde-grid", model, spot, variance, solverResult.solution.values[varianceIndex][spotIndex], "", "", "", "value", ""]);
          });
        });
      } else {
        solverResult.solution.nodes.forEach((node, index) => {
          rows.push(["pde-grid", model, node, "", solverResult.solution.values[index], solverResult.analyticValues[index] ?? "", "", "", "value", ""]);
        });
      }
      rows.push(...createMonteCarloCsvRows(monteCarloResult));
    } else if (isHestonResult(solverResult)) {
      solverResult.solution.varianceNodes.forEach((variance, varianceIndex) => {
        solverResult.solution.spotNodes.forEach((spot, spotIndex) => {
          rows.push([model, spot, variance, solverResult.solution.values[varianceIndex][spotIndex], ""]);
        });
      });
    } else {
      solverResult.solution.nodes.forEach((node, index) => {
        rows.push([model, node, "", solverResult.solution.values[index], solverResult.analyticValues[index] ?? ""]);
      });
    }
    if (appliedCpiScenario) {
      const scenarioMetadata = {
        forecastRunId: appliedCpiScenario.forecastRunId,
        distributionMethod: appliedCpiScenario.distributionMethod,
        distributionMethodVersion: appliedCpiScenario.distributionMethodVersion,
        distributionSeed: appliedCpiScenario.distributionSeed,
        mappingVersion: appliedCpiScenario.mappingVersion,
        scenarioInputs: appliedCpiScenario.scenarioInputs,
      };
      Object.entries(scenarioMetadata).forEach(([key, value]) => rows.push(["scenario-metadata", key, "", typeof value === "object" ? JSON.stringify(value) : value, ""]));
    }
    if (parameterUncertaintyResult) {
      rows.push(["parameter-uncertainty-metadata", "method", "", `${parameterUncertaintyResult.method}@${parameterUncertaintyResult.methodVersion}`, ""]);
      parameterUncertaintyResult.traces.forEach((trace) => rows.push([
        "parameter-uncertainty-trace",
        trace.sampleIndex,
        trace.cpiOutcomePct,
        trace.mappedParameterValue,
        trace.deterministicOutput,
        trace.policyRateScenario,
        trace.targetParameter,
        String(trace.mappingClamped),
        trace.traceId,
        trace.mappingVersion,
      ]));
    }
    const runId = (decideRun?.id ?? "case").replaceAll(/[^a-zA-Z0-9_-]/g, "-");
    return downloadBlob(rows.map((row) => row.map(escapeCsv).join(",")).join("\n"), "text/csv;charset=utf-8", `pde-results-${runId}.csv`, "CSV");
  };

  const activeStageStatus = activeStage === "define" ? caseReadiness.definition
    : activeStage === "condition" ? caseReadiness.conditioning
      : activeStage === "solve" ? caseReadiness.solve
        : caseReadiness.decide;
  const caseNextAction = activeStage === "define"
    ? caseReadiness.definition !== "complete"
      ? { message: definitionIssues[0] ?? "Complete the problem definition.", actionLabel: "Review definition", disabled: false, running: false, onAction: () => document.querySelector<HTMLInputElement>('[aria-label="Case name"]')?.focus() }
      : { message: "The problem is defined. Review the information that will condition the solver.", actionLabel: "Continue to Condition", disabled: false, running: false, onAction: () => selectCaseStage("condition") }
    : activeStage === "condition"
      ? caseReadiness.conditioning !== "complete"
        ? { message: caseReadiness.blockingReasons[0] ?? "Review the conditioning inputs.", actionLabel: "Review market base", disabled: false, running: false, onAction: () => openWorkspace("market-data") }
        : { message: "The market base and scenario are connected to this case.", actionLabel: "Continue to Solve", disabled: false, running: false, onAction: () => selectCaseStage("solve") }
      : activeStage === "solve"
        ? running
          ? { message: `${workerStage} · ${progress}% complete`, actionLabel: "Cancel run", disabled: false, running: true, onAction: cancelSolver }
          : validationIssues.length > 0
            ? { message: validationIssues[0], actionLabel: "Review solver controls", disabled: false, running: false, onAction: openParameterControls }
            : caseReadiness.resultState === "current"
              ? { message: `A current result is available. Numerical acceptance: ${caseReadiness.status.labels.numericalAcceptance}.`, actionLabel: "Review result", disabled: false, running: false, onAction: () => openWorkspace("results") }
              : { message: solverAvailable ? "The case is ready to execute with the current configuration." : "This product engine is specified for a later solver phase.", actionLabel: solverAvailable ? "Run case" : "Solver unavailable", disabled: !solverAvailable, running: false, onAction: runSolver }
        : caseReadiness.resultState === "current"
          ? { message: "The current result matches the displayed case inputs.", actionLabel: "Open case timeline", disabled: false, running: false, onAction: () => setTimelineOpen(true) }
          : { message: caseReadiness.staleReasons[0] ?? "Run the current case before making a decision.", actionLabel: "Return to Solve", disabled: false, running: false, onAction: () => selectCaseStage("solve") };

  function openParameterControls() {
    setSidebarCollapsed(false);
    if (window.matchMedia("(max-width: 800px)").matches) setControlsOpen(true);
  }

  return (
    <main
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      data-case-id={liveCaseRecord.id}
      data-case-result-state={caseReadiness.resultState}
      data-result-freshness={caseReadiness.status.resultFreshness}
      data-workflow-progress={caseReadiness.status.workflowProgress}
      data-numerical-acceptance={caseReadiness.status.numericalAcceptance}
    >
      {controlsOpen && <button className="sidebar-backdrop" aria-label="Close parameter controls" onClick={() => setControlsOpen(false)} />}
      <aside ref={sidebarRef} className={`sidebar ${controlsOpen ? "open" : ""}`} aria-label="Model and numerical controls">
        <div className="brand">
          <div className="brand-mark">∂</div>
          <div className="brand-copy">
            <strong>PDE Studio</strong>
            <span>Numerical pricing lab</span>
          </div>
          <span className="version">v0.1</span>
          <button
            type="button"
            className="sidebar-collapse-toggle"
            aria-label={sidebarCollapsed ? "Expand PDE Studio controls" : "Collapse PDE Studio controls"}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
          <button ref={sidebarCloseRef} type="button" className="sidebar-close" aria-label="Close parameter controls" onClick={() => setControlsOpen(false)}>×</button>
        </div>

        <div className="sidebar-scroll">
          <section className="control-section">
            <div className="section-heading">
              <ControlHelpLabel label="Governing model" help={{ ...SOLVER_CONTROL_HELP.governingModel, description: `${config.description}. ${SOLVER_CONTROL_HELP.governingModel.description}` }} />
              <span className="section-index">01</span>
            </div>
            <div className="model-grid">
              {MODEL_KEYS.map((item) => (
                <button
                  key={item}
                  className={`model-button ${model === item ? "active" : ""}`}
                  onClick={() => changeModel(item)}
                  aria-pressed={model === item}
                >
                  <span>{MODEL_SPECS[item].short}</span>
                  {item}
                </button>
              ))}
            </div>
          </section>

          {activeWorkspace === "solver-studio" ? <section className="control-section stage-sidebar-guidance">
            <div className="section-heading"><span>Solve stage</span><span className="section-index">02</span></div>
            <p>The complete model inputs, numerical controls, validation and Run case action are now in the Solve workspace.</p>
          </section> : activeWorkspace === "market-data" ? <>
            <section className="control-section market-sidebar-section">
              <div className="section-heading"><span>{getMarketAdapter(model).workspaceLabel}</span><span className="section-index">02</span></div>
              <div className="field full">
                <ControlHelpLabel label="Data mode" help={MARKET_CONTROL_HELP.dataMode} />
                <select aria-label="Data mode" value={marketRequest.sourceMode} onChange={(event) => setMarketRequest((current) => ({ ...current, sourceMode: event.target.value as "fixture" | "live" }))}>
                  <option value="fixture">Deterministic fixture</option>
                  <option value="live">Live providers</option>
                </select>
              </div>
              {model !== "Vasicek" && model !== "Hull–White" && <div className="field full">
                <ControlHelpLabel label={isShortRateModel ? "Series / currency" : "Symbol"} help={MARKET_CONTROL_HELP.symbol} />
                <input aria-label="Market symbol" value={marketRequest.instrument} onChange={(event) => setMarketRequest((current) => ({ ...current, instrument: event.target.value.toUpperCase() }))} />
              </div>}
              <div className="field-row">
                <div className="field"><ControlHelpLabel label="As-of date" help={MARKET_CONTROL_HELP.asOfDate} /><input aria-label="As-of date" type="date" value={marketRequest.asOfDate} onChange={(event) => setMarketRequest((current) => ({ ...current, asOfDate: event.target.value }))} /></div>
                <div className="field"><ControlHelpLabel label="Currency" help={MARKET_CONTROL_HELP.currency} /><input aria-label="Currency" value={marketRequest.currency} onChange={(event) => setMarketRequest((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} /></div>
              </div>
              {model === "Black–Scholes" ? <div className="equity-snapshot-controls">
                <div className="field full">
                  <ControlHelpLabel label="Option expiration" help={MARKET_CONTROL_HELP.optionExpiration} />
                  <select aria-label="Option expiration" value={marketRequest.optionExpiration} onChange={(event) => setMarketRequest((current) => ({ ...current, optionExpiration: event.target.value }))}>
                    {!currentMarketSnapshot?.blackScholes?.availableExpirations.includes(marketRequest.optionExpiration) && <option value={marketRequest.optionExpiration}>{marketRequest.optionExpiration || "Nearest listed expiry"}</option>}
                    {(currentMarketSnapshot?.blackScholes?.availableExpirations ?? []).map((expiration) => <option key={expiration} value={expiration}>{expiration}</option>)}
                  </select>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Option view" help={MARKET_CONTROL_HELP.optionView} /><select aria-label="Option view" value={marketRequest.optionView} onChange={(event) => setMarketRequest((current) => ({ ...current, optionView: event.target.value as MarketDataRequest["optionView"] }))}><option value="combined">Calls + puts</option><option value="calls">Calls</option><option value="puts">Puts</option></select></div>
                  <div className="field"><ControlHelpLabel label="ATM method" help={MARKET_CONTROL_HELP.atmMethod} /><select aria-label="ATM method" value={marketRequest.atmMethod} disabled><option value="forward-log-moneyness">Forward |ln(K/F)|</option></select></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Maximum spread" help={MARKET_CONTROL_HELP.maximumSpread} /><span className="input-shell"><input aria-label="Maximum spread" type="number" min="0.01" max="1" step="0.01" value={marketRequest.maximumRelativeSpread} onChange={(event) => setMarketRequest((current) => ({ ...current, maximumRelativeSpread: Number(event.target.value) }))} /><small>{(marketRequest.maximumRelativeSpread * 100).toFixed(0)}%</small></span></div>
                  <div className="field"><ControlHelpLabel label="Minimum open interest" help={MARKET_CONTROL_HELP.minimumOpenInterest} /><input aria-label="Minimum open interest" type="number" min="0" step="1" value={marketRequest.minimumOpenInterest} onChange={(event) => setMarketRequest((current) => ({ ...current, minimumOpenInterest: Number(event.target.value) }))} /></div>
                </div>
                <div className="field full">
                  <ControlHelpLabel label="Dividend method" help={MARKET_CONTROL_HELP.dividendMethod} />
                  <select aria-label="Dividend method" value={marketRequest.dividendMethod} onChange={(event) => setMarketRequest((current) => ({ ...current, dividendMethod: event.target.value as MarketDataRequest["dividendMethod"] }))}>
                    <option value="parity">Put-call parity · fallback to distributions</option>
                    <option value="distributions">Trailing cash distributions</option>
                    <option value="manual">Keep manual q</option>
                  </select>
                </div>
                <div className="market-rate-policy"><b>RATE CURVE</b><span>SOFR + Treasury tenors bracketing expiration</span><small>Continuously compounded USD proxy · never labelled OIS</small></div>
              </div> : model === "Heston" ? <div className="equity-snapshot-controls heston-surface-controls">
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="First expiration" help={MARKET_CONTROL_HELP.firstExpiration} /><input aria-label="First expiration" type="date" min={marketRequest.asOfDate} value={marketRequest.hestonExpirationStart} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonExpirationStart: event.target.value }))} /></div>
                  <div className="field"><ControlHelpLabel label="Last expiration" help={MARKET_CONTROL_HELP.lastExpiration} /><input aria-label="Last expiration" type="date" min={marketRequest.hestonExpirationStart} value={marketRequest.hestonExpirationEnd} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonExpirationEnd: event.target.value }))} /></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Minimum ln(K/F)" help={MARKET_CONTROL_HELP.minimumMoneyness} /><input aria-label="Minimum log moneyness" type="number" step="0.01" min="-1" max="0" value={marketRequest.hestonMoneynessMinimum} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonMoneynessMinimum: Number(event.target.value) }))} /></div>
                  <div className="field"><ControlHelpLabel label="Maximum ln(K/F)" help={MARKET_CONTROL_HELP.maximumMoneyness} /><input aria-label="Maximum log moneyness" type="number" step="0.01" min="0" max="1" value={marketRequest.hestonMoneynessMaximum} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonMoneynessMaximum: Number(event.target.value) }))} /></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Maximum spread" help={MARKET_CONTROL_HELP.maximumSpread} /><span className="input-shell"><input aria-label="Maximum spread" type="number" min="0.01" max="1" step="0.01" value={marketRequest.maximumRelativeSpread} onChange={(event) => setMarketRequest((current) => ({ ...current, maximumRelativeSpread: Number(event.target.value) }))} /><small>{(marketRequest.maximumRelativeSpread * 100).toFixed(0)}%</small></span></div>
                  <div className="field"><ControlHelpLabel label="Minimum open interest" help={MARKET_CONTROL_HELP.minimumOpenInterest} /><input aria-label="Minimum open interest" type="number" min="0" step="1" value={marketRequest.minimumOpenInterest} onChange={(event) => setMarketRequest((current) => ({ ...current, minimumOpenInterest: Number(event.target.value) }))} /></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Minimum strikes" help={MARKET_CONTROL_HELP.minimumStrikes} /><input aria-label="Minimum strikes" type="number" min="3" step="1" value={marketRequest.hestonMinimumStrikes} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonMinimumStrikes: Number(event.target.value) }))} /></div>
                  <div className="field"><ControlHelpLabel label="Minimum expiries" help={MARKET_CONTROL_HELP.minimumExpiries} /><input aria-label="Minimum expiries" type="number" min="2" step="1" value={marketRequest.hestonMinimumExpiries} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonMinimumExpiries: Number(event.target.value) }))} /></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Calibration objective" help={MARKET_CONTROL_HELP.calibrationObjective} /><select aria-label="Calibration objective" value={marketRequest.hestonObjective} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonObjective: event.target.value as MarketDataRequest["hestonObjective"] }))}><option value="iv">Weighted IV error</option><option value="price">Weighted price error</option></select></div>
                  <div className="field"><ControlHelpLabel label="Multi-starts" help={MARKET_CONTROL_HELP.multiStarts} /><input aria-label="Calibration multi-starts" type="number" min="1" max="12" step="1" value={marketRequest.hestonMultiStarts} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonMultiStarts: Number(event.target.value) }))} /></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Maximum evaluations" help={MARKET_CONTROL_HELP.maximumEvaluations} /><input aria-label="Maximum calibration evaluations" type="number" min="50" max="2000" step="10" value={marketRequest.hestonMaximumEvaluations} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonMaximumEvaluations: Number(event.target.value) }))} /></div>
                  <div className="field"><ControlHelpLabel label="Calibration seed" help={MARKET_CONTROL_HELP.calibrationSeed} /><input aria-label="Calibration seed" type="number" min="0" step="1" value={marketRequest.hestonCalibrationSeed} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonCalibrationSeed: Number(event.target.value) }))} /></div>
                </div>
                <div className="market-check-row"><input aria-label="Open-interest weighting" type="checkbox" checked={marketRequest.hestonUseOpenInterest} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonUseOpenInterest: event.target.checked }))} /><span><b><ControlHelpLabel label="Open-interest weighting" help={MARKET_CONTROL_HELP.openInterestWeighting} /></b><small>Multiply spread-aware weights by √OI</small></span></div>
                <div className="market-check-row"><input aria-label="VIXCLS regime prior" type="checkbox" checked={marketRequest.hestonIncludeVix} onChange={(event) => setMarketRequest((current) => ({ ...current, hestonIncludeVix: event.target.checked }))} /><span><b><ControlHelpLabel label="VIXCLS regime prior" help={MARKET_CONTROL_HELP.vixPrior} /></b><small>Loaded only for relevant US broad-market indices</small></span></div>
                <div className="market-rate-policy"><b>EXPIRY CURVES</b><span>Separate FRED tenor interpolation per retained expiration</span><small>Treasury proxy · continuous decimal · never a direct Heston parameter</small></div>
                <div className={`calibration-mini-status ${hestonCalibrating ? "running" : ""}`}><i />{hestonCalibrationStatus}</div>
              </div> : model === "Vasicek" ? <div className="equity-snapshot-controls vasicek-rate-controls">
                <div className="field full">
                  <ControlHelpLabel label="FRED policy-rate series" help={MARKET_CONTROL_HELP.fredPolicySeries} />
                  <select aria-label="FRED policy-rate series" value={marketRequest.fredSeries} onChange={(event) => setMarketRequest((current) => ({ ...current, fredSeries: event.target.value, instrument: event.target.value }))}>
                    <option value="SOFR">SOFR · Secured Overnight Financing Rate</option>
                    <option value="DFF">DFF · Effective federal funds rate</option>
                  </select>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Window start" help={MARKET_CONTROL_HELP.windowStart} /><input aria-label="Vasicek window start" type="date" max={marketRequest.vasicekWindowEnd} value={marketRequest.vasicekWindowStart} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekWindowStart: event.target.value }))} /></div>
                  <div className="field"><ControlHelpLabel label="Window end" help={MARKET_CONTROL_HELP.windowEnd} /><input aria-label="Vasicek window end" type="date" min={marketRequest.vasicekWindowStart} max={marketRequest.asOfDate} value={marketRequest.vasicekWindowEnd} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekWindowEnd: event.target.value }))} /></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Sampling" help={MARKET_CONTROL_HELP.sampling} /><select aria-label="Vasicek sampling" value={marketRequest.vasicekSampling} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekSampling: event.target.value as MarketDataRequest["vasicekSampling"] }))}><option value="daily">Daily</option><option value="weekly">Weekly · last observation</option></select></div>
                  <div className="field"><ControlHelpLabel label="Measure mode" help={MARKET_CONTROL_HELP.measureMode} /><select aria-label="Vasicek measure mode" value={marketRequest.vasicekMeasureMode} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekMeasureMode: event.target.value as MarketDataRequest["vasicekMeasureMode"] }))}><option value="historical-p">Historical P fit</option><option value="q-curve">Q curve calibration</option></select></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Missing days" help={MARKET_CONTROL_HELP.missingDays} /><select aria-label="Missing days policy" value={marketRequest.vasicekMissingPolicy} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekMissingPolicy: event.target.value as MarketDataRequest["vasicekMissingPolicy"] }))}><option value="previous-valid">Previous valid</option><option value="drop-gaps">Drop gap transitions</option></select></div>
                  <div className="field"><ControlHelpLabel label="Outlier policy" help={MARKET_CONTROL_HELP.outlierPolicy} /><select aria-label="Outlier policy" value={marketRequest.vasicekOutlierPolicy} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekOutlierPolicy: event.target.value as MarketDataRequest["vasicekOutlierPolicy"] }))}><option value="remove-3sigma">Remove beyond 3σ</option><option value="winsorize-3sigma">Winsorize at 3σ</option><option value="none">Keep all</option></select></div>
                </div>
                <div className="field full"><ControlHelpLabel label="Minimum observations" help={MARKET_CONTROL_HELP.minimumObservations} /><input aria-label="Minimum Vasicek observations" type="number" min="20" step="10" value={marketRequest.vasicekMinimumObservations} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekMinimumObservations: Number(event.target.value) }))} /></div>
                <div className="market-check-row"><input aria-label="SHY IEF TLT overlays" type="checkbox" checked={marketRequest.vasicekIncludeEtfs} onChange={(event) => setMarketRequest((current) => ({ ...current, vasicekIncludeEtfs: event.target.checked }))} /><span><b><ControlHelpLabel label="SHY · IEF · TLT overlays" help={MARKET_CONTROL_HELP.etfOverlays} /></b><small>Direction and duration validation only · PROXY</small></span></div>
                <div className="market-rate-policy"><b>MEASURE GUARD</b><span>Historical SOFR/DFF fits estimate P dynamics</span><small>P scenarios remain separate; only documented curve calibration applies Q parameters</small></div>
              </div> : model === "Hull–White" ? <div className="equity-snapshot-controls hull-white-curve-controls">
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Curve mode" help={MARKET_CONTROL_HELP.curveMode} /><select aria-label="Hull-White curve mode" value={marketRequest.hullWhiteCurveMode} onChange={(event) => setMarketRequest((current) => ({ ...current, hullWhiteCurveMode: event.target.value as MarketDataRequest["hullWhiteCurveMode"] }))}><option value="treasury-proxy">Treasury zero proxy</option><option value="bootstrap">Documented bootstrap</option></select></div>
                  <div className="field"><ControlHelpLabel label="Curve family" help={MARKET_CONTROL_HELP.curveFamily} /><select aria-label="Hull-White curve family" value={marketRequest.hullWhiteCurveFamily} onChange={(event) => setMarketRequest((current) => {
                    const family = event.target.value as MarketDataRequest["hullWhiteCurveFamily"];
                    const selected = family === "sofr-treasury" ? [...new Set(["SOFR", ...current.hullWhiteSelectedSeries])] : [...new Set(["DGS1MO", ...current.hullWhiteSelectedSeries.filter((item) => item !== "SOFR")])];
                    return { ...current, hullWhiteCurveFamily: family, hullWhiteSelectedSeries: selected };
                  })}><option value="sofr-treasury">SOFR front + Treasury</option><option value="treasury">Treasury only</option></select></div>
                </div>
                <div className="field full"><ControlHelpLabel label="Interpolation" help={MARKET_CONTROL_HELP.interpolation} /><select aria-label="Hull-White curve interpolation" value={marketRequest.hullWhiteInterpolation} disabled><option value="natural-cubic-log-discount">Natural cubic · log discount</option></select></div>
                <fieldset className="curve-tenor-picker">
                  <legend><ControlHelpLabel label="FRED tenors" help={MARKET_CONTROL_HELP.fredTenors} /></legend>
                  <div>{HULL_WHITE_SERIES.filter((series) => marketRequest.hullWhiteCurveFamily === "sofr-treasury" || series.id !== "SOFR").map((series) => {
                    const requiredFront = series.id === (marketRequest.hullWhiteCurveFamily === "sofr-treasury" ? "SOFR" : "DGS1MO");
                    return <label key={series.id}><input type="checkbox" checked={marketRequest.hullWhiteSelectedSeries.includes(series.id)} disabled={requiredFront} onChange={(event) => setMarketRequest((current) => ({ ...current, hullWhiteSelectedSeries: event.target.checked ? [...new Set([...current.hullWhiteSelectedSeries, series.id])] : current.hullWhiteSelectedSeries.filter((item) => item !== series.id) }))} /><span><b>{series.tenorLabel}</b><small>{series.id}</small></span></label>;
                  })}</div>
                </fieldset>
                <div className="field full"><ControlHelpLabel label="Maximum quote age" help={MARKET_CONTROL_HELP.maximumQuoteAge} /><span className="input-shell"><input aria-label="Maximum quote age" type="number" min="0" max="30" step="1" value={marketRequest.hullWhiteMaximumQuoteAgeDays} onChange={(event) => setMarketRequest((current) => ({ ...current, hullWhiteMaximumQuoteAgeDays: Number(event.target.value) }))} /><small>days</small></span></div>
                <div className="market-check-row"><input aria-label="SHY IEF TLT option proxy" type="checkbox" checked={marketRequest.hullWhiteIncludeEtfOptions} onChange={(event) => setMarketRequest((current) => ({ ...current, hullWhiteIncludeEtfOptions: event.target.checked }))} /><span><b><ControlHelpLabel label="SHY · IEF · TLT option proxy" help={MARKET_CONTROL_HELP.etfOptionProxy} /></b><small>Amber rate-volatility scenario · never a swaption calibration</small></span></div>
                <div className="market-rate-policy"><b>PRIMARY MARKET OBJECT</b><span>Full immutable P(0,T) curve snapshot</span><small>Treasury PROXY · never OIS · a and σᵣ stay separate</small></div>
              </div> : <div className="equity-snapshot-controls merton-opportunity-controls">
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="History window" help={MARKET_CONTROL_HELP.historyWindow} /><select aria-label="HJB history window" value={marketRequest.hjbHistorySessions} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbHistorySessions: Number(event.target.value) as MarketDataRequest["hjbHistorySessions"] }))}><option value="252">252 sessions</option><option value="504">504 sessions</option><option value="756">756 sessions</option><option value="1260">1,260 sessions</option></select></div>
                  <div className="field"><ControlHelpLabel label="Return estimator" help={MARKET_CONTROL_HELP.returnEstimator} /><select aria-label="HJB return estimator" value={marketRequest.hjbEstimator} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbEstimator: event.target.value as MarketDataRequest["hjbEstimator"] }))}><option value="shrinkage">Shrinkage · default</option><option value="arithmetic">Arithmetic annualized</option><option value="ewma">Exponentially weighted</option></select></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="Volatility window" help={MARKET_CONTROL_HELP.volatilityWindow} /><select aria-label="HJB volatility window" value={marketRequest.hjbVolatilityWindow} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbVolatilityWindow: Number(event.target.value) as MarketDataRequest["hjbVolatilityWindow"] }))}><option value="20">20 sessions</option><option value="60">60 sessions</option><option value="126">126 sessions</option><option value="252">252 sessions</option></select></div>
                  <div className="field"><ControlHelpLabel label="Opportunity rate" help={MARKET_CONTROL_HELP.opportunityRate} /><select aria-label="HJB opportunity rate" value={marketRequest.hjbOpportunityRateSeries} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbOpportunityRateSeries: event.target.value as MarketDataRequest["hjbOpportunityRateSeries"], fredSeries: event.target.value }))}><option value="SOFR">SOFR</option><option value="DFF">DFF</option></select></div>
                </div>
                <div className="field-row">
                  <div className="field"><ControlHelpLabel label="History weight" help={MARKET_CONTROL_HELP.historyWeight} /><span className="input-shell"><input aria-label="HJB history weight" type="number" min="0" max="1" step="0.05" value={marketRequest.hjbShrinkageWeight} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbShrinkageWeight: Number(event.target.value) }))} /><small>{(marketRequest.hjbShrinkageWeight * 100).toFixed(0)}%</small></span></div>
                  <div className="field"><ControlHelpLabel label="ERP prior" help={MARKET_CONTROL_HELP.erpPrior} /><span className="input-shell"><input aria-label="HJB equity risk premium prior" type="number" min="-0.25" max="0.5" step="0.005" value={marketRequest.hjbEquityRiskPremiumPrior} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbEquityRiskPremiumPrior: Number(event.target.value) }))} /><small>decimal</small></span></div>
                </div>
                <div className="field full"><ControlHelpLabel label="EWMA half-life" help={MARKET_CONTROL_HELP.ewmaHalfLife} /><span className="input-shell"><input aria-label="HJB EWMA half-life" type="number" min="5" max="252" step="1" value={marketRequest.hjbEwmaHalfLifeSessions} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbEwmaHalfLifeSessions: Number(event.target.value) }))} /><small>sessions</small></span></div>
                <fieldset className="curve-tenor-picker opportunity-regime-picker">
                  <legend><ControlHelpLabel label="FRED regime set" help={MARKET_CONTROL_HELP.fredRegimeSet} /></legend>
                  <div>{(["VIXCLS", "T10Y2Y"] as const).map((seriesId) => <label key={seriesId}><input type="checkbox" checked={marketRequest.hjbRegimeSeries.includes(seriesId)} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbRegimeSeries: event.target.checked ? [...new Set([...current.hjbRegimeSeries, seriesId])] : current.hjbRegimeSeries.filter((item) => item !== seriesId) }))} /><span><b>{seriesId}</b><small>{seriesId === "VIXCLS" ? "volatility regime" : "curve slope"}</small></span></label>)}</div>
                </fieldset>
                <div className="market-check-row"><input aria-label="Explicit USD-rate proxy mode" type="checkbox" checked={marketRequest.hjbUsdRateProxyMode} onChange={(event) => setMarketRequest((current) => ({ ...current, hjbUsdRateProxyMode: event.target.checked }))} /><span><b><ControlHelpLabel label="Explicit USD-rate proxy mode" help={MARKET_CONTROL_HELP.usdRateProxy} /></b><small>Required for non-USD assets · recorded in snapshot</small></span></div>
                <div className="market-rate-policy"><b>P-MEASURE CONTROL</b><span>Adjusted total returns + {marketRequest.hjbOpportunityRateSeries} + versioned regimes</span><small>Sample mean uncertainty retained · VIX is never the asset&apos;s σ</small></div>
              </div>}
              <div className="provider-mini-status">
                <span><i className={marketRequest.sourceMode} /> yfinance <b>{marketRequest.sourceMode === "fixture" ? "FIXTURE" : "SERVER"}</b></span>
                <span><i className={marketRequest.sourceMode} /> FRED <b>{marketRequest.sourceMode === "fixture" ? "FIXTURE" : "SERVER"}</b></span>
                <small>{currentMarketSnapshot ? `${currentMarketSnapshot.freshness.toUpperCase()} · ${currentMarketSnapshot.asOfDate}` : "No snapshot fetched"}</small>
              </div>
              <button className="fetch-market-button" onClick={fetchMarketData} disabled={marketLoading || hestonCalibrating || !marketRequest.instrument || !marketRequest.asOfDate}>{marketLoading ? "Fetching and validating…" : marketRequest.sourceMode === "fixture" ? "Load fixture snapshot" : "Fetch live snapshot"}</button>
              {marketError && <div className="parameter-messages invalid" role="alert"><span>{marketError}</span></div>}
            </section>
          </> : <>
            <section className="control-section stage-sidebar-guidance">
              <div className="section-heading"><span>{activeStage} stage</span><span className="section-index">02</span></div>
              <p>{activeStage === "define"
                ? "Define the case name, instrument, date, model, contract, side, and objective in the main workspace. Model changes create auditable revisions."
                : activeStage === "condition"
                  ? "Review market observations, mappings and the exact base inputs before approval."
                  : "The case summary above preserves the exact inputs and lineage associated with this answer."}</p>
            </section>
          </>}
        </div>

      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <button ref={mobileMenuRef} type="button" className="mobile-menu" aria-label="Open parameter controls" aria-expanded={controlsOpen} onClick={openParameterControls}>☰</button>
            <div>
              <div className="eyebrow">
                <span>PDE STUDIO</span><b>/</b><span>CASE WORKBENCH</span><b>/</b><span>{activeStage.toUpperCase()}</span>
              </div>
              <h1>{currentCaseInputs.definition.instrument} · {contractSpec.label}{displaySide ? ` ${displaySide.toLowerCase()}` : ""} <span>— {model}</span></h1>
            </div>
          </div>
          <div className="topbar-actions">
            <span className={`status-pill ${caseReadiness.status.runActivity} ${caseReadiness.status.resultFreshness}`}><i /> {caseSystemStatus}</span>
            <button type="button" className="case-timeline-trigger" onClick={() => setTimelineOpen(true)} aria-haspopup="dialog" aria-label={`Open case timeline with ${liveCaseRecord.revisions.length + 1} checkpoints`}><span>Case timeline</span><b>{liveCaseRecord.revisions.length + 1}</b></button>
          </div>
        </header>

        <CaseWorkbenchChrome
          activeStage={activeStage}
          readiness={caseReadiness}
          summary={caseSummary}
          onSelectStage={selectCaseStage}
        />

        <div className="workspace-content">
          {activeStage === "define" ? <CaseDefinitionWorkspace
            caseName={caseName}
            instrument={currentCaseInputs.definition.instrument}
            valuationDate={currentCaseInputs.definition.valuationDate}
            model={model}
            models={MODEL_KEYS.map((item) => ({ id: item, description: MODEL_SPECS[item].description, measure: MODEL_SPECS[item].measure }))}
            contractId={contract}
            contracts={config.contracts}
            side={displaySide ?? null}
            optionSides={contractSpec.optionSides}
            measure={config.measure}
            measureMeaning={config.measureMeaning}
            objective={definitionObjective}
            issues={definitionIssues}
            confirmedAt={definitionConfirmedAt}
            consequence={definitionConsequence}
            canSave={canSaveDefinition}
            onChangeCaseName={(value) => editDefinition("caseName", value)}
            onChangeInstrument={(value) => editDefinition("instrument", value)}
            onChangeValuationDate={(value) => editDefinition("valuationDate", value)}
            onChangeModel={changeModel}
            onChangeContract={changeContract}
            onChangeSide={changeSide}
            onChangeObjective={(value) => editDefinition("objective", value)}
            onSave={confirmDefinition}
          /> : activeStage === "condition" ? <ConditionWorkbench
            caseState={liveCaseRecord}
            marketSnapshot={currentMarketSnapshot}
            selectedMarketParameterIds={selectedMarketProposalIds}
            validationIssues={parameterValidationIssues}
            onOpenMarketControls={() => { openWorkspace("market-data"); openParameterControls(); }}
            onApplyMarket={applyMarketData}
            onApprove={approveMarketBase}
            onContinue={() => selectCaseStage("solve")}
            marketEvidence={<MarketDataWorkspace
              request={marketRequest}
              snapshot={currentMarketSnapshot}
              loading={marketLoading}
              error={marketError}
              selectedIds={selectedMarketProposalIds}
              lastApplied={lastAppliedMarketSnapshot}
              calibrating={hestonCalibrating}
              onToggleProposal={toggleMarketProposal}
              onRunCalibration={runHestonCalibration}
              onCancelCalibration={cancelHestonCalibration}
              onSaveHistoricalScenario={saveVasicekHistoricalScenario}
              historicalScenarioStatus={vasicekScenarioStatus}
              onApply={applyMarketData}
              onRestore={restoreLatestMarketInputs}
            />}
          /> : activeWorkspace === "solver-studio" ? <SolverStudioWorkspace
            model={model}
            contract={contract}
            contractLabel={contractSpec.label}
            equation={config.equation}
            measure={config.measure}
            parameterSpecs={activeParameters}
            parameters={parameters}
            barrierType={barrierType}
            scheme={scheme}
            schemeOptions={(isHestonModel ? HESTON_SCHEMES : isHjbModel ? MERTON_SCHEMES : ONE_DIMENSIONAL_SCHEMES)
              .filter((value) => contract !== "american-put" || value !== "explicit-euler")
              .map((value) => ({ id: value, label: SCHEME_LABELS[value] }))}
            gridKind={gridKind}
            spaceSteps={spaceSteps}
            varianceSteps={varianceSteps}
            timeSteps={timeSteps}
            isHeston={isHestonModel}
            isShortRate={isShortRateModel}
            isHjb={isHjbModel}
            monteCarloEligible={monteCarloEligible}
            monteCarloEnabled={monteCarloEnabled}
            monteCarloPaths={monteCarloPaths}
            monteCarloTimeSteps={monteCarloTimeSteps}
            monteCarloSeed={monteCarloSeed}
            validationIssues={[...new Set([...validationIssues, ...getCaseModelCompatibilityIssues(liveCaseRecord.core)])]}
            warnings={warnings}
            solverError={solverError}
            solverAvailable={solverAvailable && caseExecutionReady}
            running={running}
            progress={progress}
            workerStage={workerStage}
            lastExecution={lastExecution}
            status={caseReadiness.status}
            tolerance={contractSpec.tolerance}
            quotedContract={solveQuotedContract}
            quotedContractIsExact={Boolean(solveMatchingQuote)}
            onChangeBarrierType={(value) => { setBarrierType(value); clearCalculatedResult(); }}
            onChangeParameter={setParameter}
            onChangeScheme={(value) => { setScheme(value as NumericalScheme); clearCalculatedResult(); }}
            onChangeGridKind={(value) => { setGridKind(value); clearCalculatedResult(); }}
            onChangeSpaceSteps={(value) => { setSpaceSteps(value); clearCalculatedResult(); }}
            onChangeVarianceSteps={(value) => { setVarianceSteps(value); clearCalculatedResult(); }}
            onChangeTimeSteps={(value) => { setTimeSteps(value); clearCalculatedResult(); }}
            onToggleMonteCarlo={(enabled) => { setMonteCarloEnabled(enabled); clearCalculatedResult(); }}
            onChangeMonteCarloPaths={(value) => { setMonteCarloPaths(value); clearCalculatedResult(); }}
            onChangeMonteCarloTimeSteps={(value) => { setMonteCarloTimeSteps(value); clearCalculatedResult(); }}
            onChangeMonteCarloSeed={(value) => { setMonteCarloSeed(value); clearCalculatedResult(); }}
            onUseQuotedContract={() => applyQuotedContract(solveQuotedContract)}
            onReturnToCondition={() => selectCaseStage("condition")}
            onRun={runSolver}
            onCancel={cancelSolver}
          /> : activeWorkspace === "results" ? <>
          <DecideWorkspace
            definition={decideDefinition}
            valuationAssessment={valuationAssessment}
            scenario={decideScenario}
            run={decideRun}
            status={caseReadiness.status}
            staleReasons={caseReadiness.staleReasons}
            primaryLabel={decidePrimaryLabel}
            primaryValue={decidePrimaryValue}
            secondaryLabel={decideSecondaryLabel}
            secondaryValue={decideSecondaryValue}
            baseValue={decideBaseNumeric == null ? null : formatMoney(decideBaseNumeric)}
            scenarioValue={decideScenarioNumeric == null ? null : formatMoney(decideScenarioNumeric)}
            scenarioDelta={decideBaseNumeric == null || decideScenarioNumeric == null ? null : `${decideScenarioNumeric - decideBaseNumeric >= 0 ? "+" : ""}${formatMoney(decideScenarioNumeric - decideBaseNumeric)} versus Base`}
            reliability={decideReliability}
            uncertainty={decideUncertainty}
            sensitivities={decideSensitivities}
            evidence={decideEvidence}
            resultsAvailable={Boolean(solverResult)}
            onDownloadManifest={exportRun}
            onDownloadResults={exportResults}
            onRunMatchingBase={prepareMatchingBaseRun}
            onReviewValuationEvidence={() => selectCaseStage(
              caseReadiness.status.resultFreshness !== "current" || !decideRun?.summary?.accepted ? "solve" : "condition",
            )}
            onReturnToSolve={() => selectCaseStage("solve")}
          >

          {solverResult && decideRun?.status === "completed" && caseReadiness.status.resultFreshness === "current" ? <section className="decide-visual-diagnostics" aria-labelledby="decide-visual-diagnostics-title">
          <header className="decide-visual-diagnostics-header">
            <div><span className="card-label"><i /> Visual diagnostics</span><h2 id="decide-visual-diagnostics-title">Explore the completed result</h2><p>Every visible view below is generated from this current {model} run under the approved {config.measure}-measure base case.</p></div>
            <span className="decide-visual-run-id">Run {decideRun.id}</span>
          </header>
          <nav className="result-tabs" aria-label="Result views">
            {["Overview", ...(monteCarloEligible ? ["Monte Carlo"] : []), "Convergence", model === "HJB" ? "Policy" : isHestonModel ? "Slices" : "Greeks", "Run details"].map((tab) => (
              <button
                key={tab}
                onClick={() => setMainTab(tab)}
                className={mainTab === tab ? "active" : ""}
                disabled={tab === "Monte Carlo" && !monteCarloTabAvailable}
                aria-disabled={tab === "Monte Carlo" && !monteCarloTabAvailable}
                title={tab === "Monte Carlo" && !monteCarloTabAvailable ? "Enable Monte Carlo and run the solver to populate this tab" : undefined}
              >{tab}</button>
            ))}
            <span className="run-stamp"><i /> {lastRun}</span>
          </nav>

          {mainTab === "Overview" ? (
            <>
              <section className="chart-card surface-card">
                <header className="chart-header">
                  <div>
                    <span className="card-label"><i /> Solution manifold</span>
                    <h2>{model === "HJB" ? <>Value function <Formula math={String.raw`J(W,\tau)`} /></> : isHestonModel ? <>Initial price surface <Formula math={String.raw`V(S,v,t=0)`} /></> : <>Price surface <Formula math={String.raw`V(${model === "Vasicek" || model === "Hull–White" ? "r" : "S"},\tau)`} /></>}</h2>
                  </div>
                  <div className="segmented">
                    {(["3D surface", "Heatmap"] as ViewMode[]).map((mode) => (
                      <button key={mode} onClick={() => setViewMode(mode)} className={viewMode === mode ? "active" : ""}>{mode}</button>
                    ))}
                  </div>
                </header>
                <div className="surface-wrap">
                  <SurfaceChart mode={viewMode} model={model} seed={seed} result={solverAvailable ? solverResult : null} />
                  <div className="chart-legend">
                    <span>VALUE</span>
                    <i className="gradient" />
                    <small>0.0</small><small>28.6</small>
                  </div>
                  <div className="surface-note"><b><Formula math={isHestonModel ? "t=0" : String.raw`\tau=0`} /></b><span>{isHestonModel ? "Initial S–v manifold" : "Terminal boundary"}</span></div>
                </div>
              </section>

              <section className="lower-grid">
                <article className="chart-card">
                  <header className="chart-header compact">
                    <div>
                      <span className="card-label"><i /> {isHestonModel ? "Time slices" : isHjbModel ? "Optimal control" : "Initial-time slice"}</span>
                      <h2>{isHestonModel ? hestonSliceAxis : isHjbModel ? <>Dollar policy <Formula math={String.raw`\pi^*(W,t=0)`} /></> : <>Value vs state at <Formula math="t=0" /></>}</h2>
                    </div>
                    {isHestonModel ? (
                      <div className="segmented compact-segmented">
                        {(["Spot × time", "Variance × time"] as HestonSliceAxis[]).map((axis) => <button key={axis} onClick={() => setHestonSliceAxis(axis)} className={hestonSliceAxis === axis ? "active" : ""}>{axis.startsWith("Spot") ? "S–t" : "v–t"}</button>)}
                      </div>
                    ) : <div className="inline-legend"><span className="pde">{isHjbModel ? "Howard" : "PDE"}</span><span className="analytic">Analytic</span></div>}
                  </header>
                  <div className="small-chart-wrap">{isHestonModel && solverResult && isHestonResult(solverResult)
                    ? <HestonTimeSliceChart result={solverResult} axis={hestonSliceAxis} />
                    : isHjbModel && solverResult && isMertonResult(solverResult)
                      ? <MertonPolicyChart result={solverResult} />
                    : <LineChart price={Number.isFinite(basePrice) ? basePrice : 3.3} seed={seed} result={solverAvailable ? solverResult : null} />}</div>
                </article>
                <article className="chart-card">
                  <header className="chart-header compact">
                    <div>
                      <span className="card-label"><i /> Cross-check</span>
                      <h2>Method comparison</h2>
                    </div>
                    <span className="tolerance"><Formula math={toleranceTex(contractSpec.tolerance.pointwiseAbsolute)} label={toleranceLabel(contractSpec.tolerance)} /></span>
                  </header>
                  <div className="small-chart-wrap">{solverResult
                    ? <ComparisonChart pde={basePrice} benchmark={benchmark} />
                    : <div className="chart-placeholder">Run the available solver to compare values.</div>}
                  </div>
                </article>
              </section>
            </>
          ) : mainTab === "Monte Carlo" ? (
            monteCarloResult && solverResult ? monteCarloResult.stateKind === "controlled-wealth" && isMertonResult(solverResult) ? (
              <MertonPolicyMonteCarloResults
                result={monteCarloResult}
                maturity={Number(parameters.maturity)}
                riskAversion={Number(parameters.riskAversion)}
                controlMin={Number(parameters.controlMin)}
                controlMax={Number(parameters.controlMax)}
              />
            ) : monteCarloResult.stateKind === "short-rate-and-discount-factor" && isShortRateResult(solverResult) ? (
              <ShortRateMonteCarloResults
                result={monteCarloResult}
                contract={contract as "zero-coupon-bond" | "bond-option"}
                maturity={Number(parameters.maturity)}
                bondMaturity={contract === "bond-option" ? Number(parameters.bondMaturity) : undefined}
                strike={contract === "bond-option" ? Number(parameters.strike) : undefined}
                pdeValue={basePrice}
                benchmarkValue={benchmark}
                benchmarkLabel={contractSpec.benchmark}
              />
            ) : monteCarloResult.stateKind !== "short-rate-and-discount-factor" && monteCarloResult.stateKind !== "controlled-wealth" ? (
              <MonteCarloResults
                result={monteCarloResult}
                spot={Number(parameters.spot)}
                strike={Number(parameters.strike)}
                maturity={Number(parameters.maturity)}
                rate={Number(parameters.rate)}
                dividend={Number(parameters.dividend)}
                side={displaySide as "Call" | "Put"}
                contract={contract as "european" | "digital" | "barrier"}
                barrier={contract === "barrier" ? Number(parameters.barrier) : undefined}
                barrierDirection={contract === "barrier" ? (barrierType === "Down & out" ? "down-and-out" : "up-and-out") : undefined}
                pdeValue={basePrice}
                benchmarkValue={benchmark}
                benchmarkLabel={contractSpec.benchmark}
              />
            ) : (
              <section className="analysis-panel"><div className="analysis-orbit"><span>MC</span></div><div className="analysis-copy"><span className="card-label"><i /> Monte Carlo</span><h2>Result mismatch</h2><p>The completed Monte Carlo payload does not match the selected model. Run the solver again.</p></div></section>
            ) : (
              <section className="analysis-panel"><div className="analysis-orbit"><span>MC</span></div><div className="analysis-copy"><span className="card-label"><i /> Monte Carlo</span><h2>Run required</h2><p>Enable Monte Carlo before running the solver. Selecting this tab never starts or repeats a simulation.</p></div></section>
            )
          ) : (
            <section className={`analysis-panel ${mainTab === "Economic bridge" ? "bridge-panel" : ""}`}>
              <div className="analysis-orbit"><span>{mainTab === "Run details" ? "RUN" : mainTab === "Economic bridge" ? "P→Q" : mainTab.slice(0, 3).toUpperCase()}</span></div>
              <div className="analysis-copy">
                <span className="card-label"><i /> {mainTab === "Economic bridge" ? "Phase 6 · economic-model bridge" : mainTab}</span>
                <h2>{mainTab === "Convergence" ? "Grid refinement diagnostics" : mainTab === "Run details" ? "Reproducible run manifest" : mainTab === "Economic bridge" ? "Point-in-time scenarios, separate from calibration" : `${mainTab} analysis`}</h2>
                {mainTab === "Economic bridge" ? (
                  <>
                    <p className="bridge-intro">Only inputs available by {new Date(economicBridge.runAsOfTimestamp).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} enter this bridge. Forecasts stay under P unless a documented scenario or prior is shown; the calibrated Q-measure base set is never silently overwritten.</p>
                    {appliedCpiScenario && <div className="bridge-source-forecast">
                      <div><span className="workspace-kicker">SOURCE FORECAST SNAPSHOT</span><b>{appliedCpiScenario.forecastRunId}</b><small>{appliedCpiScenario.distributionMethod} v{appliedCpiScenario.distributionMethodVersion} · seed {appliedCpiScenario.distributionSeed} · {appliedCpiScenario.scenarioInputs.quantile.toUpperCase()} {appliedCpiScenario.scenarioInputs.cpiMomPct.toFixed(3)}%</small></div>
                      <button onClick={() => openWorkspace("economic-forecast")}>Inspect source forecast</button>
                    </div>}
                    {appliedCpiScenario && <div className="bridge-base-scenario-comparison" aria-label="Market base and macro scenario comparison">
                      {appliedCpiScenario.affectedParameters.map((item) => <article key={item.id}><span>{item.id} · {item.measure}-measure scenario</span><div><p><b>Market-calibrated base</b><strong>{formatBridgeValue(Number(item.baseValue))}</strong></p><i aria-hidden="true">→</i><p><b>Macro-conditioned scenario</b><strong>{formatBridgeValue(item.scenarioValue)}</strong></p></div><small>{item.formula}{item.clamped ? " · bound applied" : " · within bounds"}</small></article>)}
                    </div>}
                    <div className="bridge-audit" aria-label="Economic bridge audit status">
                      <span><b>LOOK-AHEAD</b> Passed</span>
                      <span><b>PROBABILITY SUM</b> {economicBridge.audit.probabilitySum.toFixed(3)}</span>
                      <span><b>MAPPING</b> {economicBridge.mappingId} v{economicBridge.mappingVersion}</span>
                      <span><b>VINTAGE</b> {economicBridge.audit.dataVintages.join(", ")}</span>
                    </div>
                    <ParameterUncertaintyResults
                      result={parameterUncertaintyResult}
                      running={parameterUncertaintyRunning}
                      progress={parameterUncertaintyProgress}
                      stage={parameterUncertaintyStage}
                      error={parameterUncertaintyError}
                      cacheHit={parameterUncertaintyCacheHit}
                      lockedReason={parameterUncertaintyLockedReason}
                      budget={parameterUncertaintyBudget}
                      onBudgetChange={(value) => { setParameterUncertaintyBudget(value); setParameterUncertaintyResult(null); setParameterUncertaintyCacheHit(false); }}
                      onRunOrCancel={runParameterUncertainty}
                    />
                    <div className="scenario-selector" aria-label="Economic scenario comparison">
                      {economicBridge.scenarios.map((scenario) => (
                        <button
                          key={scenario.id}
                          className={bridgeScenarioId === scenario.id ? "active" : ""}
                          onClick={() => setBridgeScenarioId(scenario.id)}
                          aria-pressed={bridgeScenarioId === scenario.id}
                        >
                          <span>{scenario.label}</span>
                          <strong>{formatPercent(scenario.probability)}</strong>
                          <small>{formatPercent(scenario.probabilityInterval[0])}–{formatPercent(scenario.probabilityInterval[1])}</small>
                        </button>
                      ))}
                    </div>
                    <div className="bridge-actions">
                      <div>
                        <b>{selectedBridgeScenario.label} transformation lineage</b>
                        <span>{selectedBridgeScenario.probabilityProvenance.sourceModelVersion} · observed {selectedBridgeScenario.probabilityProvenance.observationTimestamp.slice(0, 10)} · available {selectedBridgeScenario.probabilityProvenance.availableTimestamp.slice(0, 10)}</span>
                      </div>
                      {appliedBridgeScenarioId ? (
                        <button onClick={restoreCalibratedParameters}>Restore calibrated set</button>
                      ) : (
                        <button onClick={() => applyEconomicScenario()}>Apply {selectedBridgeScenario.label.toLowerCase()} scenario</button>
                      )}
                    </div>
                    <div className="lineage-list">
                      {selectedBridgeScenario.transformations.map((transformation) => (
                        <article key={transformation.sourceInputId}>
                          <div className="lineage-input">
                            <span>{transformation.sourceLabel}</span>
                            <strong>{formatPercent(transformation.sourceValue)}</strong>
                            <small>{formatPercent(transformation.sourceInterval[0])}–{formatPercent(transformation.sourceInterval[1])} · {formatPercent(transformation.confidenceLevel)} interval</small>
                          </div>
                          <div className="lineage-arrow" aria-hidden="true">→</div>
                          <div className="lineage-output">
                            <span>{transformation.targetParameter ? `${transformation.targetParameter} · ${transformation.measure}-measure ${transformation.targetSet}` : "Explicitly excluded"}</span>
                            <strong>{formatBridgeValue(transformation.mappedValue)}</strong>
                            <small>{transformation.mappedInterval ? `${formatBridgeValue(transformation.mappedInterval[0])}–${formatBridgeValue(transformation.mappedInterval[1])}` : "No target parameter"}{transformation.constrained ? " · bound applied" : ""}</small>
                          </div>
                          <div className="lineage-detail">
                            <b>{economicFormulaTex(transformation.formula) ? <Formula math={economicFormulaTex(transformation.formula) ?? ""} display label={transformation.formula} /> : transformation.formula}</b>
                            <p>{transformation.financialInterpretation}</p>
                            <small>Observed {transformation.observationTimestamp.slice(0, 10)} · available {transformation.availableTimestamp.slice(0, 10)} · target {transformation.targetTimestamp.slice(0, 10)} ({transformation.forecastHorizonMonths}m) · vintage {transformation.dataVintage} · {transformation.sourceModelVersion} · {transformation.mappingVersion}</small>
                          </div>
                        </article>
                      ))}
                    </div>
                    <div className="scenario-table" role="table" aria-label={`${model} economic scenario parameter comparison`}>
                      <div className="scenario-row scenario-head" role="row"><span>Scenario</span><span>Probability provenance</span><span>Mapped parameters</span><span>Run class</span></div>
                      {economicBridge.scenarios.map((scenario) => (
                        <div className="scenario-row" role="row" key={scenario.id}>
                          <span><b>{scenario.label}</b>{appliedBridgeScenarioId === scenario.id ? <small>Applied to controls</small> : null}</span>
                          <span>{formatPercent(scenario.probability)} <small>{scenario.probabilityProvenance.sourceModelVersion} · vintage {scenario.probabilityProvenance.dataVintage}</small></span>
                          <span>{scenario.transformations.filter((item) => item.targetParameter).map((item) => `${item.targetParameter}=${formatBridgeValue(item.mappedValue)}`).join(" · ") || "No defensible direct mapping"}</span>
                          <span>{scenario.classification}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : mainTab === "Convergence" && convergence.length > 0 ? (
                  <>
                    <p>Uniform-grid refinement holds the model and contract fixed while doubling both spatial and time resolution. The reported order is estimated from successive point-price errors.</p>
                    <div className="convergence-table" role="table" aria-label={`${model} convergence results`}>
                      <div className="table-row table-head" role="row"><span>Refinement / {isHestonModel ? "Mₛ × Mᵥ × N" : "M × N"}</span><span>{isHjbModel ? "HJB value" : "PDE price"}</span><span>{isHjbModel ? "Value and policy error" : "Abs. error"}</span><span>Order</span></div>
                      {convergence.map((level, index) => (
                        <div className="table-row" role="row" key={convergenceLevelKey(model, index, level.spaceSteps, "varianceSteps" in level ? level.varianceSteps : null, level.timeSteps)}>
                          <ConvergenceLevelLabel index={index} grid={"varianceSteps" in level ? `${level.spaceSteps} × ${level.varianceSteps} × ${level.timeSteps}` : `${level.spaceSteps} × ${level.timeSteps}`} />
                          <span>{level.price.toFixed(6)}</span>
                          <span>{isHjbModel && "policyAbsoluteError" in level ? `${level.absoluteError.toExponential(2)} / ${level.policyAbsoluteError.toExponential(2)}` : level.absoluteError.toExponential(3)}</span>
                          <span>{level.observedOrder?.toFixed(2) ?? "—"}</span>
                        </div>
                      ))}
                    </div>
                    <div className="analysis-stats">
                      <span><b>Domain Δ</b> {Number.isFinite(domainExpansionDelta) ? domainExpansionDelta.toExponential(2) : "n/a"}</span>
                      <span><b>Target</b> <Formula math={String.raw`\text{order}\ge ${contractSpec.tolerance.observedOrder ?? String.raw`\mathrm{n/a}`}`} /></span>
                       <span><b>Grid</b> {isHestonModel ? "uniform tensor refinement" : isHjbModel ? "wealth-fitted refinement" : "uniform refinement"}</span>
                      <span><b>Status</b> {withinTolerance ? "Accepted" : "Review"}</span>
                    </div>
                  </>
                ) : mainTab === "Run details" ? (
                  <>
                    <p>{contractSpec.summary} {solverResult ? `This manifest records the calculated ${phaseLabel} run and its independent benchmark.` : "Run the solver to add product-level numerical diagnostics."}</p>
                    <div className="manifest-grid">
                      <div><b>Measure</b><span>{config.measure} · {config.measureMeaning}</span></div>
                      <div><b>Run class</b><span>{appliedBridgeScenarioId ? `macro-conditioned scenario · ${appliedBridgeScenarioId}` : isHjbModel ? "historical / user-specified P-measure inputs" : "market-calibrated Q-measure base"}</span></div>
                      <div><b>Economic bridge</b><span>{economicBridge.mappingId} v{economicBridge.mappingVersion}; as of {economicBridge.runAsOfTimestamp}; look-ahead check passed; calibrated and scenario sets stored separately</span></div>
                      {activeMarketApplication && <div><b>Market snapshot</b><span>{activeMarketApplication.snapshot.instrument} · observed {activeMarketApplication.snapshot.observations[0]?.observationTimestamp ?? "not recorded"} · created {activeMarketApplication.snapshot.createdAt} · snapshot {activeMarketApplication.snapshot.id}</span></div>}
                      {activeMarketApplication?.snapshot.blackScholes && <div><b>Equity calibration</b><span>Expiry {activeMarketApplication.snapshot.blackScholes.expiration} · rate {activeMarketApplication.snapshot.blackScholes.rate.sourceSeries.join("/") || "manual"} ({activeMarketApplication.snapshot.blackScholes.rate.mode}) · dividend {activeMarketApplication.snapshot.blackScholes.dividend.selectedMethod} · IV {activeMarketApplication.snapshot.blackScholes.volatility.method} · spot time {activeMarketApplication.snapshot.blackScholes.spotTimestamp}</span></div>}
                      {activeMarketApplication?.snapshot.heston?.calibration && <div><b>Heston calibration</b><span>Surface {activeMarketApplication.snapshot.heston.surfaceId} · {activeMarketApplication.snapshot.heston.retainedExpirations.length} expiries · {activeMarketApplication.snapshot.heston.calibration.objective.toUpperCase()} objective · RMSE {activeMarketApplication.snapshot.heston.calibration.weightedRmse.toExponential(3)} · Feller {activeMarketApplication.snapshot.heston.calibration.fellerRatio.toFixed(3)} · completed {activeMarketApplication.snapshot.heston.calibration.completedAt}</span></div>}
                      {activeMarketApplication?.snapshot.vasicek && <div><b>Vasicek rate snapshot</b><span>{activeMarketApplication.snapshot.vasicek.series} · vintage {activeMarketApplication.snapshot.vasicek.vintage} · {activeMarketApplication.snapshot.vasicek.pEstimate.sampling} · {activeMarketApplication.snapshot.vasicek.pEstimate.window.join(" to ")} · estimator {activeMarketApplication.snapshot.vasicek.pEstimate.estimatorVersion} · snapshot {activeMarketApplication.snapshot.vasicek.snapshotId}</span></div>}
                      {activeMarketApplication?.snapshot.vasicek?.qCalibration && <div><b>Vasicek Q calibration</b><span>{activeMarketApplication.snapshot.vasicek.qCalibration.method} · {activeMarketApplication.snapshot.vasicek.qCalibration.instruments.length} zero-coupon instruments · objective {activeMarketApplication.snapshot.vasicek.qCalibration.objective.toExponential(3)} · completed {activeMarketApplication.snapshot.vasicek.qCalibration.completedAt}</span></div>}
                      {activeMarketApplication?.snapshot.hullWhite && <div><b>Hull–White curve</b><span>{activeMarketApplication.snapshot.hullWhite.curve.id} · {activeMarketApplication.snapshot.hullWhite.mode} · {activeMarketApplication.snapshot.hullWhite.pillars.length} pillars · {activeMarketApplication.snapshot.hullWhite.interpolation} · max fit {activeMarketApplication.snapshot.hullWhite.maximumFitErrorBasisPoints.toExponential(3)} bp · immutable snapshot {activeMarketApplication.snapshot.hullWhite.snapshotId}</span></div>}
                      {activeMarketApplication?.snapshot.mertonOpportunity && <div><b>Merton opportunity set</b><span>{activeMarketApplication.snapshot.mertonOpportunity.historyInterval.join(" to ")} · adjusted total returns · {activeMarketApplication.snapshot.mertonOpportunity.returnEstimates.selected} estimator ({activeMarketApplication.snapshot.mertonOpportunity.estimatorVersion}) · {activeMarketApplication.snapshot.mertonOpportunity.mappingVersion} · regime probability {activeMarketApplication.snapshot.mertonOpportunity.bridgeInput.regimes.find((item) => item.id === appliedBridgeScenarioId)?.probability.toFixed(6) ?? "base"} · snapshot {activeMarketApplication.snapshot.mertonOpportunity.snapshotId}</span></div>}
                      {vasicekHistoricalScenarios[0] && <div><b>Historical P scenario</b><span>{vasicekHistoricalScenarios[0].series} · {vasicekHistoricalScenarios[0].window.join(" to ")} · {vasicekHistoricalScenarios[0].sampling} · immutable scenario {vasicekHistoricalScenarios[0].id} · Q base unchanged</span></div>}
                      <div><b>Benchmark</b><span>{contractSpec.benchmark}</span></div>
                      <div><b>Parameters</b><span>{activeParameters.map((item) => item.symbol).join(", ")}</span></div>
                      <div><b>Grid</b><span>{solverResult ? `${solverResult.gridKind}; Δ${isShortRateModel ? "r" : isHjbModel ? "W" : "S"} ${solverResult.solution.diagnostics.minSpaceStep.toPrecision(3)}–${solverResult.solution.diagnostics.maxSpaceStep.toPrecision(3)}${isHestonResult(solverResult) ? `; Δv ${solverResult.solution.diagnostics.minVarianceStep.toPrecision(3)}–${solverResult.solution.diagnostics.maxVarianceStep.toPrecision(3)}` : ""}; Δτ ${solverResult.solution.diagnostics.timeStep.toExponential(2)}` : "Pending"}</span></div>
                      <div><b>Execution</b><span>{lastExecution === "cache" ? "Identical completed run restored from worker cache" : lastExecution === "worker" ? "Background worker job; interface remained responsive" : "Bundled deterministic sample result"}</span></div>
                      <div><b>Diagnostics</b><span>{solverResult ? `L∞ ${solverResult.maxNormError.toExponential(2)}; L2 ${solverResult.l2Error.toExponential(2)}; residual ${solverResult.solution.diagnostics.maxLinearResidual.toExponential(2)}` : config.diagnostics.join(", ")}</span></div>
                      <div><b>Interpolation</b><span>{solverResult ? "spotLowerIndex" in solverResult.interpolation ? solverResult.interpolation.exactNode ? `Exact tensor node (${solverResult.interpolation.spotLowerIndex}, ${solverResult.interpolation.varianceLowerIndex})` : `Bilinear S ${solverResult.interpolation.spotLowerIndex}/${solverResult.interpolation.spotUpperIndex}; v ${solverResult.interpolation.varianceLowerIndex}/${solverResult.interpolation.varianceUpperIndex}` : solverResult.interpolation.exactNode ? `Exact node ${solverResult.interpolation.lowerIndex}` : `Nodes ${solverResult.interpolation.lowerIndex}/${solverResult.interpolation.upperIndex}; weights ${solverResult.interpolation.lowerWeight.toFixed(3)}/${solverResult.interpolation.upperWeight.toFixed(3)}` : "Pending"}</span></div>
                      <div><b>Acceptance</b><span><Formula math={toleranceTex(contractSpec.tolerance.pointwiseAbsolute)} label={toleranceLabel(contractSpec.tolerance)} />; {solverResult ? withinTolerance ? "passed" : "failed" : "pending"}</span></div>
                      <div><b>Domain</b><span>{solverResult ? `[${solverResult.solution.diagnostics.domain[0].toFixed(2)}, ${solverResult.solution.diagnostics.domain[1].toFixed(2)}]${isHestonResult(solverResult) ? ` × [${solverResult.solution.diagnostics.varianceDomain[0].toFixed(3)}, ${solverResult.solution.diagnostics.varianceDomain[1].toFixed(3)}]` : ""}; expansion Δ ${domainExpansionDelta.toExponential(2)}` : "Pending"}</span></div>
                      {solverResult && "exerciseDiagnostics" in solverResult && solverResult.exerciseDiagnostics && <div><b>Exercise LCP</b><span>{solverResult.exerciseDiagnostics.method}; residual {solverResult.exerciseDiagnostics.maxComplementarityResidual.toExponential(2)}; boundary S* {solverResult.exerciseDiagnostics.exerciseBoundary?.toFixed(3) ?? "n/a"}; {solverResult.exerciseDiagnostics.activeNodes} active nodes</span></div>}
                      {solverResult && "curveFit" in solverResult && solverResult.curveFit && <div><b>Curve fit</b><span>{solverResult.curveFit.curveId}; {solverResult.curveFit.pillarCount} pillars; max {solverResult.curveFit.maximumBasisPointError.toExponential(2)} bp</span></div>}
                      {solverResult && isHestonResult(solverResult) && <div><b>Heston boundary</b><span>Reduced <Formula math="v=0" /> PDE; <Formula math={String.raw`\left.\frac{\partial V}{\partial v}\right|_{v=v_{\max}}`} /> {solverResult.solution.diagnostics.maximumFarVarianceGradient.toExponential(2)}; Feller ratio {solverResult.solution.diagnostics.fellerRatio.toFixed(3)}</span></div>}
                      {solverResult && isMertonResult(solverResult) && <div><b>Howard iteration</b><span>Bellman residual {solverResult.solution.diagnostics.maxBellmanResidual.toExponential(2)}; at most {solverResult.solution.diagnostics.maximumHowardIterations} iterations/step; control bounds active on {((solverResult.solution.diagnostics.lowerControlActivityFraction + solverResult.solution.diagnostics.upperControlActivityFraction) * 100).toFixed(1)}% of interior nodes</span></div>}
                    </div>
                  </>
                ) : mainTab === "Greeks" && solverResult && "greeks" in solverResult ? (
                  <>
                    <p>Delta and gamma use payoff-aware nonuniform finite-difference stencils. Theta follows from the pricing operator; vega and rho use symmetric bump-and-revalue solves.</p>
                    <div className="analysis-stats greek-stats" aria-label="Calculated option Greeks">
                      <span><b>Delta Δ</b> {solverResult.greeks.delta.toFixed(6)}</span>
                      <span><b>Gamma Γ</b> {solverResult.greeks.gamma.toFixed(6)}</span>
                      <span><b>Theta Θ</b> {solverResult.greeks.theta.toFixed(6)}</span>
                      <span><b>Vega ν</b> {solverResult.greeks.vega.toFixed(6)}</span>
                      <span><b>Rho ρ</b> {solverResult.greeks.rho.toFixed(6)}</span>
                      <span><b>Method</b> grid + central bumps</span>
                    </div>
                  </>
                ) : mainTab === "Slices" && solverResult && isHestonResult(solverResult) ? (
                  <>
                    <p>The captured tensor layers support <Formula math={String.raw`V(S,t)\text{ at }v=v_0`} /> and <Formula math={String.raw`V(v,t)\text{ at }S=S_0`} />. Local derivatives use the same nonuniform spot and variance stencils as the PDE grid.</p>
                    <div className="analysis-stats greek-stats" aria-label="Calculated Heston slice diagnostics">
                      <span><b>Delta Δ</b> {solverResult.sensitivities.delta.toFixed(6)}</span>
                      <span><b>Gamma Γ</b> {solverResult.sensitivities.gamma.toFixed(6)}</span>
                      <span><b>Variance delta</b> {solverResult.sensitivities.varianceDelta.toFixed(6)}</span>
                      <span><b>Cross stencil</b> nine-point</span>
                      <span><b>ADI θ</b> {solverResult.solution.diagnostics.adiTheta.toFixed(6)}</span>
                      <span><b>Layers</b> {solverResult.solution.layers.length}</span>
                    </div>
                  </>
                ) : mainTab === "Policy" && solverResult && isMertonResult(solverResult) ? (
                  <>
                    <p>Howard iteration maximises the monotone discrete Hamiltonian pointwise. The dashed reference is the unconstrained CRRA policy; the calculated policy respects the dollar bounds and the positive-wealth state constraint.</p>
                    <div className="analysis-stats greek-stats" aria-label="Calculated Merton policy diagnostics">
                      <span><b>Policy <Formula math={String.raw`\pi^*(W_0)`} /></b> {solverResult.policy.toFixed(6)}</span>
                      <span><b>Closed form</b> {solverResult.analyticPolicy.toFixed(6)}</span>
                      <span><b>Policy error</b> {solverResult.policyAbsoluteError.toExponential(3)}</span>
                      <span><b>Bellman residual</b> {solverResult.solution.diagnostics.maxBellmanResidual.toExponential(3)}</span>
                      <span><b>Howard iterations</b> at most {solverResult.solution.diagnostics.maximumHowardIterations} per step</span>
                      <span><b>Bound activity</b> {((solverResult.solution.diagnostics.lowerControlActivityFraction + solverResult.solution.diagnostics.upperControlActivityFraction) * 100).toFixed(1)}%</span>
                    </div>
                  </>
                ) : mainTab === "Greeks" && solverResult && isShortRateResult(solverResult) ? (
                  <>
                    <p>Rate delta and gamma use the local finite-difference stencil. Volatility sensitivity uses a symmetric bump-and-revalue solve.</p>
                    <div className="analysis-stats greek-stats" aria-label="Calculated short-rate sensitivities">
                      <span><b>Rate delta <Formula math={String.raw`\frac{\partial V}{\partial r}`} /></b> {solverResult.sensitivities.rateDelta.toFixed(6)}</span>
                      <span><b>Rate gamma <Formula math={String.raw`\frac{\partial^2V}{\partial r^2}`} /></b> {solverResult.sensitivities.rateGamma.toFixed(6)}</span>
                      <span><b>Rate vol νᵣ</b> {solverResult.sensitivities.volatilitySensitivity.toFixed(6)}</span>
                      <span><b>Method</b> grid + central bump</span>
                    </div>
                  </>
                ) : (
                  <>
                    <p>{mainTab === "Convergence" ? "Run the current product solver to generate a three-level refinement study." : "Run the current product to calculate its price sensitivities."}</p>
                    <div className="analysis-stats">
                      <span><b>Point tol</b> {contractSpec.tolerance.pointwiseAbsolute.toExponential(0)}</span>
                      <span><b>Max norm</b> {contractSpec.tolerance.maxNorm?.toExponential(0) ?? "n/a"}</span>
                      <span><b>Order</b> {contractSpec.tolerance.observedOrder ?? "n/a"}</span>
                      <span><b>Status</b> Run required</span>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}
          </section> : solverResult ? <section className="decide-visual-diagnostics-unavailable" aria-labelledby="decide-visuals-unavailable-title">
            <span className="card-label"><i /> Visual diagnostics</span>
            <h2 id="decide-visuals-unavailable-title">Update the result to view its plots</h2>
            <p>The retained result is stale or no longer matches the active case. Visuals are withheld so a previous model, scenario, or parameter set cannot appear under the current definition.</p>
            <button type="button" onClick={() => selectCaseStage("solve")}>Update in Solve <span>→</span></button>
          </section> : null}
          </DecideWorkspace>
          </> : null}
        </div>
        {activeStage !== "solve" && activeStage !== "condition" && <CaseNextActionBar
          stage={activeStage}
          status={activeStageStatus}
          message={caseNextAction.message}
          actionLabel={caseNextAction.actionLabel}
          disabled={caseNextAction.disabled}
          running={caseNextAction.running}
          onAction={caseNextAction.onAction}
        />}
      </section>
      <CaseTimelineDrawer
        open={timelineOpen}
        caseState={liveCaseRecord}
        onClose={() => setTimelineOpen(false)}
        onRestore={restoreTimelineRevision}
        onBranch={branchTimelineRevision}
      />
    </main>
  );
}
