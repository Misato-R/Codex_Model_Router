import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { startDesktopHost } from "./desktop-host.js";
import { timingWriter } from "./turn-timing.js";

test("real stdio worker emits four durations and one per-turn JSON usage record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmr-recording-"));
  const input = new PassThrough(), output = new PassThrough();
  const received: any[] = []; let buffer = "";
  output.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) if (line) received.push(JSON.parse(line));
  });
  const host = startDesktopHost({ project: process.cwd(), executable: process.execPath,
    args: [resolve("src/fixtures/timing-backend.cjs")], env: process.env, input, output,
    timing: timingWriter(directory), route: async (_task, _context, _signal, onJevTiming) => {
      onJevTiming(1.25); return { model: "fixture", effort: "low", tier: "cheap", source: "jev", reason: "fixture" };
    } });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("worker timeout"); await new Promise(r => setTimeout(r, 10)); }
  };
  try {
    input.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + '\n');
    await wait(() => received.some(r => r.id === 1));
    input.write(JSON.stringify({ id: 2, method: "thread/start", params: {} }) + '\n');
    await wait(() => received.some(r => r.id === 2));
    input.write(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "fixture-thread", input: [{ type: "text", text: "private fixture prompt" }] } }) + '\n');
    await wait(() => received.some(r => r.method === "turn/completed"));
    const files = readdirSync(directory); assert.equal(files.length, 1);
    const log = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    assert.equal(log.tokenUsage.counts.totalTokens, 150);
    assert.equal(log.durationsMs.jevRequest, 1.25);
    assert.ok(log.durationsMs.routing >= 0 && log.durationsMs.codex >= 0);
    assert.ok(Math.abs(log.durationsMs.total - log.durationsMs.routing - log.durationsMs.codex) < 0.003);
    assert.equal(JSON.stringify(log).includes("private fixture prompt"), false);
  } finally { input.end(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});
