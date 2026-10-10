import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppServerClient, type Notification, type RpcConnection, type RpcParams } from "./app-server-client.js";
import { ChatSession, routingContext, type ChatState } from "./chat-session.js";
import { ChatStore } from "./chat-store.js";
import { routeFromTier } from "./router.js";
import { routeTaskWithJev } from "./jev-router.js";

class FakeServer implements RpcConnection {
  calls: { method: string; params: RpcParams }[] = [];
  listeners = new Set<(event: Notification) => void>();
  failures = new Set<(error: Error) => void>();
  account = "chatgpt";
  earlyCompletion = false;
  complete = true;
  cwd = process.cwd();
  async request<T>(method: string, params: RpcParams = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: unknown = {};
    if (method === "account/read") result = { account: { type: this.account } };
    if (method === "model/list") result = {
      data: ["cheap", "standard", "hard"].map((tier) => {
        const route = routeFromTier(tier as "cheap", "balanced");
        return { model: route.model, supportedReasoningEfforts: [{ reasoningEffort: route.effort }] };
      }), nextCursor: null,
    };
    if (method === "thread/start") result = { thread: { id: "thread-1" } };
    if (method === "thread/read") result = { thread: { cwd: this.cwd, status: { type: "idle" } } };
    if (method === "thread/resume") result = { thread: { id: params.threadId } };
    if (method === "turn/start") {
      const turn = { id: `turn-${this.calls.filter((call) => call.method === method).length}`, status: "inProgress" };
      this.emit("turn/started", { threadId: params.threadId, turn });
      result = { turn };
      if (this.complete) {
        const finish = () => this.emit("turn/completed", { threadId: params.threadId, turn: { ...turn, status: "completed" } });
        if (this.earlyCompletion) finish(); else setImmediate(finish);
      }
    }
    if (method === "turn/interrupt") this.emit("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } });
    return result as T;
  }
  emit(method: string, params: RpcParams) { for (const listener of this.listeners) listener({ method, params }); }
  onNotification(listener: (event: Notification) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onFailure(listener: (error: Error) => void) { this.failures.add(listener); return () => { this.failures.delete(listener); }; }
}

function state(threadId: string | null = null): ChatState {
  return { version: 1, project: process.cwd(), threadId, recentTasks: [] };
}
const cheap = routeFromTier("cheap", "balanced");
const hard = routeFromTier("hard", "balanced");

test("two model tiers execute sequential turns on exactly the same thread", async () => {
  const rpc = new FakeServer();
  const saves: ChatState[] = [];
  const session = new ChatSession(rpc, state(), "read-only", async (value) => { saves.push(structuredClone(value)); });
  await session.prepare();
  await session.run("Remember marker: alpha", cheap, () => {});
  await session.run("What was the marker?", hard, () => {});
  assert.equal(rpc.calls.filter((call) => call.method === "thread/start").length, 1);
  const turns = rpc.calls.filter((call) => call.method === "turn/start");
  assert.deepEqual(turns.map((call) => [call.params.threadId, call.params.model, call.params.effort]), [
    ["thread-1", cheap.model, "low"], ["thread-1", hard.model, "high"],
  ]);
  assert.deepEqual(turns[1].params.input, [{ type: "text", text: "What was the marker?", text_elements: [] }]);
  assert.equal(saves[0].threadId, "thread-1");
  assert.deepEqual(saves[0].recentTasks, []); // pointer persisted before any turn
  assert.match(routingContext(session.state)!, /Remember marker/);
});

test("resume keeps the saved thread, disables recursive routing and applies explicit sandbox", async () => {
  const rpc = new FakeServer();
  const session = new ChatSession(rpc, state("saved-thread"), "workspace-write", async () => {});
  await session.prepare();
  await session.run("continue", cheap, () => {});
  assert.equal(rpc.calls.some((call) => call.method === "thread/start"), false);
  const resume = rpc.calls.find((call) => call.method === "thread/resume")!.params;
  assert.equal((resume.config as RpcParams)["mcp_servers.jev_model_router.enabled"], false);
  assert.match(String(resume.developerInstructions), /Do not call jev_route_and_run/);
  const turn = rpc.calls.find((call) => call.method === "turn/start")!.params;
  assert.equal(turn.threadId, "saved-thread");
  assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false });
});

test("completion before turn/start response is not lost", async () => {
  const rpc = new FakeServer(); rpc.earlyCompletion = true;
  const session = new ChatSession(rpc, state(), "read-only", async () => {});
  await session.prepare();
  assert.equal((await session.run("hello", cheap, () => {})).status, "completed");
  assert.equal(rpc.listeners.size, 0);
});

test("cancel interrupts the active turn; concurrent task is rejected", async () => {
  const rpc = new FakeServer(); rpc.complete = false;
  const session = new ChatSession(rpc, state(), "read-only", async () => {});
  await session.prepare();
  const pending = session.run("long work", cheap, () => {});
  await assert.rejects(session.run("second", cheap, () => {}), /不能同时/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await session.interrupt();
  assert.equal((await pending).status, "interrupted");
  assert.equal(rpc.calls.filter((call) => call.method === "turn/interrupt").length, 1);
});

test("unavailable model, wrong project and API key authentication fail without starting a turn", async () => {
  const rpc = new FakeServer();
  const session = new ChatSession(rpc, state("saved-thread"), "read-only", async () => {});
  rpc.account = "apiKey";
  await assert.rejects(session.prepare(), /ChatGPT 登录/);
  rpc.account = "chatgpt";
  await session.prepare();
  await assert.rejects(session.run("hi", { ...cheap, model: "missing-model" }, () => {}), /没有 missing-model/);
  rpc.cwd = resolve(process.cwd(), "different-project");
  await assert.rejects(session.run("hi", cheap, () => {}), /不同项目/);
  assert.equal(rpc.calls.some((call) => call.method === "turn/start"), false);
});

test("disconnect rejects active work and removes event listeners", async () => {
  const rpc = new FakeServer(); rpc.complete = false;
  const session = new ChatSession(rpc, state(), "read-only", async () => {});
  await session.prepare();
  const pending = session.run("hi", cheap, () => {});
  const rejected = assert.rejects(pending, /disconnected/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const listener of rpc.failures) listener(new Error("disconnected"));
  await rejected;
  assert.equal(rpc.listeners.size, 0);
});

test("Jev boundary 0.50 is accepted; 0.49 falls back; only bounded user context is sent", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-not-a-real-key";
  let confidence = 0.5;
  const chatState = state(); chatState.recentTasks = ["先解决过连接超时"];
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.match(body.state.recentContext, /连接超时/);
      assert.equal(body.state.task, "解释代码");
      return new Response(JSON.stringify({ answers: { tier: { choice: "hard", confidence } } }));
    };
    assert.equal((await routeTaskWithJev("解释代码", "balanced", { context: routingContext(chatState) })).tier, "hard");
    confidence = 0.49;
    const fallback = await routeTaskWithJev("解释代码", "balanced", { context: routingContext(chatState) });
    assert.equal(fallback.source, "fallback");
    assert.equal(fallback.tier, "cheap");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
  }
});

test("store restores identity and rejects a second writer", async () => {
  const project = await mkdtemp(join(tmpdir(), "router-chat-test-"));
  const first = new ChatStore(project, "one");
  const second = new ChatStore(project, "one");
  try {
    await first.acquire();
    await assert.rejects(second.acquire(), /另一个入口/);
    await first.save({ version: 1, project, threadId: "saved-thread", recentTasks: ["previous task"] });
    await first.release();
    await second.acquire();
    assert.equal((await second.read()).threadId, "saved-thread");
    assert.throws(() => new ChatStore(project, "../escape"), /session/);
  } finally {
    await first.release(); await second.release();
    // Delete only the unique directory created by this test in the system temp root.
    assert.equal(dirname(resolve(project)), resolve(tmpdir()));
    assert.match(project, /router-chat-test-[^\\/]+$/);
    await rm(project, { recursive: true, force: true });
  }
});

test("stdio transport correlates replies, handles server requests, and decodes split UTF-8", async () => {
  const script = `
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') {
        process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n');
      } else if (m.method === 'probe') {
        process.stdout.write(JSON.stringify({id:90,method:'approve',params:{}})+'\\n');
        const b = Buffer.from(JSON.stringify({method:'delta',params:{text:'中文'}})+'\\n');
        const i = b.indexOf(Buffer.from('中文')) + 1;
        process.stdout.write(b.subarray(0,i));
        setTimeout(()=> { process.stdout.write(b.subarray(i)); process.stdout.write(JSON.stringify({id:m.id,result:{value:7}})+'\\n'); }, 5);
      }
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let approved = false;
  const client = new AppServerClient(child, async () => { approved = true; return { decision: "decline" }; });
  const events: Notification[] = [];
  client.onNotification((event) => events.push(event));
  try {
    await client.initialize();
    assert.equal((await client.request<{ value: number }>("probe")).value, 7);
    assert.equal(approved, true);
    assert.equal(events[0].params.text, "中文");
  } finally { await client.close(); }
});
