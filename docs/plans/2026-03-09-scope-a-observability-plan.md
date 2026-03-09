# Scope A: Optimization Pipeline Observability — Implementation Plan

> **Status:** COMPLETE. All 8 tasks implemented, reviewed, tested, and pushed.

**Goal:** Instrument the Phase 3 usage aggregation pipeline to prove whether optimizations are working in production — fast-path hit rate, latency by path, fallback reasons, reconciliation stats.

**Architecture:** A single `usage-observability.ts` module holds histogram state in memory. Two instrumentation points (`loadCostUsageSummary` and `reconcileUsageAggregates`) record metrics. Diagnostic events fire for OTEL. A gateway endpoint exposes a JSON snapshot.

**Tech Stack:** TypeScript (ESM), Vitest, Node `performance.now()`, existing diagnostic events system.

**Design doc:** `docs/plans/2026-03-09-scope-a-observability-design.md`

### Final Commits

| Commit      | Description                                                                            |
| ----------- | -------------------------------------------------------------------------------------- |
| `e03c8f9bb` | Core module: `usage-observability.ts` + 10 unit tests + diagnostic event types         |
| `5585efe27` | Instrumentation: `loadCostUsageSummary` + `reconcileAgentAggregate` + gateway endpoint |
| `bfcc41844` | Fix: register diagnostic endpoints before control-ui catch-all                         |

### Issues Found During Implementation

1. **`sendJson` import conflict** — `server-http.ts` already had a local `sendJson` function. Adding the import from `http-common.js` caused TS2440. Fix: used the existing local function.
2. **`Infinity` in JSON** — Overflow histogram bucket used `le: Infinity` which becomes `null` in `JSON.stringify()`. Fix: changed to `le: Number.MAX_SAFE_INTEGER`.
3. **Stage ordering** — `/diagnostics/optimization-stats` was registered after the control-ui SPA catch-all, which swallowed all unknown paths. Fix: moved diagnostic + probe stages before control-ui.
4. **Pre-existing lint** — `session-cost-usage.test.ts` had `.sort()` should be `.toSorted()` errors. Pre-existing, not introduced by this work.

---

### Task 1: Create `usage-observability.ts` — types + state + histogram helpers

**Files:**

- Create: `src/infra/usage-observability.ts`

**Step 1: Write the failing test**

Create `src/infra/usage-observability.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import {
  getOptimizationSnapshot,
  recordUsageQuery,
  resetObservabilityState,
} from "./usage-observability.js";

describe("usage-observability", () => {
  afterEach(() => {
    resetObservabilityState();
  });

  it("returns empty snapshot before any recordings", () => {
    const snap = getOptimizationSnapshot();
    expect(snap.queries.total).toBe(0);
    expect(snap.queries.fastPathHits).toBe(0);
    expect(snap.queries.byPath.aggregate_fast_path.count).toBe(0);
    expect(snap.queries.byPath.jsonl_fallback.count).toBe(0);
    expect(snap.queries.byPath.range_bypass.count).toBe(0);
    expect(snap.reconciliation.runsCount).toBe(0);
    expect(snap.startedAt).toBeGreaterThan(0);
    expect(snap.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("records a fast-path query into histogram", () => {
    recordUsageQuery({
      path: "aggregate_fast_path",
      latencyMs: 0.5,
      result: "success",
    });

    const snap = getOptimizationSnapshot();
    expect(snap.queries.total).toBe(1);
    expect(snap.queries.fastPathHits).toBe(1);

    const fp = snap.queries.byPath.aggregate_fast_path;
    expect(fp.count).toBe(1);
    expect(fp.successCount).toBe(1);
    expect(fp.errorCount).toBe(0);
    // 0.5ms falls in first bucket (le=1)
    expect(fp.latency.buckets[0]?.count).toBe(1);
    expect(fp.latency.min).toBe(0.5);
    expect(fp.latency.max).toBe(0.5);
    expect(fp.latency.avg).toBe(0.5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/infra/usage-observability.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write minimal implementation**

Create `src/infra/usage-observability.ts` with:

- Type exports: `QueryPath`, `FallbackReason`
- Constants: `LATENCY_BUCKETS`
- Internal types: `HistogramState`, `PathStats`, `ReconciliationStats`, `ObservabilityState`
- Snapshot type: `ObservabilitySnapshot` (exported)
- Module state: `let state: ObservabilityState` initialized via `createEmptyState()`
- `createEmptyState()` — returns zeroed state with `startedAt: Date.now()`
- `createEmptyHistogram()` — returns zeroed histogram with `minMs: Infinity`, `maxMs: 0`
- `createEmptyPathStats()` — wraps empty histogram + zero counters
- `recordHistogram(histogram, valueMs)` — find bucket index via `LATENCY_BUCKETS.findIndex(b => valueMs < b)`, increment. Update min/max/sum/count.
- `estimatePercentile(histogram, p)` — linear interpolation across buckets
- `recordUsageQuery(params)` — increment totalQueries, conditionally increment fastPathHits, update byPath[params.path] histogram + success/error, update fallbacksByReason if applicable, set lastUpdatedAt
- `recordReconciliation(params)` — update reconciliation stats
- `getOptimizationSnapshot()` — build snapshot from state, compute uptimeMs/avg/p50/p95
- `resetObservabilityState()` — reassign state to `createEmptyState()`

Full implementation (~180 lines):

```typescript
/**
 * Usage Observability (Scope A)
 *
 * In-memory histogram-based instrumentation for the Phase 3 usage
 * aggregation pipeline. Records query path routing, latency, fallback
 * reasons, and reconciliation stats.
 *
 * Consumption: diagnostic events (OTEL) + snapshot endpoint.
 */
import { emitDiagnosticEvent } from "./diagnostic-events.js";

// --- Public types ---

export type QueryPath = "aggregate_fast_path" | "jsonl_fallback" | "range_bypass";

export type FallbackReason =
  | "aggregate_not_ready"
  | "aggregate_load_failed"
  | "version_mismatch"
  | "degraded_mode"
  | "missing_agent_state";

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

export interface ReconciliationStatsSnapshot {
  runsCount: number;
  totalSessions: number;
  totalBytes: number;
  totalDurationMs: number;
  lastDurationMs: number;
  rebuildCount: number;
  errorCount: number;
}

// --- Constants ---

export const LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

const QUERY_PATHS: QueryPath[] = ["aggregate_fast_path", "jsonl_fallback", "range_bypass"];

// --- Internal types ---

interface HistogramState {
  buckets: number[];
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

// --- Helpers ---

function createEmptyHistogram(): HistogramState {
  return {
    buckets: new Array(LATENCY_BUCKETS.length + 1).fill(0),
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

function estimatePercentile(h: HistogramState, p: number): number {
  if (h.count === 0) {
    return 0;
  }
  const target = h.count * p;
  let cumulative = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    cumulative += h.buckets[i];
    if (cumulative >= target) {
      // Return the upper bound of this bucket
      return i < LATENCY_BUCKETS.length ? LATENCY_BUCKETS[i] : (LATENCY_BUCKETS.at(-1) ?? 1000) * 2;
    }
  }
  return (LATENCY_BUCKETS.at(-1) ?? 1000) * 2;
}

// --- Module state ---

let state = createEmptyState();

// --- Public API ---

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
    type: "optimization.usage_query" as never,
    agentId: params.agentId,
    path: params.path,
    latencyMs: params.latencyMs,
    result: params.result,
    fallbackReason: params.fallbackReason,
  } as never);
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
    type: "optimization.reconciliation" as never,
    agentId: params.agentId,
    sessionsProcessed: params.sessionsProcessed,
    bytesProcessed: params.bytesProcessed,
    durationMs: params.durationMs,
    rebuilds: params.rebuilds,
    error: params.error,
  } as never);
}

function buildPathSnapshot(ps: PathStats) {
  const h = ps.histogram;
  return {
    count: h.count,
    successCount: ps.successCount,
    errorCount: ps.errorCount,
    latency: {
      buckets: LATENCY_BUCKETS.map((le, i) => ({ le, count: h.buckets[i] })).concat([
        { le: Infinity, count: h.buckets[LATENCY_BUCKETS.length] },
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

/** Test-only: reset all state. */
export function resetObservabilityState(): void {
  state = createEmptyState();
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test src/infra/usage-observability.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
scripts/committer "infra: add usage-observability module with histogram state" src/infra/usage-observability.ts src/infra/usage-observability.test.ts
```

---

### Task 2: Comprehensive tests for observability module

**Files:**

- Modify: `src/infra/usage-observability.test.ts`

**Step 1: Write additional failing tests**

Add to `src/infra/usage-observability.test.ts`:

```typescript
it("tracks fallback reasons separately from path counts", () => {
  recordUsageQuery({
    path: "jsonl_fallback",
    latencyMs: 120,
    result: "success",
    fallbackReason: "aggregate_not_ready",
  });
  recordUsageQuery({
    path: "jsonl_fallback",
    latencyMs: 200,
    result: "success",
    fallbackReason: "missing_agent_state",
  });

  const snap = getOptimizationSnapshot();
  expect(snap.queries.total).toBe(2);
  expect(snap.queries.fastPathHits).toBe(0);
  expect(snap.queries.fallbacksByReason.aggregate_not_ready).toBe(1);
  expect(snap.queries.fallbacksByReason.missing_agent_state).toBe(1);

  const fb = snap.queries.byPath.jsonl_fallback;
  expect(fb.count).toBe(2);
  expect(fb.successCount).toBe(2);
});

it("separates success and error counts per path", () => {
  recordUsageQuery({ path: "jsonl_fallback", latencyMs: 50, result: "success" });
  recordUsageQuery({ path: "jsonl_fallback", latencyMs: 300, result: "error" });
  recordUsageQuery({ path: "jsonl_fallback", latencyMs: 80, result: "success" });

  const snap = getOptimizationSnapshot();
  const fb = snap.queries.byPath.jsonl_fallback;
  expect(fb.successCount).toBe(2);
  expect(fb.errorCount).toBe(1);
  expect(fb.count).toBe(3);
});

it("range_bypass does not count as fast-path or increment fallback reasons", () => {
  recordUsageQuery({ path: "range_bypass", latencyMs: 10, result: "success" });

  const snap = getOptimizationSnapshot();
  expect(snap.queries.total).toBe(1);
  expect(snap.queries.fastPathHits).toBe(0);
  // No fallback reasons incremented
  for (const count of Object.values(snap.queries.fallbacksByReason)) {
    expect(count).toBe(0);
  }
  expect(snap.queries.byPath.range_bypass.count).toBe(1);
});

it("places latency values in correct histogram buckets", () => {
  // <1ms bucket
  recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 0.3, result: "success" });
  // 5-10ms bucket
  recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 7, result: "success" });
  // >1000ms overflow bucket
  recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 1500, result: "success" });

  const snap = getOptimizationSnapshot();
  const buckets = snap.queries.byPath.aggregate_fast_path.latency.buckets;

  // le=1 bucket (index 0): 0.3ms
  expect(buckets[0]?.count).toBe(1);
  // le=10 bucket (index 2): 7ms
  expect(buckets[2]?.count).toBe(1);
  // overflow bucket (last): 1500ms
  expect(buckets[buckets.length - 1]?.count).toBe(1);

  expect(snap.queries.byPath.aggregate_fast_path.latency.min).toBe(0.3);
  expect(snap.queries.byPath.aggregate_fast_path.latency.max).toBe(1500);
});

it("computes estimated p50 and p95 from histogram", () => {
  // 100 fast queries under 1ms
  for (let i = 0; i < 100; i++) {
    recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 0.5, result: "success" });
  }
  // 5 slow queries at 500ms
  for (let i = 0; i < 5; i++) {
    recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 500, result: "success" });
  }

  const snap = getOptimizationSnapshot();
  const lat = snap.queries.byPath.aggregate_fast_path.latency;
  // p50 should be in the <1ms bucket
  expect(lat.estimatedP50).toBe(1);
  // p95 should still be in the <1ms bucket (100 of 105 are <1ms)
  expect(lat.estimatedP95).toBe(1);
});

it("records reconciliation stats", () => {
  recordReconciliation({
    sessionsProcessed: 10,
    bytesProcessed: 50000,
    durationMs: 42,
    rebuilds: 1,
    error: false,
  });
  recordReconciliation({
    sessionsProcessed: 5,
    bytesProcessed: 20000,
    durationMs: 18,
    rebuilds: 0,
    error: true,
  });

  const snap = getOptimizationSnapshot();
  expect(snap.reconciliation.runsCount).toBe(2);
  expect(snap.reconciliation.totalSessions).toBe(15);
  expect(snap.reconciliation.totalBytes).toBe(70000);
  expect(snap.reconciliation.totalDurationMs).toBe(60);
  expect(snap.reconciliation.lastDurationMs).toBe(18);
  expect(snap.reconciliation.rebuildCount).toBe(1);
  expect(snap.reconciliation.errorCount).toBe(1);
});

it("resets state cleanly", () => {
  recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 1, result: "success" });
  recordReconciliation({
    sessionsProcessed: 5,
    bytesProcessed: 1000,
    durationMs: 10,
    rebuilds: 0,
    error: false,
  });

  resetObservabilityState();

  const snap = getOptimizationSnapshot();
  expect(snap.queries.total).toBe(0);
  expect(snap.reconciliation.runsCount).toBe(0);
  expect(snap.startedAt).toBeGreaterThan(0);
});
```

**Step 2: Run tests to verify they pass**

Run: `pnpm test src/infra/usage-observability.test.ts`
Expected: PASS (all 9 tests — 2 from Task 1 + 7 new)

**Step 3: Commit**

```bash
scripts/committer "test: comprehensive observability histogram and counter tests" src/infra/usage-observability.test.ts
```

---

### Task 3: Instrument `loadCostUsageSummary()`

**Files:**

- Modify: `src/infra/session-cost-usage.ts:320-421` (the `loadCostUsageSummary` function)

**Step 1: Write the failing test**

Add to `src/infra/usage-observability.test.ts`:

```typescript
import { loadCostUsageSummary, clearSessionSummaryCache } from "./session-cost-usage.js";

// ... inside the describe block:

it("loadCostUsageSummary records aggregate_fast_path when aggregate serves", async () => {
  // This test verifies instrumentation is wired in.
  // Setup: create a temp dir with a session file, init aggregation, reconcile
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obs-fp-"));
  const sessionsDir = path.join(root, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "sess-obs.jsonl"),
    makeUsageEntry(
      "2026-03-09T10:00:00.000Z",
      { input: 100, output: 50 },
      {
        cost: { total: 0.001 },
      },
    ),
  );

  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    initUsageAggregation(["main"], {});
    await initSessionIndex(["main"]);
    await reconcileUsageAggregates();
    resetObservabilityState();

    await loadCostUsageSummary({
      startMs: Date.parse("2026-03-09T00:00:00.000Z"),
      endMs: Date.parse("2026-03-09T23:59:59.999Z"),
    });

    const snap = getOptimizationSnapshot();
    expect(snap.queries.total).toBe(1);
    expect(snap.queries.fastPathHits).toBe(1);
    expect(snap.queries.byPath.aggregate_fast_path.count).toBe(1);
    expect(snap.queries.byPath.aggregate_fast_path.successCount).toBe(1);

    shutdownUsageAggregation();
    shutdownSessionIndex();
  });
});
```

Note: This test requires additional imports — `fs`, `os`, `path`, `withEnvAsync`, `initUsageAggregation`, etc. These will be added alongside the test. Alternatively, this integration test can go in a separate file `src/infra/usage-observability.integration.test.ts` to keep unit tests separate.

**Step 2: Run test to verify it fails**

Run: `pnpm test src/infra/usage-observability`
Expected: FAIL — `loadCostUsageSummary` doesn't call `recordUsageQuery` yet

**Step 3: Instrument `loadCostUsageSummary`**

Modify `src/infra/session-cost-usage.ts`:

1. Add imports at the top:

```typescript
import type { FallbackReason, QueryPath } from "./usage-observability.js";
import { recordUsageQuery } from "./usage-observability.js";
```

2. Replace the `loadCostUsageSummary` function body (lines 320-421) with instrumented version using the single-record-per-query pattern:

```typescript
export async function loadCostUsageSummary(params?: {
  startMs?: number;
  endMs?: number;
  days?: number;
  config?: OpenClawConfig;
  agentId?: string;
}): Promise<CostUsageSummary> {
  const start = performance.now();
  let queryPath: QueryPath;
  let fallbackReason: FallbackReason | undefined;
  const agentId = params?.agentId;

  const now = new Date();
  let sinceTime: number;
  let untilTime: number;

  if (params?.startMs !== undefined && params?.endMs !== undefined) {
    sinceTime = params.startMs;
    untilTime = params.endMs;
  } else {
    const days = Math.max(1, Math.floor(params?.days ?? 30));
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    sinceTime = since.getTime();
    untilTime = now.getTime();
  }

  // Phase 3: try persistent aggregate first
  if (isAnyUsageAggregationReady()) {
    const aggregated = getAggregatedCostUsage({
      agentId: params?.agentId,
      startMs: sinceTime,
      endMs: untilTime,
    });
    if (aggregated) {
      queryPath = "aggregate_fast_path";
      recordUsageQuery({
        agentId,
        path: queryPath,
        latencyMs: performance.now() - start,
        result: "success",
      });
      return aggregated;
    }
    // Aggregate was ready but returned null — determine why
    queryPath = "jsonl_fallback";
    fallbackReason = params?.agentId && !isUsageAggregationReady(params.agentId)
      ? "missing_agent_state"
      : "aggregate_load_failed";
  } else {
    queryPath = "jsonl_fallback";
    fallbackReason = "aggregate_not_ready";
  }

  // JSONL fallback scan (existing code unchanged)
  let result: "success" | "error" = "success";
  try {
    // ... existing JSONL scan logic (lines 355-420) ...
    const summary = /* existing scan result */;
    return summary;
  } catch (err) {
    result = "error";
    throw err;
  } finally {
    recordUsageQuery({
      agentId,
      path: queryPath,
      latencyMs: performance.now() - start,
      result,
      fallbackReason,
    });
  }
}
```

The key changes:

- Add `performance.now()` timer at function start
- Determine `queryPath` and `fallbackReason` at each decision branch
- Early return for fast-path records immediately
- JSONL fallback wraps in try/catch/finally to record on both success and error
- Import `isUsageAggregationReady` (already imported) to determine specific fallback reason

**Step 4: Run test to verify it passes**

Run: `pnpm test src/infra/usage-observability`
Expected: PASS

**Step 5: Run full test suite to check for regressions**

Run: `pnpm test src/infra/usage-aggregation.test.ts src/infra/usage-observability`
Expected: PASS (all existing + new tests)

**Step 6: Commit**

```bash
scripts/committer "infra: instrument loadCostUsageSummary with observability recording" src/infra/session-cost-usage.ts src/infra/usage-observability.test.ts
```

---

### Task 4: Instrument `reconcileUsageAggregates()`

**Files:**

- Modify: `src/infra/usage-aggregation.ts:144-148` (the `reconcileUsageAggregates` function)
- Modify: `src/infra/usage-aggregation.ts:373-417` (the `reconcileAgentAggregate` function)

**Step 1: Write the failing test**

Add integration test to `src/infra/usage-observability.test.ts` (or the integration test file):

```typescript
it("reconcileUsageAggregates records reconciliation stats", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obs-recon-"));
  const sessionsDir = path.join(root, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "sess-r1.jsonl"),
    makeUsageEntry(
      "2026-03-09T10:00:00.000Z",
      { input: 100, output: 50 },
      {
        cost: { total: 0.001 },
      },
    ),
  );

  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    resetObservabilityState();
    initUsageAggregation(["main"], {});
    await initSessionIndex(["main"]);
    await reconcileUsageAggregates();

    const snap = getOptimizationSnapshot();
    expect(snap.reconciliation.runsCount).toBe(1);
    expect(snap.reconciliation.totalSessions).toBeGreaterThanOrEqual(1);
    expect(snap.reconciliation.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(snap.reconciliation.errorCount).toBe(0);

    shutdownUsageAggregation();
    shutdownSessionIndex();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test src/infra/usage-observability`
Expected: FAIL — reconciliation doesn't call `recordReconciliation`

**Step 3: Instrument reconciliation**

Modify `src/infra/usage-aggregation.ts`:

1. Add import:

```typescript
import { recordReconciliation } from "./usage-observability.js";
```

2. Modify `reconcileAgentAggregate` to track stats and call `recordReconciliation`:

```typescript
async function reconcileAgentAggregate(state: AgentAggregateState): Promise<void> {
  const start = performance.now();
  let sessionsProcessed = 0;
  let bytesProcessed = 0;
  let rebuilds = 0;
  let hadError = false;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(state.sessionsDir, { withFileTypes: true });
  } catch {
    recordReconciliation({
      agentId: state.agentId,
      sessionsProcessed: 0,
      bytesProcessed: 0,
      durationMs: performance.now() - start,
      rebuilds: 0,
      error: true,
    });
    return;
  }

  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) {
      continue;
    }
    // ... existing logic ...
    const fromOffset = checkpoint && checkpoint.byteOffset <= stat.size ? checkpoint.byteOffset : 0;

    if (fromOffset === 0 && checkpoint) {
      state.checkpoints.delete(sessionId);
      rebuilds += 1;
    }

    processReconcileBytes(state, sessionId, filePath, fromOffset, stat);
    sessionsProcessed += 1;
    bytesProcessed += stat.size - fromOffset;
  }

  state.lastReconciliationAt = Date.now();
  state.dirty = true;

  recordReconciliation({
    agentId: state.agentId,
    sessionsProcessed,
    bytesProcessed,
    durationMs: performance.now() - start,
    rebuilds,
    error: hadError,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test src/infra/usage-observability`
Expected: PASS

**Step 5: Run full test suite**

Run: `pnpm test src/infra/usage-aggregation.test.ts`
Expected: PASS (all 8 existing tests still pass)

**Step 6: Commit**

```bash
scripts/committer "infra: instrument reconcileUsageAggregates with observability recording" src/infra/usage-aggregation.ts src/infra/usage-observability.test.ts
```

---

### Task 5: Add gateway snapshot endpoint

**Files:**

- Modify: `src/gateway/server-http.ts:690-694` (add request stage before gateway-probes)

**Step 1: Write the failing test**

This is a lightweight handler. The unit test is best done as a test of the handler function itself rather than a full HTTP integration test. Add to `src/infra/usage-observability.test.ts`:

```typescript
it("getOptimizationSnapshot returns valid JSON-serializable snapshot", () => {
  recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 0.5, result: "success" });
  recordReconciliation({
    sessionsProcessed: 3,
    bytesProcessed: 5000,
    durationMs: 12,
    rebuilds: 0,
    error: false,
  });

  const snap = getOptimizationSnapshot();
  // Verify it round-trips through JSON
  const json = JSON.stringify(snap);
  const parsed = JSON.parse(json);
  expect(parsed.queries.total).toBe(1);
  expect(parsed.reconciliation.runsCount).toBe(1);
  expect(parsed.startedAt).toBeGreaterThan(0);
  expect(parsed.uptimeMs).toBeGreaterThanOrEqual(0);
  expect(parsed.lastUpdatedAt).toBeGreaterThan(0);
});
```

**Step 2: Run test to verify it passes (this one should pass already)**

Run: `pnpm test src/infra/usage-observability.test.ts`
Expected: PASS

**Step 3: Add the endpoint handler to `server-http.ts`**

Modify `src/gateway/server-http.ts`:

1. Add import at top:

```typescript
import { getOptimizationSnapshot } from "../infra/usage-observability.js";
```

2. Add handler function (near the probe handler):

```typescript
function handleOptimizationStatsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): boolean {
  if (requestPath !== "/diagnostics/optimization-stats") {
    return false;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }
  const snapshot = getOptimizationSnapshot();
  sendJson(res, 200, snapshot);
  return true;
}
```

3. Register the stage before gateway-probes (around line 690):

```typescript
requestStages.push({
  name: "optimization-stats",
  run: () => handleOptimizationStatsRequest(req, res, requestPath),
});

requestStages.push({
  name: "gateway-probes",
  run: () => handleGatewayProbeRequest(req, res, requestPath),
});
```

**Step 4: Type-check**

Run: `pnpm tsgo`
Expected: No errors

**Step 5: Commit**

```bash
scripts/committer "gateway: add GET /diagnostics/optimization-stats endpoint" src/gateway/server-http.ts
```

---

### Task 6: Add diagnostic event types

**Files:**

- Modify: `src/infra/diagnostic-events.ts` (add new event types to the union)

**Step 1: Add event types**

Add to the event types in `src/infra/diagnostic-events.ts`:

```typescript
export type DiagnosticOptimizationQueryEvent = DiagnosticBaseEvent & {
  type: "optimization.usage_query";
  agentId?: string;
  path: string;
  latencyMs: number;
  result: "success" | "error";
  fallbackReason?: string;
};

export type DiagnosticOptimizationReconciliationEvent = DiagnosticBaseEvent & {
  type: "optimization.reconciliation";
  agentId?: string;
  sessionsProcessed: number;
  bytesProcessed: number;
  durationMs: number;
  rebuilds: number;
  error: boolean;
};
```

Add to the `DiagnosticEventPayload` union type.

This lets us remove the `as never` casts from `usage-observability.ts`.

**Step 2: Update `usage-observability.ts` — remove `as never` casts**

Replace the `as never` casts in `emitDiagnosticEvent` calls with properly typed event objects.

**Step 3: Type-check**

Run: `pnpm tsgo`
Expected: No errors

**Step 4: Commit**

```bash
scripts/committer "infra: add optimization diagnostic event types, remove as-never casts" src/infra/diagnostic-events.ts src/infra/usage-observability.ts
```

---

### Task 7: Format, lint, full test pass

**Files:** All modified files

**Step 1: Format**

Run: `pnpm format:fix`

**Step 2: Lint**

Run: `pnpm check`

**Step 3: Full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Commit formatting fixes (if any)**

```bash
scripts/committer "style: format scope-a observability files" <changed files>
```

---

### Task 8: Update memory and documentation

**Files:**

- Modify: `/Users/kami/.claude/projects/-Users-kami/memory/token-cost-optimisation-plan.md`
- Modify: `/Users/kami/.claude/projects/-Users-kami/memory/token-cost-tracking.md`

**Step 1: Update optimisation plan**

- Mark Scope A as DONE in the progress table
- Add key files: `usage-observability.ts`, `server-http.ts` endpoint
- Add to Resolved Questions: observability approach (inline module, histogram buckets, diagnostic events + endpoint)

**Step 2: Update token-cost-tracking.md**

- Add new section or update caching strategy section to reference observability
- Add `usage-observability.ts` to the Source Index

**Step 3: Commit**

```bash
scripts/committer "docs: update memory files with scope-a observability completion" /Users/kami/.claude/projects/-Users-kami/memory/token-cost-optimisation-plan.md /Users/kami/.claude/projects/-Users-kami/memory/token-cost-tracking.md
```
