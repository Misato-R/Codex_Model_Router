import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenCounts, turnUsage, type TokenCounts } from "./turn-usage.js";

export class TurnTiming {
  readonly requestId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private start = performance.now();
  private submitted?: number;
  private jev: number | null = null;
  private finished = false;
  private selection: Record<string, unknown> = {};
  private baseline: TokenCounts | null = null;
  private total: TokenCounts | null = null;
  private last: TokenCounts | null = null;
  private record?: Record<string, unknown>;
  constructor(private threadId: string, private emit: (record: Record<string, unknown>) => void) {}
  get isFinished(): boolean { return this.finished; }
  jevRequest(ms: number): void { this.jev = ms; }
  usageBaseline(total: TokenCounts | null): void { this.baseline = total; }
  advanceUsageBaseline(total: TokenCounts): void {
    const previous = this.baseline?.totalTokens;
    if (previous !== null && previous !== undefined && (total.totalTokens === null || total.totalTokens < previous)) return;
    this.baseline = total;
    if (this.record) {
      this.record = { ...this.record, tokenUsage: turnUsage(this.baseline, this.total, this.last) };
      this.emit(this.record);
    }
  }
  usageUpdate(value: { total?: unknown; last?: unknown }): void {
    const total = tokenCounts(value.total);
    if (!total) return;
    // Ignore duplicate or regressive snapshots for this same turn.
    if (this.total?.totalTokens !== null && this.total?.totalTokens !== undefined && total.totalTokens !== null && total.totalTokens < this.total.totalTokens) return;
    this.total = total;
    this.last = tokenCounts(value.last);
    // Usage can arrive after completion. Rewrite the same JSON without changing timings.
    if (this.record) {
      this.record = { ...this.record, tokenUsage: turnUsage(this.baseline, this.total, this.last) };
      this.emit(this.record);
    }
  }
  selected(route: { model: string; effort: string; tier: string; source?: string }): void {
    this.selection = { model: route.model, effort: route.effort, tier: route.tier, source: route.source };
  }
  submit(model?: string, effort?: string): void {
    this.submitted = performance.now();
    this.selection = { ...this.selection, model, effort };
  }
  finish(status: string, turnId?: string, end = performance.now()): void {
    if (this.finished) return;
    this.finished = true;
    const rounded = (ms: number) => Math.round(ms * 1000) / 1000;
    this.record = { schemaVersion: 2, requestId: this.requestId, threadId: this.threadId,
      turnId: turnId ?? null, startedAt: this.startedAt, finishedAt: new Date().toISOString(),
      status, ...this.selection, durationsMs: {
        jevRequest: this.jev === null ? null : rounded(this.jev),
        routing: this.submitted === undefined ? null : rounded(this.submitted - this.start),
        codex: this.submitted === undefined ? null : rounded(end - this.submitted),
        total: rounded(end - this.start),
      }, tokenUsage: turnUsage(this.baseline, this.total, this.last) };
    this.emit(this.record);
  }
}

export function timingWriter(directory = process.env.CMR_TIMING_DIR): ((record: Record<string, unknown>) => void) | undefined {
  if (!directory) return undefined;
  mkdirSync(directory, { recursive: true });
  return record => {
    if (process.env.CMR_TIMING_ACTIVE && !existsSync(process.env.CMR_TIMING_ACTIVE)) return;
    if (process.env.CMR_TIMING_OWNER) {
      try { process.kill(Number(process.env.CMR_TIMING_OWNER), 0); } catch { return; }
    }
    // Recording must never break the transport or cause a turn retry.
    try { writeFileSync(join(directory, `turn-${record.requestId}.json`), JSON.stringify({ proxyPid: process.pid, ...record }, null, 2) + "\n", { mode: 0o600 }); }
    catch { process.stderr.write("Timing log could not be written.\n"); }
  };
}
