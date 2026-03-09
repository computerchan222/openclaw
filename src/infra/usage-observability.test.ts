import { afterEach, describe, expect, it } from "vitest";
import {
  getOptimizationSnapshot,
  recordReconciliation,
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
    for (const count of Object.values(snap.queries.fallbacksByReason)) {
      expect(count).toBe(0);
    }
    expect(snap.queries.byPath.range_bypass.count).toBe(1);
  });

  it("places latency values in correct histogram buckets", () => {
    // <1ms bucket
    recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 0.3, result: "success" });
    // 5-10ms bucket (>=5, <10)
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
    // p50 should be in the <1ms bucket upper bound
    expect(lat.estimatedP50).toBe(1);
    // p95 should still be <1ms (100 of 105 are sub-1ms)
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

  it("snapshot is JSON-serializable", () => {
    recordUsageQuery({ path: "aggregate_fast_path", latencyMs: 0.5, result: "success" });
    recordReconciliation({
      sessionsProcessed: 3,
      bytesProcessed: 5000,
      durationMs: 12,
      rebuilds: 0,
      error: false,
    });

    const snap = getOptimizationSnapshot();
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json);
    expect(parsed.queries.total).toBe(1);
    expect(parsed.reconciliation.runsCount).toBe(1);
    expect(parsed.startedAt).toBeGreaterThan(0);
    // Infinity becomes null in JSON — check overflow bucket is present
    expect(parsed.queries.byPath.aggregate_fast_path.latency.buckets).toHaveLength(10);
  });
});
