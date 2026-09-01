/// <reference lib="webworker" />

import {
  createSolverJobKey,
  executeSolverJob,
  type SolverJobResult,
  type SolverWorkerMessage,
  type SolverWorkerRequest,
} from "@/app/lib/solver-jobs";
import { ComputationCancelledError } from "@/app/lib/computation-control";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const resultCache = new Map<string, SolverJobResult>();
const cancelledJobs = new Set<number>();
const MAX_CACHE_ENTRIES = 8;

function post(message: SolverWorkerMessage) {
  workerScope.postMessage(message);
}

workerScope.onmessage = (event: MessageEvent<SolverWorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledJobs.add(message.jobId);
    return;
  }
  const { jobId, job } = message;

  try {
    const control = { isCancelled: () => cancelledJobs.has(jobId) };
    const key = createSolverJobKey(job);
    const cached = resultCache.get(key);
    if (cached) {
      resultCache.delete(key);
      resultCache.set(key, cached);
      post({ type: "progress", jobId, progress: 96, stage: "Loading identical validated run from cache" });
      post({ type: "complete", jobId, cacheHit: true, elapsedMs: 0, payload: cached });
      return;
    }

    const startedAt = performance.now();
    const payload = executeSolverJob(job, (progress, stage) => {
      post({ type: "progress", jobId, progress, stage });
    }, control);
    resultCache.set(key, payload);
    if (resultCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = resultCache.keys().next().value as string | undefined;
      if (oldestKey) resultCache.delete(oldestKey);
    }
    post({ type: "complete", jobId, cacheHit: false, elapsedMs: performance.now() - startedAt, payload });
  } catch (error) {
    if (error instanceof ComputationCancelledError) {
      post({ type: "cancelled", jobId });
      return;
    }
    post({
      type: "error",
      jobId,
      message: error instanceof Error ? error.message : "The background numerical solve failed.",
    });
  } finally {
    cancelledJobs.delete(jobId);
  }
};

export {};
