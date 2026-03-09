/**
 * Usage Aggregation (Phase 3)
 *
 * Persistent incremental aggregation of token usage and costs. Subscribes to
 * parsed transcript lines from the session index (Phase 2) via the
 * `onTranscriptLinesParsed` listener — single-reader pattern, no duplicate
 * file I/O on the hot path.
 *
 * Rules:
 * - All day keys are UTC (YYYY-MM-DD). Timezone applied only at presentation.
 * - Append-only ledger: session deletions do not subtract from aggregates.
 * - Stores both raw token counts AND snapshot cost at ingestion time.
 * - Coverage: "llm-transcript-based" (memory embeddings not included).
 * - Coalesced flush: in-memory updated immediately; persisted on 5s interval.
 * - Startup reconciliation: compare stored checkpoints vs file sizes.
 */
import fs from "node:fs";
import path from "node:path";
import type { UsageLike } from "../agents/usage.js";
import { normalizeUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
import type {
  CostUsageDailyEntry,
  CostUsageSummary,
  CostUsageTotals,
} from "./session-cost-usage.types.js";
import { type TranscriptLineMeta, onTranscriptLinesParsed } from "./session-index.js";
import { recordReconciliation } from "./usage-observability.js";

// --- Types ---

export interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  messageCount: number;
  missingCostEntries: number;
}

export interface UsageAggregateFile {
  version: 1;
  coverage: "llm-transcript-based";
  timezoneBasis: "UTC";
  lastReconciliationAt?: number;
  lastFlushedAt?: number;
  checkpoints: Record<string, { byteOffset: number; fileSize: number }>;
  daily: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
}

// --- In-memory state ---

interface AgentAggregateState {
  agentId: string;
  sessionsDir: string;
  filePath: string;
  daily: Map<string, UsageBucket>;
  byModel: Map<string, UsageBucket>;
  byProvider: Map<string, UsageBucket>;
  checkpoints: Map<string, { byteOffset: number; fileSize: number }>;
  dirty: boolean;
  lastReconciliationAt?: number;
}

const agentStates = new Map<string, AgentAggregateState>();
let listenerUnsubscribe: (() => void) | undefined;
let flushTimer: ReturnType<typeof setInterval> | undefined;
let activeConfig: OpenClawConfig | undefined;
let shutdownRegistered = false;

const FLUSH_INTERVAL_MS = 5_000;
const AGGREGATE_VERSION = 1;
const AGGREGATE_FILENAME = "usage-aggregates.json";

// --- Public API ---

/**
 * Initialize the usage aggregation for a list of agent IDs.
 * Must be called BEFORE `initSessionIndex()` so the listener receives
 * reconciliation events from the index.
 */
export function initUsageAggregation(agentIds: string[], config: OpenClawConfig): void {
  activeConfig = config;

  for (const agentId of agentIds) {
    if (agentStates.has(agentId)) {
      continue;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
    const filePath = path.join(sessionsDir, AGGREGATE_FILENAME);
    const state: AgentAggregateState = {
      agentId,
      sessionsDir,
      filePath,
      daily: new Map(),
      byModel: new Map(),
      byProvider: new Map(),
      checkpoints: new Map(),
      dirty: false,
    };
    agentStates.set(agentId, state);
    loadPersistedAggregate(state);
  }

  // Register listener (once)
  if (!listenerUnsubscribe) {
    listenerUnsubscribe = onTranscriptLinesParsed(handleParsedLines);
  }

  // Flush timer (once)
  if (!flushTimer) {
    flushTimer = setInterval(flushAllDirty, FLUSH_INTERVAL_MS);
    if (flushTimer.unref) {
      flushTimer.unref();
    }
  }

  // Shutdown handlers (once)
  if (!shutdownRegistered) {
    shutdownRegistered = true;
    const onShutdown = () => {
      flushAllDirtySync();
    };
    process.on("SIGTERM", onShutdown);
    process.on("SIGINT", onShutdown);
    process.on("beforeExit", onShutdown);
  }
}

/**
 * Run safety-net reconciliation after the session index has initialized.
 * Catches the crash-between-flushes edge case where the index persisted
 * newer offsets than the aggregate.
 */
export async function reconcileUsageAggregates(): Promise<void> {
  for (const state of agentStates.values()) {
    await reconcileAgentAggregate(state);
  }
}

/**
 * Query aggregated cost/usage summary for a date range.
 * Returns null if no aggregate is available (caller should fall back to JSONL scan).
 */
export function getAggregatedCostUsage(params: {
  agentId?: string;
  startMs: number;
  endMs: number;
}): CostUsageSummary | null {
  // Determine which agents to query
  const states = params.agentId
    ? ([agentStates.get(params.agentId)].filter(Boolean) as AgentAggregateState[])
    : Array.from(agentStates.values());

  if (states.length === 0) {
    return null;
  }

  const totals = emptyBucket();
  const dailyMap = new Map<string, UsageBucket>();

  for (const state of states) {
    for (const [dayKey, bucket] of state.daily) {
      const dayStartMs = Date.parse(dayKey + "T00:00:00.000Z");
      const dayEndMs = dayStartMs + 86_400_000 - 1;

      // Overlap: include if any part of the day intersects [startMs, endMs]
      if (dayStartMs > params.endMs || dayEndMs < params.startMs) {
        continue;
      }

      mergeBucket(totals, bucket);
      const existing = dailyMap.get(dayKey) ?? emptyBucket();
      mergeBucket(existing, bucket);
      dailyMap.set(dayKey, existing);
    }
  }

  const daily: CostUsageDailyEntry[] = Array.from(dailyMap.entries())
    .map(([date, b]) => ({ date, ...bucketToTotals(b) }))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  const days = Math.ceil((params.endMs - params.startMs) / 86_400_000) + 1;

  return {
    updatedAt: Date.now(),
    days,
    daily,
    totals: bucketToTotals(totals),
  };
}

/**
 * Check whether aggregation is initialized for an agent.
 */
export function isUsageAggregationReady(agentId: string): boolean {
  return agentStates.has(agentId);
}

/**
 * Check whether aggregation is initialized for any agent.
 */
export function isAnyUsageAggregationReady(): boolean {
  return agentStates.size > 0;
}

/**
 * Shut down: flush, clear timers, unsubscribe listener.
 */
export function shutdownUsageAggregation(): void {
  flushAllDirtySync();
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  if (listenerUnsubscribe) {
    listenerUnsubscribe();
    listenerUnsubscribe = undefined;
  }
  agentStates.clear();
  activeConfig = undefined;
  shutdownRegistered = false;
}

// --- Listener callback ---

function handleParsedLines(
  agentId: string,
  sessionId: string,
  lines: Record<string, unknown>[],
  meta: TranscriptLineMeta,
): void {
  const state = agentStates.get(agentId);
  if (!state) {
    return;
  }

  for (const line of lines) {
    processUsageLine(state, line);
  }

  // Update checkpoint
  state.checkpoints.set(sessionId, {
    byteOffset: meta.toByteOffset,
    fileSize: meta.fileSize,
  });
  state.dirty = true;
}

// --- Line processing ---

function processUsageLine(state: AgentAggregateState, line: Record<string, unknown>): void {
  const message = line.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") {
    return;
  }

  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    return;
  }

  // Extract and normalize usage
  const usageRaw =
    (message.usage as UsageLike | undefined) ?? (line.usage as UsageLike | undefined);
  const usage = usageRaw ? (normalizeUsage(usageRaw) ?? undefined) : undefined;
  if (!usage) {
    // Count the message even without usage (for message counts)
    return;
  }

  // Extract provider/model
  const provider =
    (typeof message.provider === "string" ? message.provider : undefined) ??
    (typeof line.provider === "string" ? line.provider : undefined);
  const model =
    (typeof message.model === "string" ? message.model : undefined) ??
    (typeof line.model === "string" ? line.model : undefined);

  // Extract cost — prefer embedded cost from provider, fall back to config estimate
  const costBreakdown = extractCostBreakdown(usageRaw);
  let inputCost = 0;
  let outputCost = 0;
  let cacheReadCost = 0;
  let cacheWriteCost = 0;
  let totalCost = 0;
  let missingCost = false;

  if (costBreakdown) {
    inputCost = costBreakdown.input ?? 0;
    outputCost = costBreakdown.output ?? 0;
    cacheReadCost = costBreakdown.cacheRead ?? 0;
    cacheWriteCost = costBreakdown.cacheWrite ?? 0;
    totalCost = costBreakdown.total ?? 0;
  } else {
    // Estimate from pricing config
    const costConfig = resolveModelCostConfig({
      provider,
      model,
      config: activeConfig,
    });
    const estimated = estimateUsageCost({ usage, cost: costConfig });
    if (estimated !== undefined) {
      totalCost = estimated;
      // Estimate per-type costs using the same pricing
      if (costConfig) {
        inputCost = ((usage.input ?? 0) * costConfig.input) / 1_000_000;
        outputCost = ((usage.output ?? 0) * costConfig.output) / 1_000_000;
        cacheReadCost = ((usage.cacheRead ?? 0) * costConfig.cacheRead) / 1_000_000;
        cacheWriteCost = ((usage.cacheWrite ?? 0) * costConfig.cacheWrite) / 1_000_000;
      }
    } else {
      missingCost = true;
    }
  }

  // Build increment
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  const increment: UsageBucket = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage.total ?? input + output + cacheRead + cacheWrite,
    totalCost,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    messageCount: 1,
    missingCostEntries: missingCost ? 1 : 0,
  };

  // Determine UTC day key from timestamp
  const dayKey = extractDayKey(line);

  // Increment daily bucket
  const dailyBucket = state.daily.get(dayKey) ?? emptyBucket();
  mergeBucket(dailyBucket, increment);
  state.daily.set(dayKey, dailyBucket);

  // Increment by-model bucket
  if (provider || model) {
    const modelKey = `${provider ?? "unknown"}::${model ?? "unknown"}`;
    const modelBucket = state.byModel.get(modelKey) ?? emptyBucket();
    mergeBucket(modelBucket, increment);
    state.byModel.set(modelKey, modelBucket);
  }

  // Increment by-provider bucket
  if (provider) {
    const providerBucket = state.byProvider.get(provider) ?? emptyBucket();
    mergeBucket(providerBucket, increment);
    state.byProvider.set(provider, providerBucket);
  }
}

// --- Reconciliation ---

async function reconcileAgentAggregate(state: AgentAggregateState): Promise<void> {
  const reconStart = performance.now();
  let sessionsProcessed = 0;
  let bytesProcessed = 0;
  let rebuilds = 0;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(state.sessionsDir, { withFileTypes: true });
  } catch {
    recordReconciliation({
      agentId: state.agentId,
      sessionsProcessed: 0,
      bytesProcessed: 0,
      durationMs: performance.now() - reconStart,
      rebuilds: 0,
      error: true,
    });
    return;
  }

  for (const dirent of entries) {
    if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) {
      continue;
    }

    const sessionId = dirent.name.slice(0, -6);
    const filePath = path.join(state.sessionsDir, dirent.name);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }

    const checkpoint = state.checkpoints.get(sessionId);

    // Skip if up to date
    if (checkpoint && checkpoint.byteOffset >= stat.size && stat.size === checkpoint.fileSize) {
      continue;
    }

    // Need to process from checkpoint offset (or 0 if no checkpoint / truncated)
    const fromOffset = checkpoint && checkpoint.byteOffset <= stat.size ? checkpoint.byteOffset : 0;

    // If starting from 0 and we had a checkpoint, session was truncated — clear old data
    if (fromOffset === 0 && checkpoint) {
      // Cannot subtract old data from daily buckets (append-only ledger), but reset checkpoint
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
    durationMs: performance.now() - reconStart,
    rebuilds,
    error: false,
  });
}

function processReconcileBytes(
  state: AgentAggregateState,
  sessionId: string,
  filePath: string,
  startOffset: number,
  stat: fs.Stats,
): void {
  let bytesProcessed = 0;

  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(stat.size - startOffset);
      fs.readSync(fd, buf, 0, buf.length, startOffset);
      const chunk = buf.toString("utf-8");

      // Safe boundary (same logic as session-index.ts)
      let safeChunk: string;
      if (chunk.endsWith("\n")) {
        safeChunk = chunk;
      } else {
        const lastNewline = chunk.lastIndexOf("\n");
        const trailing = lastNewline >= 0 ? chunk.slice(lastNewline + 1).trim() : chunk.trim();
        let trailingIsComplete = false;
        if (trailing) {
          try {
            JSON.parse(trailing);
            trailingIsComplete = true;
          } catch {
            // Partial write
          }
        }
        safeChunk = trailingIsComplete
          ? chunk
          : lastNewline >= 0
            ? chunk.slice(0, lastNewline + 1)
            : "";
      }
      bytesProcessed = Buffer.byteLength(safeChunk, "utf-8");

      for (const line of safeChunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        processUsageLine(state, parsed);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }

  state.checkpoints.set(sessionId, {
    byteOffset: startOffset + bytesProcessed,
    fileSize: stat.size,
  });
  state.dirty = true;
}

// --- Persistence ---

function loadPersistedAggregate(state: AgentAggregateState): void {
  try {
    const raw = fs.readFileSync(state.filePath, "utf-8");
    const data = JSON.parse(raw) as UsageAggregateFile;

    if (data.version !== AGGREGATE_VERSION) {
      return; // Version mismatch — full reconciliation will rebuild
    }

    for (const [key, bucket] of Object.entries(data.daily)) {
      state.daily.set(key, { ...bucket });
    }
    for (const [key, bucket] of Object.entries(data.byModel)) {
      state.byModel.set(key, { ...bucket });
    }
    for (const [key, bucket] of Object.entries(data.byProvider)) {
      state.byProvider.set(key, { ...bucket });
    }
    for (const [key, checkpoint] of Object.entries(data.checkpoints)) {
      state.checkpoints.set(key, { ...checkpoint });
    }
    state.lastReconciliationAt = data.lastReconciliationAt;
  } catch {
    // Missing or corrupt — reconciliation will rebuild
  }
}

function flushAllDirty(): void {
  for (const state of agentStates.values()) {
    if (state.dirty) {
      flushState(state);
    }
  }
}

function flushAllDirtySync(): void {
  for (const state of agentStates.values()) {
    if (state.dirty) {
      flushState(state);
    }
  }
}

function flushState(state: AgentAggregateState): void {
  const data: UsageAggregateFile = {
    version: AGGREGATE_VERSION,
    coverage: "llm-transcript-based",
    timezoneBasis: "UTC",
    lastReconciliationAt: state.lastReconciliationAt,
    lastFlushedAt: Date.now(),
    checkpoints: Object.fromEntries(state.checkpoints),
    daily: Object.fromEntries(state.daily),
    byModel: Object.fromEntries(state.byModel),
    byProvider: Object.fromEntries(state.byProvider),
  };

  const json = JSON.stringify(data, null, 2);
  const tmpPath = state.filePath + ".tmp";

  try {
    const dir = path.dirname(state.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tmpPath, json, "utf-8");
    fs.renameSync(tmpPath, state.filePath);
    state.dirty = false;
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

// --- Helpers ---

function emptyBucket(): UsageBucket {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    messageCount: 0,
    missingCostEntries: 0,
  };
}

function mergeBucket(target: UsageBucket, source: UsageBucket): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheReadCost += source.cacheReadCost;
  target.cacheWriteCost += source.cacheWriteCost;
  target.messageCount += source.messageCount;
  target.missingCostEntries += source.missingCostEntries;
}

function bucketToTotals(bucket: UsageBucket): CostUsageTotals {
  return {
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    totalTokens: bucket.totalTokens,
    totalCost: bucket.totalCost,
    inputCost: bucket.inputCost,
    outputCost: bucket.outputCost,
    cacheReadCost: bucket.cacheReadCost,
    cacheWriteCost: bucket.cacheWriteCost,
    missingCostEntries: bucket.missingCostEntries,
  };
}

function extractDayKey(line: Record<string, unknown>): string {
  const raw = line.timestamp;
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  const message = line.message as Record<string, unknown> | undefined;
  const messageTs = message?.timestamp;
  if (typeof messageTs === "number" && Number.isFinite(messageTs)) {
    return new Date(messageTs).toISOString().slice(0, 10);
  }
  // Fallback to today UTC
  return new Date().toISOString().slice(0, 10);
}

function extractCostBreakdown(
  usageRaw?: UsageLike | null,
):
  | { total: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  | undefined {
  if (!usageRaw || typeof usageRaw !== "object") {
    return undefined;
  }
  const record = usageRaw as Record<string, unknown>;
  const cost = record.cost as Record<string, unknown> | undefined;
  if (!cost) {
    return undefined;
  }
  const total =
    typeof cost.total === "number" && Number.isFinite(cost.total) ? cost.total : undefined;
  if (total === undefined || total < 0) {
    return undefined;
  }
  const toNum = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    total,
    input: toNum(cost.input),
    output: toNum(cost.output),
    cacheRead: toNum(cost.cacheRead),
    cacheWrite: toNum(cost.cacheWrite),
  };
}
