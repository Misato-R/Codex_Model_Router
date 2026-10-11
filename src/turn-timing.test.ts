import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingWriter } from "./turn-timing.js";
import { routeTaskWithJev } from "./jev-router.js";

test("Jev timer includes response body parsing and reports failed HTTP requests", async () => {
  const previousKey = process.env.TYPESAFE_API_KEY;
  const previousFetch = globalThis.fetch;
  const durations: number[] = [];
  let release!: () => void;
  const bodyReady = new Promise<void>(resolve => { release = resolve; });
  try {
    process.env.TYPESAFE_API_KEY = "test-not-a-real-key";
    globalThis.fetch = async () => ({ ok: true, json: async () => {
      await bodyReady;
      return { answers: { tier: { choice: "cheap", confidence: 0.9 } } };
    } }) as Response;
    const pending = routeTaskWithJev("test", "balanced", { onRequestTiming: ms => durations.push(ms) });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(durations.length, 0);
    release(); await pending;
    assert.equal(durations.length, 1);
    assert.ok(Number.isFinite(durations[0]) && durations[0] >= 0);
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(routeTaskWithJev("test", "balanced", { onRequestTiming: ms => durations.push(ms) }), /HTTP 503/);
    assert.equal(durations.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test("recording is opt-in and stopping its marker prevents further JSON files", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmr-timing-"));
  const previous = process.env.CMR_TIMING_ACTIVE;
  const marker = join(directory, "active");
  try {
    process.env.CMR_TIMING_ACTIVE = marker;
    writeFileSync(marker, "active");
    const writer = timingWriter(directory)!;
    writer({ requestId: "first" });
    rmSync(marker);
    writer({ requestId: "second" });
    assert.deepEqual(readdirSync(directory), ["turn-first.json"]);
    assert.equal(timingWriter(""), undefined);
  } finally {
    if (previous === undefined) delete process.env.CMR_TIMING_ACTIVE; else process.env.CMR_TIMING_ACTIVE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
