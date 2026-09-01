/// <reference lib="webworker" />

import { calibrateHestonSurface } from "../lib/market-data/heston-calibration.ts";
import type { HestonCalibrationResult, MarketSnapshot } from "../lib/market-data/types.ts";

export type HestonCalibrationWorkerRequest = {
  type: "calibrate";
  jobId: number;
  snapshot: MarketSnapshot;
  startedAt: string;
};

export type HestonCalibrationWorkerResponse =
  | { type: "completed"; jobId: number; result: HestonCalibrationResult }
  | { type: "failed"; jobId: number; error: string };

self.onmessage = (event: MessageEvent<HestonCalibrationWorkerRequest>) => {
  const message = event.data;
  if (message.type !== "calibrate") return;
  try {
    const details = message.snapshot.heston;
    const spot = Number(message.snapshot.proposals.find((item) => item.id === "spot")?.proposedValue);
    if (!details || !Number.isFinite(spot)) throw new Error("The Heston surface snapshot is incomplete.");
    const result = calibrateHestonSurface({
      spot, instruments: details.instruments, seeds: details.seeds,
      objective: details.calibrationSettings.objective,
      useOpenInterest: details.calibrationSettings.useOpenInterest,
      randomSeed: details.calibrationSettings.seed,
      multiStarts: details.calibrationSettings.multiStarts,
      maximumEvaluations: details.calibrationSettings.maximumEvaluations,
      quadratureOrder: 24, startedAt: message.startedAt, completedAt: new Date().toISOString(),
    });
    self.postMessage({ type: "completed", jobId: message.jobId, result } satisfies HestonCalibrationWorkerResponse);
  } catch (error) {
    self.postMessage({
      type: "failed", jobId: message.jobId,
      error: error instanceof Error ? error.message : "Heston calibration failed.",
    } satisfies HestonCalibrationWorkerResponse);
  }
};

export {};
