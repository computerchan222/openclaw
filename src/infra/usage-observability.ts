/**
 * Usage Observability (Scope A)
 *
 * In-memory histogram-based instrumentation for the Phase 3 usage
 * aggregation pipeline. Records query path routing, latency, fallback
 * reasons, and reconciliation stats. Resets on process restart.
 *
 * Consumption: diagnostic events (OTEL) + snapshot endpoint.
 */
import { emitDiagnosticEvent } from "./diagnostic-events.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type QueryPath = "aggregate_fast_path" | "jsonl_fallback" | "range_bypass";

// Active reasons: aggregate_not_ready, aggregate_load_failed, missing_agent_state.
// Reserved (not yet wired): version_mismatch, degraded_mode.
export type FallbackReason =
  | "aggregate_not_ready"
  | "aggregate_load_failed"
  | "version_mismatch"
  | "degraded_mode"
  | "missing_agent_state";

export interface ReconciliationStatsSnapshot {
  runsCount: number;
  totalSessions: number;
  totalBytes: number;
  totalDurationMs: number;
  lastDurationMs: number;
  rebuildCount: number;
  errorCount: number;
}

export interface ObservabilitySnapshot {
  startedAt: number;
  uptimeMs: number;
  lastUpdatedAt: number;
  queries: {
    total: number;
    fastPathHits: number;
    fallbacksByReason: Record<string, number>;
    byPath: Record<
      QueryPath,
      {
        count: number;
        successCount: number;
        errorCount: number;
        latency: {
          buckets: Array<{ le: number; count: number }>;
          min: number;
          max: number;
          avg: number;
          estimatedP50: number;
          estimatedP95: number;
        };
      }
    >;
  };
  reconciliation: ReconciliationStatsSnapshot;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

const QUERY_PATHS: QueryPath[] = ["aggregate_fast_path", "jsonl_fallback", "range_bypass"];

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HistogramState {
  buckets: number[]; // length = LATENCY_BUCKETS.length + 1 (last = overflow)
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
}

interface PathStats {
  histogram: HistogramState;
  successCount: number;
  errorCount: number;
}

interface ReconciliationStats {
  runsCount: number;
  totalSessions: number;
  totalBytes: number;
  totalDurationMs: number;
  lastDurationMs: number;
  rebuildCount: number;
  errorCount: number;
}

interface ObservabilityState {
  startedAt: number;
  lastUpdatedAt: number;
  totalQueries: number;
  fastPathHits: number;
  fallbacksByReason: Record<FallbackReason, number>;
  byPath: Record<QueryPath, PathStats>;
  reconciliation: ReconciliationStats;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createEmptyHistogram(): HistogramState {
  return {
    buckets: Array.from({ length: LATENCY_BUCKETS.length + 1 }, () => 0),
    count: 0,
    sumMs: 0,
    minMs: Infinity,
    maxMs: 0,
  };
}

function createEmptyPathStats(): PathStats {
  return {
    histogram: createEmptyHistogram(),
    successCount: 0,
    errorCount: 0,
  };
}

function createEmptyState(): ObservabilityState {
  return {
    startedAt: Date.now(),
    lastUpdatedAt: 0,
    totalQueries: 0,
    fastPathHits: 0,
    fallbacksByReason: {
      aggregate_not_ready: 0,
      aggregate_load_failed: 0,
      version_mismatch: 0,
      degraded_mode: 0,
      missing_agent_state: 0,
    },
    byPath: {
      aggregate_fast_path: createEmptyPathStats(),
      jsonl_fallback: createEmptyPathStats(),
      range_bypass: createEmptyPathStats(),
    },
    reconciliation: {
      runsCount: 0,
      totalSessions: 0,
      totalBytes: 0,
      totalDurationMs: 0,
      lastDurationMs: 0,
      rebuildCount: 0,
      errorCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let state: ObservabilityState = createEmptyState();

// ---------------------------------------------------------------------------
// Histogram helpers
// ---------------------------------------------------------------------------

function recordHistogram(h: HistogramState, valueMs: number): void {
  let idx = LATENCY_BUCKETS.findIndex((b) => valueMs < b);
  if (idx === -1) {
    idx = LATENCY_BUCKETS.length; // overflow bucket
  }
  h.buckets[idx] += 1;
  h.count += 1;
  h.sumMs += valueMs;
  if (valueMs < h.minMs) {
    h.minMs = valueMs;
  }
  if (valueMs > h.maxMs) {
    h.maxMs = valueMs;
  }
}

/**
 * Estimate a percentile from histogram buckets.
 * Returns the upper bound of the bucket containing the target rank.
 */
function estimatePercentile(h: HistogramState, p: number): number {
  if (h.count === 0) {
    return 0;
  }
  const target = h.count * p;
  let cumulative = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    cumulative += h.buckets[i];
    if (cumulative >= target) {
      return i < LATENCY_BUCKETS.length
        ? LATENCY_BUCKETS[i]
        : (LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1] ?? 1000) * 2;
    }
  }
  return (LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1] ?? 1000) * 2;
}

// ---------------------------------------------------------------------------
// Recording API
// ---------------------------------------------------------------------------

export function recordUsageQuery(params: {
  agentId?: string;
  path: QueryPath;
  latencyMs: number;
  result: "success" | "error";
  fallbackReason?: FallbackReason;
}): void {
  state.totalQueries += 1;
  if (params.path === "aggregate_fast_path") {
    state.fastPathHits += 1;
  }
  if (params.fallbackReason) {
    state.fallbacksByReason[params.fallbackReason] += 1;
  }

  const pathStats = state.byPath[params.path];
  recordHistogram(pathStats.histogram, params.latencyMs);
  if (params.result === "success") {
    pathStats.successCount += 1;
  } else {
    pathStats.errorCount += 1;
  }

  state.lastUpdatedAt = Date.now();

  emitDiagnosticEvent({
    type: "optimization.usage_query",
    agentId: params.agentId,
    path: params.path,
    latencyMs: params.latencyMs,
    result: params.result,
    fallbackReason: params.fallbackReason,
  });
}

export function recordReconciliation(params: {
  agentId?: string;
  sessionsProcessed: number;
  bytesProcessed: number;
  durationMs: number;
  rebuilds: number;
  error: boolean;
}): void {
  const r = state.reconciliation;
  r.runsCount += 1;
  r.totalSessions += params.sessionsProcessed;
  r.totalBytes += params.bytesProcessed;
  r.totalDurationMs += params.durationMs;
  r.lastDurationMs = params.durationMs;
  r.rebuildCount += params.rebuilds;
  if (params.error) {
    r.errorCount += 1;
  }

  state.lastUpdatedAt = Date.now();

  emitDiagnosticEvent({
    type: "optimization.reconciliation",
    agentId: params.agentId,
    sessionsProcessed: params.sessionsProcessed,
    bytesProcessed: params.bytesProcessed,
    durationMs: params.durationMs,
    rebuilds: params.rebuilds,
    error: params.error,
  });
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function buildPathSnapshot(ps: PathStats) {
  const h = ps.histogram;
  return {
    count: h.count,
    successCount: ps.successCount,
    errorCount: ps.errorCount,
    latency: {
      // Last bucket uses +Infinity conceptually; serialize as a large sentinel for JSON safety
      buckets: LATENCY_BUCKETS.map((le, i) => ({ le, count: h.buckets[i] })).concat([
        { le: Number.MAX_SAFE_INTEGER, count: h.buckets[LATENCY_BUCKETS.length] },
      ]),
      min: h.count > 0 ? h.minMs : 0,
      max: h.maxMs,
      avg: h.count > 0 ? h.sumMs / h.count : 0,
      estimatedP50: estimatePercentile(h, 0.5),
      estimatedP95: estimatePercentile(h, 0.95),
    },
  };
}

export function getOptimizationSnapshot(): ObservabilitySnapshot {
  const byPath = {} as ObservabilitySnapshot["queries"]["byPath"];
  for (const p of QUERY_PATHS) {
    byPath[p] = buildPathSnapshot(state.byPath[p]);
  }
  return {
    startedAt: state.startedAt,
    uptimeMs: Date.now() - state.startedAt,
    lastUpdatedAt: state.lastUpdatedAt,
    queries: {
      total: state.totalQueries,
      fastPathHits: state.fastPathHits,
      fallbacksByReason: { ...state.fallbacksByReason },
      byPath,
    },
    reconciliation: { ...state.reconciliation },
  };
}

// ---------------------------------------------------------------------------
// Reset (test-only)
// ---------------------------------------------------------------------------

/** Reset all observability state. For tests only. */
export function resetObservabilityState(): void {
  state = createEmptyState();
}
