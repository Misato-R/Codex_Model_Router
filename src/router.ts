import type { Effort, Mode, Route, Tier } from "./types.js";

/** Defaults based on the model catalog exposed by recent Codex CLI versions. */
export const DEFAULT_MODELS: Record<Tier, string> = {
  cheap: "gpt-6-luna",
  standard: "gpt-6.1-sol",
  hard: "gpt-6-astra",
};

const signals: Array<{ weight: number; label: string; pattern: RegExp }> = [
  { weight: 5, label: "architecture/security/high-risk work", pattern: /架构设计|系统设计|安全审计|威胁建模|漏洞|architecture|system design|security audit|threat model|vulnerability/ },
  { weight: 4, label: "cross-module or broad refactor", pattern: /重构|迁移|跨模块|多模块|全局改造|refactor|migration|cross.?module|multiple modules|large.?scale/ },
  { weight: 3, label: "concurrency or difficult diagnosis", pattern: /并发|死锁|竞态|性能瓶颈|内存泄漏|根因|race condition|deadlock|concurrency|performance bottleneck|memory leak|root cause/ },
  { weight: 2, label: "multi-file implementation or debugging", pattern: /多文件|实现功能|新增功能|调试|修复复杂|implement|feature|debug|complex bug|multiple files/ },
  { weight: 1, label: "code change or analysis", pattern: /代码|项目|程序|函数|模块|code|project|program|function|module/ },
];
const simplePattern = /解释|翻译|格式化|总结|列出|说明|改写|explain|translate|format|summari[sz]e|list|rewrite|what does/;

export interface RouteOptions {
  models?: Partial<Record<Tier, string>>;
}

export function routeFromTier(
  requestedTier: Tier,
  mode: Mode,
  options: RouteOptions = {},
  details: { score?: number; reason?: string; source?: Route["source"]; confidence?: number } = {},
): Route {
  if (!["balanced", "economy", "quality"].includes(mode)) throw new Error(`Invalid routing mode: ${mode}`);
  let tier = requestedTier;
  if (mode === "economy" && tier === "hard") tier = "standard";
  if (mode === "quality" && tier === "cheap") tier = "standard";
  const effort: Effort = tier === "hard" ? "high" : tier === "standard" ? "medium" : "low";
  return {
    tier,
    model: options.models?.[tier] ?? DEFAULT_MODELS[tier],
    effort,
    score: details.score,
    reason: details.reason ?? `${mode} mode: selected by ${details.source ?? "router"}`,
    source: details.source,
    confidence: details.confidence,
  };
}

export function routeTask(task: string, mode: Mode = "balanced", options: RouteOptions = {}): Route {
  if (!["balanced", "economy", "quality"].includes(mode)) throw new Error(`Invalid routing mode: ${mode}`);
  const text = task.toLocaleLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const signal of signals) {
    if (signal.pattern.test(text)) {
      score += signal.weight;
      matched.push(signal.label);
    }
  }
  if (text.length > 500) score += 1;
  if (text.length > 1800) score += 1;

  let tier: Tier;
  if (mode === "quality") tier = score >= 4 ? "hard" : "standard";
  else if (mode === "economy") tier = score >= 5 ? "standard" : "cheap";
  else if (score >= 4) tier = "hard";
  else if (score <= 1 && simplePattern.test(text)) tier = "cheap";
  else tier = "standard";

  const reason = matched.length ? `${matched.join("; ")} (score ${score})` : simplePattern.test(text) ? "straightforward informational task" : "default development workload";
  return routeFromTier(tier, mode, options, { score, reason: `${mode} mode: ${reason}`, source: "rules" });
}
