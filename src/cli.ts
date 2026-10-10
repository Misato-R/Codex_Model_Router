import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { codexRuntime } from "./app-server-client.js";
import { startHost, stopChild } from "./cli-host.js";
import { childEnvironment, frontendArgs, TOKEN_ENV } from "./cli-security.js";
import { routeTaskWithJev } from "./jev-router.js";
import { routeTask, type RouteOptions } from "./router.js";
import type { Mode, Tier } from "./types.js";

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const separator = raw.indexOf("--");
  const nativeArgs = separator < 0 ? [] : raw.slice(separator + 1);
  const { values } = parseArgs({ args: separator < 0 ? raw : raw.slice(0, separator), options: {
    project: { type: "string" }, router: { type: "string", default: "jev" }, mode: { type: "string", default: "balanced" },
    "model-cheap": { type: "string" }, "model-standard": { type: "string" }, "model-hard": { type: "string" },
    manual: { type: "boolean" }, serve: { type: "boolean" }, port: { type: "string", default: "0" }, resume: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`Experimental native Codex CLI + local Jev proxy
npm run cli -- [--project PATH] [--router jev|rules] [--mode balanced|economy|quality]
  [--model-cheap NAME] [--model-standard NAME] [--model-hard NAME]
  [--manual] [--resume THREAD_ID] [--port 0] [-- NATIVE_CODEX_OPTIONS]
--serve: protocol harness only; set ${TOKEN_ENV} to a random 32+ character capability.
Automatic mode overrides /model for each NEW turn; --manual preserves native selection.
Active turn/steer and active turn/start pass through unchanged. No new UI or slash commands.`);
    return;
  }
  if (!["jev", "rules"].includes(values.router)) throw new Error("Invalid --router");
  if (!["balanced", "economy", "quality"].includes(values.mode)) throw new Error("Invalid --mode");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");
  if (values.serve && (values.resume || nativeArgs.length)) throw new Error("--serve cannot launch/resume the frontend.");
  if (!values.serve && !process.stdin.isTTY) throw new Error("Native CLI needs a terminal. Use --serve for protocol tests.");
  const project = await realpath(resolve(values.project ?? process.cwd()));
  if (!(await stat(project)).isDirectory()) throw new Error("Project must be a directory");
  const options: RouteOptions = { models: {} };
  for (const tier of ["cheap", "standard", "hard"] as Tier[]) {
    const model = values[`model-${tier}`] ?? process.env[`ROUTER_MODEL_${tier.toUpperCase()}`];
    if (model) options.models![tier] = model;
  }
  const runtime = codexRuntime();
  const token = values.serve ? process.env[TOKEN_ENV] : randomBytes(32).toString("base64url");
  if (!token || token.length < 32) throw new Error(`--serve requires a random 32+ character ${TOKEN_ENV}; never paste it into chat.`);
  const logDir = join(project, ".router-memory", "cli");
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `routes-${Date.now()}-${process.pid}.jsonl`);
  let writes = Promise.resolve();
  const host = await startHost({ project, executable: runtime.executable, env: runtime.env, token, port, manual: values.manual,
    route: (task, context, signal) => values.router === "jev"
      ? routeTaskWithJev(task, values.mode as Mode, { ...options, context, signal })
      : Promise.resolve(routeTask(task, values.mode as Mode, options)),
    metadata: (entry) => { writes = writes.then(() => appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 })); void writes.catch(() => host.close()); },
  });
  const interrupt = () => { if (values.serve) void host.close(); }; // Native TUI owns Ctrl-C.
  const terminate = () => { void host.close(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  let frontend: ReturnType<typeof spawn> | undefined;
  try {
    if (values.serve) {
      console.log(JSON.stringify({ url: host.url, tokenEnv: TOKEN_ENV, metadataLog: logPath }));
      await host.closed;
    } else {
      const args = frontendArgs(host.url, values.resume, nativeArgs);
      frontend = spawn(runtime.executable, args, { cwd: project, env: { ...childEnvironment(runtime.env), [TOKEN_ENV]: token }, shell: false, stdio: "inherit" });
      const exited = new Promise<number | null>((resolve, reject) => {
        frontend!.once("error", reject); frontend!.once("close", resolve);
      });
      // /quit closes the socket just before the native process reports exit.
      const code = await Promise.race([exited, host.closed.then(() => new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(1), 1000);
        exited.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(1); });
      }))]);
      process.exitCode = code ?? 1;
    }
  } finally {
    await host.close();
    if (frontend) await stopChild(frontend);
    await writes;
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  }
}

void main().catch(() => { console.error("CLI proxy failed. Check dependencies, ChatGPT login, project/options and runtime. No automatic turn retry."); process.exitCode = 1; });
