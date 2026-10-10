import { test } from "node:test";
import { strict as assert } from "node:assert";
import { routeTask } from "./router.js";
import { CodexCliExecutor, CodexSdkExecutor } from "./executor.js";

test("simple request routes to cheap model", () => {
  const route = routeTask("解释这段代码");
  assert.equal(route.tier, "cheap");
  assert.equal(route.model, "gpt-6-luna");
  assert.equal(route.effort, "low");
});

test("cross-module architecture work routes to hard model", () => {
  const route = routeTask("重构跨模块架构并处理并发死锁");
  assert.equal(route.tier, "hard");
  assert.equal(route.model, "gpt-6-astra");
  assert.equal(route.effort, "high");
});

test("economy mode caps difficult work at standard", () => {
  assert.equal(routeTask("安全审计与架构设计", "economy").tier, "standard");
});

test("quality mode uses standard for an ordinary feature and hard for complex work", () => {
  assert.equal(routeTask("实现一个小功能", "quality").tier, "standard");
  assert.equal(routeTask("重构跨模块架构", "quality").tier, "hard");
});

test("model assignments can be overridden without changing global Codex config", () => {
  assert.equal(routeTask("解释一段代码", "balanced", { models: { cheap: "custom-fast" } }).model, "custom-fast");
});

test("CLI dry run builds model-specific Windows-safe invocation without starting Codex", async () => {
  const route = routeTask("解释一段代码");
  const result = await new CodexCliExecutor().execute("prompt", "C:\\work & test", route);
  assert.equal(result.exitCode, null);
  assert.match(result.output, /no model invocation/);
  assert.ok(result.command.includes(route.model));
  assert.ok(result.command.includes("C:\\work & test"));
  assert.ok(result.command.includes("--json"));
});

test("SDK dry run does not load the optional SDK package", async () => {
  const result = await new CodexSdkExecutor().execute("prompt", "C:\\work", routeTask("explain code"));
  assert.equal(result.exitCode, null);
  assert.match(result.output, /no model invocation/);
});

test("invalid modes are rejected", () => {
  assert.throws(() => routeTask("explain", "fast" as never), /Invalid routing mode/);
});
