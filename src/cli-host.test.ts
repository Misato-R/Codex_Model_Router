import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { startHost } from "./cli-host.js";
import type { Message } from "./cli-proxy.js";

test("real loopback ws + fake stdio backend: authorization, routing, disconnect and process cleanup", { timeout: 10_000 }, async (t) => {
  const token = "offline-test-capability-" + "x".repeat(32);
  const host = await startHost({ project: process.cwd(), executable: process.execPath, backendArgs: [resolve("src/fixtures/cli-backend.cjs")],
    env: { ...process.env, TYPESAFE_API_KEY: "must-not-leak", ROUTER_CLI_REMOTE_TOKEN: token }, token,
    route: async () => ({ tier: "cheap", model: "fixture", effort: "low", reason: "offline", source: "rules" }),
  });
  t.after(() => host.close());
  for (const headers of [{}, { Authorization: `Bearer ${token}`, Origin: "http://localhost" }]) {
    const rejected = new WebSocket(host.url, { headers });
    const [error] = await once(rejected, "error");
    assert.match(error.message, /403/);
  }
  const ws = new WebSocket(host.url, { headers: { Authorization: `Bearer ${token}` } });
  const messages: Message[] = [];
  const waiting = new Map<number, (message: Message) => void>();
  ws.on("message", (data) => { const m = JSON.parse(data.toString()); messages.push(m); if (!m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  t.after(() => ws.terminate());
  await once(ws, "open");
  let id = 0;
  const rpc = (method: string, params: object = {}) => new Promise<Message>((resolve) => { const requestId = ++id; waiting.set(requestId, resolve); ws.send(JSON.stringify({ id: requestId, method, params })); });
  await rpc("initialize", { clientInfo: { name: "fixture", version: "1" } });
  ws.send(JSON.stringify({ method: "initialized" }));
  const env = (await rpc("fixture/env")).result;
  assert.equal(env.keyPresent, false); assert.equal(env.tokenPresent, false);
  const result = await rpc("turn/start", { threadId: "thread", input: [{ type: "text", text: "test" }], approvalPolicy: "never" });
  assert.equal(result.result.received.model, "fixture");
  assert.equal(result.result.received.threadId, "thread");
  assert.equal(result.result.received.approvalPolicy, "never");
  assert.ok(messages.find((m) => m.method === "turn/completed"));
  ws.close(); await host.closed;
  assert.throws(() => process.kill(env.pid, 0), /ESRCH|not found/i);
});
