# Scope A: Optimization Pipeline Observability

**Date:** 2026-03-09
**Status:** IMPLEMENTED
**Scope:** Instrumentation to measure whether Phases 0-3 token cost optimizations are working in production.
**Commits:** `e03c8f9bb` (core module), `5585efe27` (instrumentation + endpoint), `bfcc41844` (stage ordering fix)

## Goal

Answer these questions with data:

1. Are most usage/cost queries hitting the aggregate fast path?
2. Are fast-path calls concentrated in the lowest latency buckets?
3. When fallback happens, why?
4. Is startup reconciliation becoming a bottleneck?

## Approach

**Approach A: Inline instrumentation module.** A single `usage-observability.ts` module maintains histogram state in memory, fires diagnostic events for OTEL, and exposes a snapshot getter for a REST endpoint.

## Data Structures

```typescript
const LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000]; // ms

type QueryPath = "aggregate_fast_path" | "jsonl_fallback" | "range_bypass";

type FallbackReason =
  | "aggregate_not_ready"
  | "aggregate_load_failed"
  | "version_mismatch"
  | "degraded_mode"
  | "missing_agent_state";

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
```

### Design Decisions

- **`range_bypass` is a path, not a fallback reason.** It represents an intentional routing choice (e.g. single-session query), not degradation.
- **Fallback reasons reflect real branch semantics.** Derived from actual system state at the decision point, not inferred from null returns.
- **Success/error counts are separate from histogram counts.** Prevents failure latency from muddying performance signal.
- **Units explicit in field names** (`sumMs`, `minMs`, `maxMs`) to avoid ambiguity.

## Public API

### Recording (called from instrumented code)

```typescript
function recordUsageQuery(params: {
  agentId?: string;
  path: QueryPath;
  latencyMs: number;
  result: "success" | "error";
  fallbackReason?: FallbackReason;
}): void;

function recordReconciliation(params: {
  agentId?: string;
  sessionsProcessed: number;
  bytesProcessed: number;
  durationMs: number;
  rebuilds: number;
  error: boolean;
}): void;
```

### Reading (called from snapshot endpoint)

```typescript
function getOptimizationSnapshot(): ObservabilitySnapshot;
```

### Lifecycle

```typescript
function resetObservabilityState(): void; // test-only
```

## Snapshot Shape

```typescript
interface ObservabilitySnapshot {
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
  reconciliation: ReconciliationStats;
}
```

Percentile estimates computed via linear interpolation across histogram buckets. Not exact, but sufficient for "is p95 under 50ms?".

## Instrumentation Points

### 1. `session-cost-usage.ts` → `loadCostUsageSummary()`

Single-record-per-query pattern with early variable capture:

```typescript
const start = performance.now();
let queryPath: QueryPath;
let fallbackReason: FallbackReason | undefined;

if (/* shape skips aggregate */) {
  queryPath = "range_bypass";
} else if (!isAnyUsageAggregationReady()) {
  queryPath = "jsonl_fallback";
  fallbackReason = "aggregate_not_ready";
} else {
  const aggregated = getAggregatedCostUsage(...);
  if (aggregated) {
    queryPath = "aggregate_fast_path";
  } else {
    queryPath = "jsonl_fallback";
    fallbackReason = determineAggregateSkipReason(...);
  }
}

// ... JSONL scan if jsonl_fallback ...

recordUsageQuery({ agentId, path: queryPath, latencyMs, result, fallbackReason });
```

`determineAggregateSkipReason()` checks actual system state — not "null therefore failed."

### 2. `usage-aggregation.ts` → `reconcileUsageAggregates()`

Wraps the per-agent reconciliation loop:

```typescript
const start = performance.now();
// ... existing reconciliation ...
recordReconciliation({
  agentId,
  sessionsProcessed,
  bytesProcessed,
  durationMs: performance.now() - start,
  rebuilds: rebuildCount,
  error: false,
});
```

## Consumption

### Diagnostic Events (OTEL)

Each record call fires:

- `optimization.usage_query` — `{ agentId, path, latencyMs, result, fallbackReason }`
- `optimization.reconciliation` — `{ agentId, sessionsProcessed, bytesProcessed, durationMs }`

OTEL extension subscribes and maps to its existing metric patterns.

### Snapshot Endpoint

Gateway exposes `GET /diagnostics/optimization-stats` returning `ObservabilitySnapshot`.

## Histogram Buckets

```
<1ms, 1-5ms, 5-10ms, 10-25ms, 25-50ms, 50-100ms, 100-250ms, 250-500ms, 500ms-1s, >1s
```

Designed to distinguish:

- Truly instant aggregate reads (<5ms)
- Acceptable reads (5-50ms)
- Suspicious slowdowns (50-250ms)
- Full file scan territory (>250ms)

## Metrics Priority

**Must-haves (this implementation):**

1. Aggregate fast-path hit rate
2. Query latency by path (histogram)
3. Fallback count + reason breakdown
4. Reconciliation stats (sessions, bytes, duration, rebuilds, errors)

**Nice-to-haves (later):** 5. Flush count / duration / bytes per flush

## Not In Scope

- Per-agent breakdowns in snapshot (field captured, aggregation deferred)
- Scope B: per-turn agent token pipeline observability
- Persistent storage of observability data (in-memory only, resets on restart)
- Alerting or threshold-based warnings

---

## Implementation Notes

### Files Created/Modified

| File                                    | Change               | Role                                                                                                                           |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/infra/usage-observability.ts`      | Created (~330 lines) | Core module: types, histogram state, recording API, snapshot getter                                                            |
| `src/infra/usage-observability.test.ts` | Created (10 tests)   | Unit tests: empty state, paths, fallbacks, histograms, percentiles, reconciliation, reset, JSON safety                         |
| `src/infra/diagnostic-events.ts`        | Modified             | Added `DiagnosticOptimizationQueryEvent` and `DiagnosticOptimizationReconciliationEvent` to the `DiagnosticEventPayload` union |
| `src/infra/session-cost-usage.ts`       | Modified             | Instrumented `loadCostUsageSummary()` with single-record-per-query pattern                                                     |
| `src/infra/usage-aggregation.ts`        | Modified             | Instrumented `reconcileAgentAggregate()` with counters for sessions, bytes, rebuilds                                           |
| `src/gateway/server-http.ts`            | Modified             | Added `handleOptimizationStatsRequest()` handler + registered `optimization-stats` stage                                       |

### Integration with OpenClaw Infrastructure

**Diagnostic events** (`src/infra/diagnostic-events.ts`):

- Observability hooks into the existing global `emitDiagnosticEvent()` / `onDiagnosticEvent()` pub-sub pattern (lines 216-256).
- Two new event types extend the `DiagnosticEventPayload` discriminated union. OTEL subscribers receive them automatically.
- Recursion guard (`dispatchDepth > 100`) protects against feedback loops from listeners that trigger further events.

**Gateway HTTP request pipeline** (`src/gateway/server-http.ts`):

- The gateway uses a sequential `requestStages` array (type `GatewayHttpRequestStage`, lines 243-256). Each stage returns `true` if it handled the request; execution stops on first match.
- `optimization-stats` is registered **before** the control-ui catch-all SPA handler and **before** `gateway-probes` (/health, /healthz, /ready, /readyz).
- The endpoint follows the same pattern as `handleGatewayProbeRequest` (lines 154-182): no auth, `Cache-Control: no-store`, HEAD support, 405 for other methods.
- **Bug found during live testing:** Originally registered after control-ui, which swallowed the request. Fixed in `bfcc41844`.

**Usage aggregation startup** (`src/gateway/server-startup.ts:191-193`):

- `initUsageAggregation(agentIds, config)` initializes per-agent aggregate state.
- `initSessionIndex(agentIds).then(() => reconcileUsageAggregates())` runs startup reconciliation.
- Both reconciliation and subsequent queries automatically record to the observability module since the imports are at module scope.

**Session cost usage pipeline** (`src/infra/session-cost-usage.ts`):

- `loadCostUsageSummary()` is the central query function called by `usage.cost` RPC, the `/usage cost` chat command, and the dashboard UI.
- Phase 3 added the aggregate fast-path: `isAnyUsageAggregationReady()` → `getAggregatedCostUsage()`. If aggregate serves, returns immediately. Otherwise falls back to JSONL scanning.
- Observability wraps this decision tree: `performance.now()` at entry, path+reason determined at each branch, single record emitted via `try/finally`.

### Deviations from Design

| Design                                           | Implementation                          | Reason                                                               |
| ------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------- |
| Overflow bucket `le: Infinity`                   | `le: Number.MAX_SAFE_INTEGER`           | `JSON.stringify(Infinity)` produces `null` — breaks consumers        |
| "Linear interpolation" for percentiles           | Bucket upper-bound approximation        | Simpler, sufficient for "is p95 under 50ms?" use case                |
| `as never` casts for diagnostic events           | Proper union types                      | Task 6 added types to the union, removing all casts                  |
| Stage registered "before gateway-probes"         | Registered before control-ui AND probes | Control-ui SPA catch-all would swallow the endpoint otherwise        |
| `range_bypass` wired to `loadSessionCostSummary` | Reserved, not yet wired                 | Single-session queries don't yet use this path                       |
| `version_mismatch`, `degraded_mode` reasons      | Reserved, documented as not-yet-wired   | No code path currently produces these; future aggregation edge cases |

### Live Test Results

Verified on running gateway (Mac mini, port 18789):

| Scenario                                       | Path                  | Latency | Fallback Reason                                  |
| ---------------------------------------------- | --------------------- | ------- | ------------------------------------------------ |
| No aggregation initialized                     | `jsonl_fallback`      | ~1ms    | `aggregate_not_ready`                            |
| After reconciliation                           | `aggregate_fast_path` | ~1.2ms  | none                                             |
| Gateway startup reconciliation                 | n/a                   | ~0.17ms | 0 sessions (no new data)                         |
| Endpoint `GET /diagnostics/optimization-stats` | n/a                   | n/a     | Returns full JSON snapshot, all fields populated |
