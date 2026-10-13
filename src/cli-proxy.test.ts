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

test("timing correlates a routed turn, excludes stale completion, and emits once", async () => {
  const records: any[] = [];
  const h = harness({ timing: record => records.push(record), route: async (_task, _context, _signal, onJevTiming) => {
    onJevTiming(2.5); return { ...route, source: "jev" };
  } });
  h.start(); await tick(); h.ack(0, "measured");
  h.complete("stale"); assert.equal(records.length, 0);
  h.complete("measured"); h.complete("measured"); h.proxy.close();
  assert.equal(records.length, 1);
  assert.equal(records[0].turnId, "measured");
  assert.equal(records[0].durationsMs.jevRequest, 2.5);
  assert.equal(records[0].model, "available");
  const d = records[0].durationsMs;
  assert.ok(Math.abs(d.total - d.routing - d.codex) < 0.003);
  assert.ok(!JSON.stringify(records).includes("question"));
});

test("timing retains an early completion until its turn/start response correlates it", async () => {
  const records: any[] = [];
  const h = harness({ timing: record => records.push(record) });
  h.start(); await tick(); h.complete("early"); h.ack(0, "early"); h.proxy.close();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "completed");
  assert.equal(records[0].turnId, "early");
  assert.equal(records[0].durationsMs.jevRequest, null);
});

test("timing records routing failure without inventing Codex execution", async () => {
  const records: any[] = [];
  const h = harness({ timing: record => records.push(record), route: async () => { throw new Error("offline"); } });
  h.start(); await tick(); h.proxy.close();
  assert.equal(h.submitted().length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "routing-failed");
  assert.equal(records[0].durationsMs.codex, null);
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function usage(h: ReturnType<typeof harness>, id: string, total: number, threadId = "same") {
  const counts = { totalTokens: total, inputTokens: total * 0.8, cachedInputTokens: total * 0.2,
    outputTokens: total * 0.2, reasoningOutputTokens: total * 0.1 };
  h.proxy.backend({ method: "thread/tokenUsage/updated", params: { threadId, turnId: id,
    tokenUsage: { total: counts, last: { ...counts, totalTokens: 10 }, modelContextWindow: null } } });
}

test("per-question usage spans multiple responses without adding duplicate snapshots", async () => {
  const records: any[] = []; const h = harness({ timing: r => records.push(r) });
  usage(h, "previous", 100);
  h.start(); await tick(); h.ack(); usage(h, "turn", 120); usage(h, "turn", 150); usage(h, "turn", 150); h.complete();
  assert.deepEqual(records.at(-1).tokenUsage.counts, { totalTokens: 50, inputTokens: 40, cachedInputTokens: 10,
    cacheWriteInputTokens: null, outputTokens: 10, reasoningOutputTokens: 5 });
  assert.equal(records.at(-1).tokenUsage.lastModelResponse.totalTokens, 10);
  h.proxy.close();
});

test("late usage rewrites the completed turn and preserves its timing", async () => {
  const records: any[] = []; const h = harness({ timing: r => records.push(r) });
  usage(h, "previous", 100); h.start(); await tick(); h.ack(); h.complete();
  const original = records.at(-1); usage(h, "turn", 160);
  assert.equal(records.at(-1).requestId, original.requestId);
  assert.deepEqual(records.at(-1).durationsMs, original.durationsMs);
  assert.equal(records.at(-1).tokenUsage.counts.totalTokens, 60); h.proxy.close();
});

test("late final usage from a previous question corrects the next baseline", async () => {
  const records: any[] = []; const h = harness({ timing: r => records.push(r) });
  usage(h, "history", 100); h.start(); await tick(); h.ack(0, "first"); usage(h, "first", 180); h.complete("first");
  h.start(2); await tick(); h.ack(1, "second"); usage(h, "second", 250); h.complete("second");
  usage(h, "first", 200); usage(h, "first", 180);
  const second = records.filter(r => r.turnId === "second").at(-1);
  assert.equal(second.tokenUsage.counts.totalTokens, 50); h.proxy.close();
});

test("missing resumed-thread baseline and reset counters are not reported as zero", async () => {
  const records: any[] = []; const h = harness({ timing: r => records.push(r) });
  h.start(); await tick(); h.ack(); usage(h, "turn", 1000); h.complete();
  assert.equal(records.at(-1).tokenUsage.availability, "baseline-unavailable");
  assert.equal(records.at(-1).tokenUsage.counts, null);
  h.start(2); await tick(); h.ack(1, "reset"); usage(h, "reset", 100); h.complete("reset");
  assert.equal(records.at(-1).tokenUsage.availability, "counter-reset"); h.proxy.close();
});

test("usage arriving before turn/start acknowledgement is attributed by returned turn ID", async () => {
  const records: any[] = []; const h = harness({ timing: r => records.push(r) });
  usage(h, "previous", 100); h.start(); await tick(); usage(h, "early", 180); h.complete("early"); h.ack(0, "early");
  assert.equal(records.at(-1).tokenUsage.counts.totalTokens, 80); h.proxy.close();
});
function harness(options: Partial<ConstructorParameters<typeof CliProxy>[0]> = {}, models = [
  { model: "available", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
]) {
  const backend: Message[] = [], client: Message[] = [], metadata: Record<string, unknown>[] = [];
  const classifications: { task: string; context: string; signal: AbortSignal }[] = [];
  let fatal = false;
  const proxy = new CliProxy({ project: "project", controlTimeoutMs: 1000,
    route: async (task, context, signal) => { classifications.push({ task, context, signal }); return route; },
    toBackend(message) {
      backend.push(message);
      const result = message.method === "account/read" ? { account: { type: "chatgpt" } }
        : message.method === "model/list" ? { data: models, nextCursor: null }
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
    complete(turnId = "turn", threadId = "same") { proxy.backend({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }); },
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

test("an old append acknowledgement cannot clear a newer routed submission in the same thread", async (t) => {
  const records: any[] = [];
  const h = harness({ timing: record => records.push(record) }); t.after(() => h.proxy.close());
  usage(h, "history", 100);
  h.start(1); await tick(); h.ack(0, "old"); usage(h, "old", 140);
  h.start(2, { model: "append-keeps-native", effort: "high" }); await tick();
  assert.equal(h.classifications.length, 1);
  h.complete("old");
  h.start(3); await tick();
  assert.equal(h.classifications.length, 2);
  assert.equal(h.submitted().length, 3);

  // The response to the append belongs to the completed old turn, even though
  // another request is now waiting for its turn/start acknowledgement.
  h.ack(1, "old");
  assert.equal(records.length, 1);
  h.start(4); await tick();
  assert.equal(h.classifications.length, 2);
  assert.equal(h.submitted().length, 3);
  assert.ok(h.client.find(message => message.id === 4)?.error);
  h.ack(2, "new"); usage(h, "new", 200); h.complete("new");
  assert.equal(records.length, 2);
  assert.equal(records.at(-1).turnId, "new");
  assert.equal(records.at(-1).tokenUsage.counts.totalTokens, 60);
});

test("stale notifications cannot claim unacknowledged timing and early completion survives unrelated events", async (t) => {
  const records: any[] = [];
  const h = harness({ timing: record => records.push(record) }); t.after(() => h.proxy.close());
  usage(h, "history", 100);
  h.start(1); await tick(); h.ack(0, "old"); usage(h, "old", 140); h.complete("old");
  const oldRequestId = records.at(-1).requestId;
  h.start(2); await tick();
  h.proxy.backend({ method: "turn/started", params: { threadId: "same", turn: { id: "old" } } });
  usage(h, "old", 160); h.complete("old");
  assert.ok(records.every(record => record.requestId === oldRequestId));

  h.proxy.backend({ method: "turn/started", params: { threadId: "same", turn: { id: "new" } } });
  usage(h, "new", 220); h.complete("new");
  // A second unrelated completion must not replace the new turn's buffered
  // completion, and all timing remains unclaimed until the response arrives.
  h.complete("old");
  assert.ok(records.every(record => record.requestId === oldRequestId));
  h.ack(1, "new");
  const current = records.filter(record => record.requestId !== oldRequestId);
  assert.equal(current.length, 1);
  assert.equal(current[0].turnId, "new");
  assert.equal(current[0].status, "completed");
  assert.equal(current[0].tokenUsage.counts.totalTokens, 60);
  assert.ok(current[0].durationsMs.codex >= 0);
  h.start(3); await tick();
  assert.equal(h.classifications.length, 3);
  h.ack(2, "next"); h.complete("next");
});

test("late resume responses cannot replace a routed request while classification or acknowledgement is pending", async (t) => {
  for (const phase of ["routing", "starting"] as const) await t.test(phase, async (subtest) => {
    const gate = deferred<Route>(); const records: any[] = [];
    const h = harness({ route: () => gate.promise, timing: record => records.push(record) });
    subtest.after(() => h.proxy.close());
    usage(h, "history", 100);
    h.proxy.client({ id: "resume", method: "thread/resume", params: { threadId: "same" } });
    await tick();
    const resume = h.backend.find(message => message.method === "thread/resume")!;
    assert.ok(resume);
    h.start(1); await tick();
    if (phase === "starting") { gate.resolve(route); await tick(); }
    h.proxy.backend({ id: resume.id, result: { thread: { id: "same", status: { type: "active" },
      turns: [{ id: "previous", status: "inProgress" }] } } });
    if (phase === "routing") { gate.resolve(route); await tick(); }
    assert.equal(h.submitted().length, 1);
    h.ack(0, "current"); usage(h, "current", 180); h.complete("current");
    assert.equal(records.length, 1);
    assert.equal(records[0].turnId, "current");
    assert.equal(records[0].tokenUsage.counts.totalTokens, 80);
    h.start(2); await tick();
    assert.equal(h.submitted().length, 2);
    assert.equal(h.submitted()[1].params?.model, "available");
    assert.ok(h.metadata.filter(entry => entry.event === "route-selected").length === 2);
    h.ack(1, "next"); h.complete("next");
  });
});

test("an opaque restored active turn releases only after a read-only thread lookup confirms idle", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  h.proxy.client({ id: "resume", method: "thread/resume", params: { threadId: "same" } });
  await tick();
  const resume = h.backend.find(message => message.method === "thread/resume")!;
  h.proxy.backend({ id: resume.id, result: { thread: { id: "same", status: { type: "active" }, turns: [] } } });
  h.complete("restored-turn"); await tick();
  const reads = h.backend.filter(message => message.method === "thread/read");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].params, { threadId: "same", includeTurns: false });
  assert.equal(h.classifications.length, 0);
  assert.equal(h.submitted().length, 0);
  h.proxy.backend({ id: reads[0].id, result: { thread: { id: "same", status: { type: "idle" } } } });
  await tick();
  h.start(1, { model: "native" }); await tick();
  assert.equal(h.classifications.length, 1);
  assert.equal(h.submitted()[0].params?.model, "available");
  h.ack(0, "new"); h.complete("new");
});

test("an idle notification waits for confirmation and duplicate old lookup results cannot release a newer routed submission", async (t) => {
  const records: any[] = [];
  const h = harness({ timing: record => records.push(record) }); t.after(() => h.proxy.close());
  usage(h, "history", 100);
  h.proxy.client({ id: "resume", method: "thread/resume", params: { threadId: "same" } });
  await tick();
  const resume = h.backend.find(message => message.method === "thread/resume")!;
  h.proxy.backend({ id: resume.id, result: { thread: { id: "same", status: { type: "active" }, turns: [] } } });
  h.complete("restored-turn"); await tick();
  const read = h.backend.find(message => message.method === "thread/read");
  assert.ok(read);
  assert.deepEqual(read.params, { threadId: "same", includeTurns: false });

  // An unowned idle notification cannot release the unknown state while its
  // metadata query is pending; native appends must continue to bypass routing.
  h.proxy.backend({ method: "thread/status/changed", params: { threadId: "same", status: { type: "idle" } } });
  h.start(1, { model: "native" }); await tick();
  assert.equal(h.classifications.length, 0);
  assert.equal(h.submitted()[0].params?.model, "native");
  h.ack(0, "restored-turn");
  h.proxy.backend({ id: read.id, result: { thread: { id: "same", status: { type: "idle" } } } });
  await tick();
  h.start(2); await tick();
  assert.equal(h.classifications.length, 1);
  // Responses are also request-bound: a duplicate result from the completed
  // lookup must not remove the newly created starting state.
  h.proxy.backend({ id: read.id, result: { thread: { id: "same", status: { type: "idle" } } } });
  await tick();
  h.start(3); await tick();
  assert.equal(h.classifications.length, 1);
  assert.equal(h.submitted().length, 2);
  assert.ok(h.client.find(message => message.id === 3)?.error);
  assert.equal(records.length, 0);
  h.ack(1, "current"); usage(h, "current", 180); h.complete("current");
  assert.equal(records.length, 1);
  assert.equal(records[0].turnId, "current");
  assert.equal(records[0].tokenUsage.counts.totalTokens, 80);
  h.start(4); await tick();
  assert.equal(h.classifications.length, 2);
  h.ack(2, "next"); h.complete("next");
});

test("new activity invalidates an opaque turn's idle snapshot until a current lookup confirms completion", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  h.proxy.client({ id: "resume", method: "thread/resume", params: { threadId: "same" } });
  await tick();
  const resume = h.backend.find(message => message.method === "thread/resume")!;
  h.proxy.backend({ id: resume.id, result: { thread: { id: "same", status: { type: "active" }, turns: [] } } });
  h.proxy.backend({ method: "thread/status/changed", params: { threadId: "same", status: { type: "idle" } } });
  await tick();
  const initial = h.backend.find(message => message.method === "thread/read")!;
  assert.ok(initial);
  assert.deepEqual(initial.params, { threadId: "same", includeTurns: false });
  h.proxy.backend({ method: "turn/started", params: { threadId: "same", turn: { id: "live" } } });
  h.proxy.backend({ id: initial.id, result: { thread: { id: "same", status: { type: "idle" } } } });
  await tick();
  const refreshed = h.backend.filter(message => message.method === "thread/read");
  assert.equal(refreshed.length, 2);
  assert.deepEqual(refreshed[1].params, { threadId: "same", includeTurns: false });
  h.start(1, { model: "native", effort: "high" }); await tick();
  assert.equal(h.classifications.length, 0);
  assert.equal(h.submitted()[0].params?.model, "native");
  h.ack(0, "live");

  h.proxy.backend({ id: refreshed[1].id, result: { thread: { id: "same", status: { type: "active" } } } });
  await tick();
  h.start(2, { model: "still-native" }); await tick();
  assert.equal(h.classifications.length, 0);
  assert.equal(h.submitted()[1].params?.model, "still-native");
  h.ack(1, "live");
  h.complete("live"); await tick();
  const finalReads = h.backend.filter(message => message.method === "thread/read");
  assert.equal(finalReads.length, 3);
  h.proxy.backend({ id: finalReads[2].id, result: { thread: { id: "same", status: { type: "idle" } } } });
  await tick();
  h.start(3, { model: "native" }); await tick();
  assert.equal(h.classifications.length, 1);
  assert.equal(h.submitted()[2].params?.model, "available");
  h.ack(2, "new"); h.complete("new");
});

test("completion received before an opaque active resume response prevents restoration of the obsolete state", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  h.proxy.client({ id: "resume", method: "thread/resume", params: { threadId: "same" } });
  await tick();
  const resume = h.backend.find(message => message.method === "thread/resume")!;
  h.complete("previous");
  h.proxy.backend({ id: resume.id, result: { thread: { id: "same", status: { type: "active" }, turns: [] } } });
  h.start(1, { model: "native" }); await tick();
  assert.equal(h.classifications.length, 1);
  assert.equal(h.submitted()[0].params?.model, "available");
  assert.equal(h.backend.filter(message => message.method === "thread/read").length, 0);
  h.ack(0, "current"); h.complete("current");
});

test("two threads keep route parameters and token deltas isolated when classification and responses arrive in reverse order", async (t) => {
  const first = deferred<Route>(), second = deferred<Route>(); const records: any[] = [];
  const h = harness({ route: task => task === "first-task" ? first.promise : second.promise,
    timing: record => records.push(record) }, [
    { model: "available", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { model: "powerful", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  ]); t.after(() => h.proxy.close());
  usage(h, "history-a", 100, "a"); usage(h, "history-b", 1000, "b");
  h.start(1, { threadId: "a", input: [{ type: "text", text: "first-task" }] });
  h.start(2, { threadId: "b", input: [{ type: "text", text: "second-task" }] });
  await tick();
  second.resolve({ ...route, model: "powerful", effort: "high", tier: "hard" }); await tick();
  first.resolve(route); await tick();
  assert.deepEqual(h.submitted().map(message => [message.params?.threadId, message.params?.model, message.params?.effort]),
    [["b", "powerful", "high"], ["a", "available", "low"]]);
  h.ack(1, "turn-a"); h.ack(0, "turn-b");
  usage(h, "turn-b", 1080, "b"); usage(h, "turn-a", 150, "a");
  h.complete("turn-b", "b"); h.complete("turn-a", "a");
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => [record.threadId, record.turnId, record.model, record.effort,
    record.tokenUsage.counts.totalTokens]),
    [["b", "turn-b", "powerful", "high", 80], ["a", "turn-a", "available", "low", 50]]);
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

test("desktop user triggers route before submission and preserve the same thread and collaboration mode", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  const triggers = [undefined, null, "user", "composer", "composer_queue", "composer_queue_run_now", "page_composer", "edit_user_message", "chatgpt_handoff"];
  for (const [i, turnTrigger] of triggers.entries()) {
    h.start(i + 1, { turnTrigger, model: null, effort: null,
      collaborationMode: { mode: "default", settings: { model: "native", reasoning_effort: "xhigh", developer_instructions: "preserve" } },
    });
    await tick();
    const params = h.submitted()[i].params!;
    assert.equal(params.threadId, "same");
    assert.equal(params.turnTrigger, turnTrigger);
    assert.equal(params.model, "available");
    assert.equal(params.effort, "low");
    assert.deepEqual(params.collaborationMode, { mode: "default", settings: { model: "available", reasoning_effort: "low", developer_instructions: "preserve" } });
    h.ack(i, `desktop-${i}`); h.complete(`desktop-${i}`);
  }
  assert.equal(h.classifications.length, triggers.length);
  assert.equal(h.metadata.filter(m => m.event === "route-selected").length, triggers.length);
});

test("desktop background triggers stay unchanged and bypass metadata contains only the reason", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  const triggers = ["automation_cron_scheduled", "automation_heartbeat_scheduled", "safety_buffer_retry", "environment_setup_retry", "send_user_message_async_question", "unknown-sensitive-sentinel"];
  for (const [i, turnTrigger] of triggers.entries()) {
    h.start(i + 1, { turnTrigger, threadId: `background-${i}`, model: "native", effort: "high" });
    await tick();
    assert.equal(h.submitted()[i].params?.model, "native");
    assert.equal(h.submitted()[i].params?.effort, "high");
    assert.equal(h.submitted()[i].params?.turnTrigger, turnTrigger);
  }
  assert.equal(h.classifications.length, 0);
  assert.equal(h.metadata.filter(m => m.event === "turn-bypassed" && m.reason === "non-user-trigger").length, triggers.length);
  assert.equal(JSON.stringify(h.metadata).includes("unknown-sensitive-sentinel"), false);
});

test("desktop composer input added to an active turn and tool continuations do not reroute", async (t) => {
  const h = harness(); t.after(() => h.proxy.close());
  h.start(1, { turnTrigger: "composer" }); await tick(); h.ack();
  h.start(2, { turnTrigger: "composer", model: "native" }); await tick();
  assert.equal(h.classifications.length, 1);
  assert.equal(h.submitted()[1].params?.model, "native");
  assert.ok(h.metadata.some(m => m.event === "turn-bypassed" && m.reason === "active-turn"));
  h.complete();
  h.start(3, { turnTrigger: "composer", model: "native", toolOutput: { type: "fixture" } }); await tick();
  assert.equal(h.classifications.length, 1);
  assert.ok(h.metadata.some(m => m.event === "turn-bypassed" && m.reason === "tool-output"));
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
