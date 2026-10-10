import test from "node:test";
import assert from "node:assert/strict";
import { CliProxy, ROUTED_INSTRUCTIONS, type Message } from "./cli-proxy.js";
import { authorized, childEnvironment, frontendArgs, TOKEN_ENV } from "./cli-security.js";
import type { Route } from "./types.js";
import { JsonObjectStream } from "./cli-json-stream.js";

test("stdio JSON survives chunking, embedded Unicode line separators and multi-line objects", () => {
  const messages: any[] = [];
  const decoder = new JsonObjectStream(m => messages.push(m));
  const first = { id: 1, result: { description: 'x'.repeat(100_000) + '\u2028line\u2029终点', escaped: '"\\{}[]' } };
  const data = JSON.stringify(first) + '\r\n' + JSON.stringify({ id: 2, result: [1, 2] }, null, 2) + '\n';
  for (let i = 0; i < data.length; i += 31) decoder.push(data.slice(i, i + 31));
  assert.deepEqual(messages, [first, { id: 2, result: [1, 2] }]);
  assert.throws(() => new JsonObjectStream(() => {}, 5).push('{"long":42}'), /too large/);
  assert.throws(() => new JsonObjectStream(() => {}).push('not JSON'), /Expected/);
});

const route: Route = { model: "available", effort: "low", tier: "cheap", source: "rules", reason: "test" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(options: Partial<ConstructorParameters<typeof CliProxy>[0]> = {}) {
  const backend: Message[] = [], client: Message[] = [], metadata: Record<string, unknown>[] = [];
  const classifications: { task: string; context: string; signal: AbortSignal }[] = [];
  let fatal = false;
  const proxy = new CliProxy({ project: "project", controlTimeoutMs: 1000,
    route: async (task, context, signal) => { classifications.push({ task, context, signal }); return route; },
    toBackend(message) {
      backend.push(message);
      const result = message.method === "account/read" ? { account: { type: "chatgpt" } }
        : message.method === "model/list" ? { data: [{ model: "available", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null }
        : message.method === "config/read" ? { config: { developer_instructions: "global instruction" } } : undefined;
      if (result) queueMicrotask(() => proxy.backend({ id: message.id, result }));
    },
    toClient: (message) => client.push(message), metadata: (entry) => metadata.push(entry), fatal: () => { fatal = true; }, ...options,
  });
  proxy.client({ method: "initialized" });
  return { proxy, backend, client, metadata, classifications, fatal: () => fatal,
    start(id: number | string = 1, extra: object = {}) { proxy.client({ id, method: "turn/start", params: { threadId: "same", input: [{ type: "text", text: "question" }], ...extra } }); },
    submitted() { return backend.filter((m) => m.method === "turn/start"); },
    ack(index = 0, turnId = "turn") { const sent = backend.filter((m) => m.method === "turn/start")[index]; proxy.backend({ id: sent.id, result: { turn: { id: turnId, status: "inProgress" } } }); },
    complete(turnId = "turn") { proxy.backend({ method: "turn/completed", params: { threadId: "same", turn: { id: turnId, status: "completed" } } }); },
  };
}

test("route only overrides model/effort; same thread, safety/input and unknown fields survive", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  const input = [{ type: "text", text: "original", text_elements: [] }, { type: "localImage", path: "image.png" }];
  h.start(1, { input, model: "manual", effort: "high", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never", futureField: { value: 1 } });
  await tick();
  assert.deepEqual(h.submitted()[0].params, { threadId: "same", input, model: "available", effort: "low", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never", futureField: { value: 1 } });
  h.ack(); h.complete(); h.start(2); await tick(); h.ack(1, "second"); h.complete("second");
  assert.equal(h.submitted()[1].params?.threadId, "same");
  assert.equal(h.classifications[1].context, "1. original");
  assert.equal(h.metadata.some((entry) => JSON.stringify(entry).includes("original")), false);
});

test("early completion before ack and stale events do not keep the next turn active", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  h.start(); await tick();
  h.complete("early"); h.ack(0, "early");
  h.proxy.backend({ method: "turn/started", params: { threadId: "same", turn: { id: "early" } } });
  h.start(2); await tick();
  assert.equal(h.classifications.length, 2);
  h.ack(1, "new"); h.complete("early");
  h.start(3, { model: "unchanged" }); await tick();
  assert.equal(h.classifications.length, 2);
  assert.equal(h.submitted()[2].params?.model, "unchanged");
  h.proxy.backend({ id: h.submitted()[2].id, result: { turn: { id: "new", status: "inProgress" } } });
});

test("native collaboration mask uses routed settings without losing Plan instructions", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  h.start(1, { turnTrigger: "user", collaborationMode: { mode: "plan", settings: { model: "old", reasoning_effort: "high", developer_instructions: "keep plan" } } });
  await tick();
  assert.deepEqual(h.submitted()[0].params?.collaborationMode, { mode: "plan", settings: { model: "available", reasoning_effort: "low", developer_instructions: "keep plan" } });
  h.ack(); h.complete();
  h.start(2, { turnTrigger: "automation", model: "native-background" }); await tick();
  assert.equal(h.classifications.length, 1);
  assert.equal(h.submitted()[1].params?.model, "native-background");
});

test("approvals, unknown requests, responses and notifications pass while routing waits; ids cannot collide", async (t) => {
  const gate = deferred<Route>(); const h = harness({ route: () => gate.promise }); t.after(() => h.proxy.close());
  h.start(); await tick();
  h.proxy.backend({ id: 1, method: "future/approval", params: { secretShape: [1] } });
  const approval = h.client.at(-1)!;
  h.proxy.client({ id: approval.id, result: { decision: "accept" } });
  assert.deepEqual(h.backend.at(-1), { id: 1, result: { decision: "accept" } });
  h.proxy.backend({ method: "serverRequest/resolved", params: { threadId: "same", requestId: 1 } });
  assert.equal(h.client.at(-1)?.params?.requestId, approval.id);
  h.proxy.client({ id: 200, method: "future/client", params: { arbitrary: true } });
  const sent = h.backend.at(-1)!;
  h.proxy.backend({ id: sent.id, result: { unknown: "preserved" } });
  assert.deepEqual(h.client.at(-1), { id: 200, result: { unknown: "preserved" } });
  const event = { method: "future/event", params: { raw: ["exact"] } };
  h.proxy.backend(event); assert.deepEqual(h.client.at(-1), event);
  h.proxy.client({ method: "future/notification", params: { raw: 2 } });
  assert.equal(h.backend.at(-1)?.method, "future/notification");
  gate.resolve(route); await tick(); h.ack();
});

test("classification cancellation aborts and late classification cannot start; duplicate submission rejected", async (t) => {
  const gate = deferred<Route>(); let signal!: AbortSignal;
  const h = harness({ route: (_task, _context, value) => { signal = value; return gate.promise; } }); t.after(() => h.proxy.close());
  h.start(1); await tick(); h.start(2);
  h.proxy.client({ id: 3, method: "turn/steer", params: { threadId: "same", input: [] } });
  h.proxy.client({ id: 4, method: "turn/interrupt", params: { threadId: "same", turnId: "not-created" } });
  assert.equal(signal.aborted, true);
  gate.resolve(route); await tick();
  assert.equal(h.submitted().length, 0);
  assert.ok(h.client.find((m) => m.id === 1)?.error);
  assert.ok(h.client.find((m) => m.id === 2)?.error);
  assert.ok(h.client.find((m) => m.id === 3)?.error);
  assert.deepEqual(h.client.find((m) => m.id === 4)?.result, {});
});

test("Jev failure, bad catalog and missing ChatGPT auth never submit a turn", async (t) => {
  const bad = harness({ route: async () => { throw new Error("secret response body"); } }); t.after(() => bad.proxy.close());
  bad.start(); await tick(); assert.equal(bad.submitted().length, 0);
  assert.ok(bad.client[0].error); assert.equal(JSON.stringify(bad.client).includes("secret"), false);
  const unavailable = harness({ route: async () => ({ ...route, model: "missing" }) }); t.after(() => unavailable.proxy.close());
  unavailable.start(); await tick(); assert.equal(unavailable.submitted().length, 0);
  let rpc!: CliProxy; const sent: Message[] = [];
  rpc = new CliProxy({ project: ".", route: async () => route, toClient: () => {}, fatal: () => {},
    toBackend: (m) => { sent.push(m); if (m.method === "account/read") queueMicrotask(() => rpc.backend({ id: m.id, result: { account: { type: "apiKey" } } })); },
  }); t.after(() => rpc.close());
  rpc.client({ method: "initialized" }); rpc.client({ id: 1, method: "turn/start", params: { threadId: "t", input: [] } }); await tick();
  assert.equal(sent.some((m) => m.method === "turn/start"), false);
});

test("manual mode and active steer/start keep original model and effort", async (t) => {
  const h = harness({ manual: true }); t.after(() => h.proxy.close());
  h.start(1, { model: "user-selected", effort: "high" }); await tick(); h.ack();
  const steer = { id: 2, method: "turn/steer", params: { threadId: "same", expectedTurnId: "turn", input: [] } };
  h.proxy.client(steer);
  assert.deepEqual(h.backend.at(-1)?.params, steer.params);
  h.start(3, { model: "preserved" }); await tick();
  assert.equal(h.submitted()[0].params?.model, "user-selected");
  assert.equal(h.submitted()[1].params?.model, "preserved");
  assert.equal(h.classifications.length, 0);
});

test("thread start/resume merge instructions and preserve settings; recent context bounded", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  h.proxy.client({ id: "resume", method: "thread/resume", params: { threadId: "same", developerInstructions: "keep me", config: { other: 42 }, sandbox: "read-only" } });
  await tick();
  const resume = h.backend.find((m) => m.method === "thread/resume")!;
  assert.equal(resume.params?.developerInstructions, `keep me\n\n${ROUTED_INSTRUCTIONS}`);
  assert.deepEqual(resume.params?.config, { other: 42, "mcp_servers.jev_model_router.enabled": false });
  assert.equal(resume.params?.sandbox, "read-only");
  h.proxy.client({ id: "start", method: "thread/start", params: {} }); await tick();
  assert.match(h.backend.find((m) => m.method === "thread/start")!.params?.developerInstructions, /^global instruction/);
  for (let i = 0; i < 5; i++) { h.start(10 + i, { input: [{ type: "text", text: String(i).repeat(700) }] }); await tick(); h.ack(i, `turn-${i}`); h.complete(`turn-${i}`); }
  assert.equal(h.classifications[4].context.length, 1511);
  assert.equal(h.classifications[4].context.includes("0000"), false);
});

test("no auto retry after start failure or ack timeout; disconnect aborts classification", async (t) => {
  const h = harness({ controlTimeoutMs: 15 }); t.after(() => h.proxy.close());
  h.start(); await tick();
  h.proxy.backend({ id: h.submitted()[0].id, error: { code: -1, message: "native failure" } });
  h.start(); await tick(); assert.equal(h.submitted().length, 1);
  h.start(2); await new Promise((resolve) => setTimeout(resolve, 35)); assert.equal(h.fatal(), true);
  assert.equal(h.submitted().length, 2);
  const gate = deferred<Route>(); let signal!: AbortSignal;
  const disconnected = harness({ route: (_t, _c, s) => { signal = s; return gate.promise; } });
  disconnected.start(); await tick(); disconnected.proxy.close(); assert.equal(signal.aborted, true);
  gate.resolve(route); await tick(); assert.equal(disconnected.submitted().length, 0);
});

test("loopback capability auth rejects Origin, wrong host, missing token and remote IP; child env sanitized", () => {
  const token = "x".repeat(40), headers = { host: "127.0.0.1:123", authorization: `Bearer ${token}` };
  assert.equal(authorized(headers, "127.0.0.1", 123, token), true);
  for (const changed of [{ ...headers, origin: "http://localhost" }, { ...headers, host: "evil.test:123" }, { ...headers, authorization: "" }]) assert.equal(authorized(changed, "127.0.0.1", 123, token), false);
  assert.equal(authorized(headers, "192.168.1.5", 123, token), false);
  assert.deepEqual(childEnvironment({ TYPESAFE_API_KEY: "key", typesafe_api_key: "key", [TOKEN_ENV]: "token", PATH: "path" }), { PATH: "path" });
  assert.deepEqual(frontendArgs("ws://127.0.0.1:123", "thread", ["--model", "chosen"]), ["--remote", "ws://127.0.0.1:123", "--remote-auth-token-env", TOKEN_ENV, "resume", "thread", "--model", "chosen"]);
  assert.throws(() => frontendArgs("url", undefined, ["--remote=evil"]));
});

test("classification timeout aborts without submission; long acknowledged turns have no execution timeout", async (t) => {
  let signal!: AbortSignal;
  const timeout = harness({ classificationTimeoutMs: 10, route: (_t, _c, s) => { signal = s; return new Promise(() => {}); } });
  t.after(() => timeout.proxy.close());
  timeout.start(); await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(signal.aborted, true); assert.equal(timeout.submitted().length, 0);
  assert.ok(timeout.client.find((m) => m.id === 1)?.error);
  const long = harness({ controlTimeoutMs: 10 }); t.after(() => long.proxy.close());
  long.start(); await tick(); long.ack();
  await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(long.fatal(), false);
  long.complete();
});

test("routing one thread does not block another thread or native interrupt after submission", async (t) => {
  const gate = deferred<Route>();
  const h = harness({ route: (task) => task === "wait" ? gate.promise : Promise.resolve(route) }); t.after(() => h.proxy.close());
  h.start(1, { input: [{ type: "text", text: "wait" }] });
  h.start(2, { threadId: "other" }); await tick();
  assert.equal(h.submitted().length, 1); assert.equal(h.submitted()[0].params?.threadId, "other");
  h.proxy.backend({ id: h.submitted()[0].id, result: { turn: { id: "other-turn", status: "inProgress" } } });
  const params = { threadId: "other", turnId: "other-turn" };
  h.proxy.client({ id: 3, method: "turn/interrupt", params });
  assert.deepEqual(h.backend.at(-1)?.params, params);
  assert.equal(h.backend.at(-1)?.method, "turn/interrupt");
  h.proxy.close(); gate.resolve(route); await tick(); assert.equal(h.submitted().length, 1);
});
