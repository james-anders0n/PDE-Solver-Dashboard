/// <reference lib="webworker" />

import {
  createParameterUncertaintyKey,
  runParameterUncertaintyPropagation,
  type ParameterUncertaintyRequest,
  type ParameterUncertaintyResult,
} from "@/app/lib/parameter-uncertainty";

export type ParameterUncertaintyWorkerRequest =
  | { type: "run"; jobId: number; request: ParameterUncertaintyRequest }
  | { type: "cancel"; jobId: number };

export type ParameterUncertaintyWorkerMessage =
  | { type: "progress"; jobId: number; progress: number; stage: string }
  | { type: "complete"; jobId: number; cacheHit: boolean; result: ParameterUncertaintyResult }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const resultCache = new Map<string, ParameterUncertaintyResult>();
const cancelledJobs = new Set<number>();
const MAX_CACHE_ENTRIES = 4;

const post = (message: ParameterUncertaintyWorkerMessage) => workerScope.postMessage(message);

workerScope.onmessage = (event: MessageEvent<ParameterUncertaintyWorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledJobs.add(message.jobId);
    return;
  }
  const { jobId, request } = message;
  try {
    const key = createParameterUncertaintyKey(request);
    const cached = resultCache.get(key);
    if (cached) {
      resultCache.delete(key);
      resultCache.set(key, cached);
      post({ type: "progress", jobId, progress: 96, stage: "Loading identical propagation result from cache" });
      post({ type: "complete", jobId, cacheHit: true, result: cached });
      return;
    }
    const result = runParameterUncertaintyPropagation(
      request,
      (progress, stage) => post({ type: "progress", jobId, progress, stage }),
      () => cancelledJobs.has(jobId),
    );
    resultCache.set(key, result);
    if (resultCache.size > MAX_CACHE_ENTRIES) {
      const oldest = resultCache.keys().next().value as string | undefined;
      if (oldest) resultCache.delete(oldest);
    }
    post({ type: "complete", jobId, cacheHit: false, result });
  } catch (error) {
    if (cancelledJobs.has(jobId) || (error instanceof Error && /cancelled/i.test(error.message))) {
      post({ type: "cancelled", jobId });
    } else {
      post({ type: "error", jobId, message: error instanceof Error ? error.message : "Parameter propagation failed." });
    }
  } finally {
    cancelledJobs.delete(jobId);
  }
};

export {};
