import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { desktopBackendEnv, startDesktopHost, stopDesktopChild } from "./desktop-host.js";
import { CliProxy } from "./cli-proxy.js";
import { desktopLaunchEnvironment, launchDesktop } from "./desktop-launch.js";

test("backend strips key and restores CLI path without mutating parent", () => {
  const env = { TYPESAFE_API_KEY: "sentinel", CODEX_CLI_PATH: "shim", JEV_DESKTOP_NODE: "node", KEEP: "yes" };
  assert.deepEqual(desktopBackendEnv(env, "real"), { CODEX_CLI_PATH: "real", KEEP: "yes" });
  assert.equal(env.TYPESAFE_API_KEY, "sentinel");
});

test("desktop launch guard rejects an existing app before invoking spawn; overrides stay process-local", () => {
  let launched = 0;
  const fakeSpawn = ((..._args: any[]) => { launched++; return {}; }) as typeof spawn;
  const original = { CODEX_CLI_PATH: 'old', CODEX_APP_SERVER_WS_URL: 'old', CODEX_APP_SERVER_FORCE_CLI: '1', JEV_DESKTOP_CODEX: 'stale', TYPESAFE_API_KEY: 'sentinel', KEEP: 'yes' };
  const env = desktopLaunchEnvironment(original);
  assert.deepEqual(env, { TYPESAFE_API_KEY: 'sentinel', KEEP: 'yes' });
  assert.equal(original.CODEX_CLI_PATH, 'old');
  assert.throws(() => launchDesktop({ running: true, app: 'fake', project: '.', env }, fakeSpawn), /Desktop is running/);
  assert.equal(launched, 0);
  launchDesktop({ running: false, app: 'fake', project: '.', env }, fakeSpawn);
  assert.equal(launched, 1);
});
test("stdio roundtrip preserves envelope and backend exit; stdout contains only JSON", async () => {
  const input = new PassThrough(); const output = new PassThrough(); let data = "";
  output.on("data", (chunk) => { data += chunk; });
  const host = startDesktopHost({ project: process.cwd(), executable: process.execPath,
    args: ["-e", `process.stdin.once('data', d => { const m = JSON.parse(d); process.stdout.write(JSON.stringify({id:m.id,result:{kept:m.params,key:process.env.TYPESAFE_API_KEY ?? null,cli:process.env.CODEX_CLI_PATH}})+'\\n'); setTimeout(()=>process.exit(7),50); });`],
    env: { ...process.env, TYPESAFE_API_KEY: "secret" }, input, output,
    route: async () => { throw new Error("unexpected route"); },
  });
  input.write(JSON.stringify({ id: 77, method: "test/echo", params: { text: "中文\u2028", extra: [1, 2] } }) + "\n");
  assert.equal(await host.closed, 7);
  assert.deepEqual(JSON.parse(data), { id: 77, result: { kept: { text: "中文\u2028", extra: [1, 2] }, key: null, cli: process.execPath } });
});
test("EOF and cancellation terminate only the owned stubborn child within a deadline", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "pipe", windowsHide: true });
  const start = Date.now(); await stopDesktopChild(child, 30);
  assert.ok(Date.now() - start < 2500);
  const input = new PassThrough();
  const host = startDesktopHost({ project: process.cwd(), executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env, input, output: new PassThrough(), route: async () => { throw new Error(); } });
  input.end(); assert.equal(await host.closed, 0);
});
test("desktop ignores out-of-scope thread setup and turns", () => {
  const backend: any[] = [];
  const proxy = new CliProxy({ project: process.cwd(), manageThread: () => false, route: async () => { throw new Error(); }, toBackend: (m) => backend.push(m), toClient: () => {}, fatal: () => {} });
  const params = { cwd: "elsewhere", developerInstructions: "unchanged", config: { test: true } };
  proxy.client({ id: 1, method: "thread/start", params });
  assert.deepEqual(backend[0].params, params);
  proxy.client({ id: 2, method: "turn/start", params: { threadId: "remote", model: "original", input: [] } });
  assert.equal(backend[1].params.model, "original"); proxy.close();
});
for (const sendNotification of [false, true]) {
  test(`acknowledged initialize supports resume and routing (initialized notification: ${sendNotification})`, async (t) => {
    const backend: any[] = [], client: any[] = [], metadata: any[] = [];
    let classified = 0;
    const catalog = { data: [{ model: "fixture", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null };
    const proxy = new CliProxy({ project: "selected", manageThread: p => p.cwd === "selected",
      route: async () => { classified++; return { model: "fixture", effort: "low", tier: "cheap", reason: "test" }; },
      toBackend(m) {
        backend.push(m);
        const result = m.method === "initialize" ? { userAgent: "fixture" }
          : m.method === "account/read" ? { account: { type: "chatgpt" } }
          : m.method === "model/list" ? catalog
          : m.method === "thread/read" ? { thread: { id: "same", cwd: "selected" } }
          : m.method === "config/read" ? { config: {} }
          : m.method === "thread/resume" ? { thread: { id: m.params?.threadId, turns: [] } }
          : m.method === "turn/start" ? { turn: { id: "turn", status: "completed" } } : undefined;
        if (result) queueMicrotask(() => proxy.backend({ id: m.id, result }));
      }, toClient: m => client.push(m), metadata: m => metadata.push(m), fatal: () => assert.fail("Unexpected fatal"),
    });
    t.after(() => proxy.close());
    const tick = () => new Promise(r => setImmediate(r));
    proxy.client({ id: "__codex_initialize__", method: "initialize", params: { clientInfo: { name: "desktop", version: "fixture" } } });
    await tick();
    assert.deepEqual(client[0], { id: "__codex_initialize__", result: { userAgent: "fixture" } });
    if (sendNotification) proxy.client({ method: "initialized" });
    proxy.client({ id: "models", method: "model/list", params: {} });
    proxy.client({ id: "resume", method: "thread/resume", params: { threadId: "same" } });
    await tick();
    assert.deepEqual(client.find(m => m.id === "models").result, catalog);
    assert.equal(client.find(m => m.id === "resume").result.thread.id, "same");
    assert.equal(classified, 0, "Loading a conversation must not classify it");
    proxy.client({ id: "turn", method: "turn/start", params: { threadId: "same", turnTrigger: "composer", model: null, effort: null, input: [{ type: "text", text: "question" }] } });
    await tick();
    const turn = backend.find(m => m.method === "turn/start");
    assert.equal(turn.params.threadId, "same");
    assert.equal(turn.params.turnTrigger, "composer");
    assert.equal(turn.params.model, "fixture");
    assert.equal(turn.params.effort, "low");
    assert.equal(classified, 1);
    assert.equal(metadata.filter(m => m.event === "backend-initialized").length, 1);
  });
}

test("pending or rejected initialize never unlocks managed resume", async (t) => {
  const backend: any[] = [], client: any[] = [];
  const proxy = new CliProxy({ project: "selected", manageThread: () => true,
    toBackend: m => backend.push(m), toClient: m => client.push(m),
    route: async () => { throw new Error("Must not classify"); }, fatal: () => assert.fail("Unexpected fatal"),
  });
  t.after(() => proxy.close());
  const tick = () => new Promise(r => setImmediate(r));
  proxy.client({ id: "init", method: "initialize", params: {} });
  const initializeId = backend[0].id;
  proxy.client({ id: "pending", method: "thread/resume", params: { threadId: "same", cwd: "selected" } });
  await tick();
  assert.ok(client.find(m => m.id === "pending").error);
  proxy.backend({ id: initializeId, error: { code: -1, message: "Initialization rejected" } });
  assert.deepEqual(client.find(m => m.id === "init").error, { code: -1, message: "Initialization rejected" });
  proxy.client({ id: "rejected", method: "thread/resume", params: { threadId: "same", cwd: "selected" } });
  await tick();
  assert.ok(client.find(m => m.id === "rejected").error);
  assert.deepEqual(backend.map(m => m.method), ["initialize"]);
});

test("compiled shim transparently preserves argv, stdio, exit code and removes backend key", { skip: process.platform !== "win32" }, () => {
  const shim = resolve(".router-memory/desktop/jev-desktop-shim.exe");
  assert.ok(existsSync(shim), "Run npm run desktop -- --prepare first");
  const args = ["", "space value", 'embedded"quote', "trailing slash\\", "中文"];
  const child = spawnSync(shim, ["-e", "process.stdin.once('data',d=>{console.log(JSON.stringify({args:process.argv.slice(1),input:d.toString(),key:process.env.TYPESAFE_API_KEY??null,cli:process.env.CODEX_CLI_PATH}));process.exitCode=19})", "--", ...args], {
    env: { ...process.env, JEV_DESKTOP_CODEX: process.execPath, TYPESAFE_API_KEY: "secret", CODEX_CLI_PATH: shim }, input: "hello", encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 19, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { args, input: "hello", key: null, cli: process.execPath });
});

const shimEnv = () => ({ ...process.env, JEV_DESKTOP_CODEX: process.execPath, JEV_DESKTOP_NODE: process.execPath,
  JEV_DESKTOP_TSX: pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
  JEV_DESKTOP_ENTRY: resolve('src/fixtures/desktop-entry.cjs') });

test("native shim intercepts desktop app-server even with preceding global config flags", { skip: process.platform !== 'win32' }, () => {
  for (const args of [ ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'],
    ['app-server', '-c', 'test="space value"', '--listen', 'stdio://'] ]) {
    const child = spawnSync(resolve('.router-memory/desktop/jev-desktop-shim.exe'), args, {
      env: shimEnv(), input: '中文\u2028\n', encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { args, input: '中文\u2028\n' });
  }
});

test("abrupt shim exit reaps its Node and descendant processes through Windows job ownership", { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const shim = spawn(resolve('.router-memory/desktop/jev-desktop-shim.exe'), ['app-server'], {
    env: { ...shimEnv(), JEV_TEST_DESCENDANT: '1' }, stdio: 'pipe', windowsHide: true,
  });
  const close = once(shim, 'close');
  try {
    const [chunk] = await once(shim.stdout, 'data');
    const { childPid, nodePid } = JSON.parse(chunk.toString());
    shim.kill(); await close;
    const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 2000;
    while ((exists(childPid) || exists(nodePid)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    assert.equal(exists(childPid), false); assert.equal(exists(nodePid), false);
  } finally { shim.kill(); }
});

test("native shim forwards a small interactive message before stdin EOF", { skip: process.platform !== 'win32', timeout: 5000 }, async () => {
  const shim = spawn(resolve('.router-memory/desktop/jev-desktop-shim.exe'), ['app-server'], {
    env: { ...shimEnv(), JEV_TEST_STREAMING: '1' }, stdio: 'pipe', windowsHide: true,
  });
  try {
    const data = once(shim.stdout, 'data');
    shim.stdin.write('{"id":1}\n');
    assert.equal((await data)[0].toString(), '{"id":1}\n');
  } finally { shim.kill(); }
});

test("scoped desktop resume reads cwd, preserves thread ID and routes both turns; other project bypasses", async () => {
  const backend: any[] = [], client: any[] = []; let classified = 0;
  const proxy = new CliProxy({ project: 'selected', manageThread: p => p.cwd === 'selected',
    route: async () => { classified++; return { model: 'fixture', effort: 'low', tier: 'cheap', reason: 'test' }; },
    toBackend(m) {
      backend.push(m);
      const result = m.method === 'thread/read' ? { thread: { cwd: m.params?.threadId === 'other' ? 'other' : 'selected' } }
        : m.method === 'account/read' ? { account: { type: 'chatgpt' } }
        : m.method === 'model/list' ? { data: [{ model: 'fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
        : m.method === 'config/read' ? { config: {} }
        : m.method === 'thread/resume' ? { thread: { id: m.params?.threadId, turns: [] } }
        : m.method === 'turn/start' ? { turn: { id: String(m.id), status: 'completed' } } : undefined;
      if (result) queueMicrotask(() => proxy.backend({ id: m.id, result }));
    }, toClient: m => client.push(m), fatal: () => { throw new Error('Unexpected fatal'); },
  });
  try {
    const tick = () => new Promise(r => setImmediate(r));
    proxy.client({ method: 'initialized' });
    proxy.client({ id: 1, method: 'thread/resume', params: { threadId: 'same' } }); await tick();
    for (const id of [2,3]) { proxy.client({ id, method: 'turn/start', params: { threadId: 'same', model: 'old', input: [{ type: 'text', text: 'test' }] } }); await tick(); }
    assert.equal(classified, 2); assert.equal(client.find(m => m.id === 1).result.thread.id, 'same');
    assert.equal(backend.filter(m => m.method === 'turn/start').every(m => m.params.model === 'fixture'), true);
    proxy.client({ id: 4, method: 'thread/resume', params: { threadId: 'other' } }); await tick();
    proxy.client({ id: 5, method: 'turn/start', params: { threadId: 'other', model: 'native', input: [] } }); await tick();
    assert.equal(classified, 2); assert.equal(backend.at(-1).params.model, 'native');
  } finally { proxy.close(); }
});
