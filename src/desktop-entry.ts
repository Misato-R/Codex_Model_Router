import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { startDesktopHost } from "./desktop-host.js";
import { routeTaskWithJev } from "./jev-router.js";
import { routeTask } from "./router.js";
import type { Mode } from "./types.js";

try {
  const project = process.env.JEV_DESKTOP_PROJECT!;
  const executable = process.env.JEV_DESKTOP_CODEX!;
  if (!project || !executable) throw new Error("Missing launch environment");
  const router = process.env.JEV_DESKTOP_ROUTER ?? "jev";
  const mode = (process.env.JEV_DESKTOP_MODE ?? "balanced") as Mode;
  if (!["jev", "rules", "manual"].includes(router) || !["balanced", "economy", "quality"].includes(mode)) throw new Error("Invalid launch options");
  const models = JSON.parse(process.env.JEV_DESKTOP_MODELS ?? "{}");
  const metadata = (entry: Record<string, unknown>) => {
    if (process.env.JEV_DESKTOP_LOG) appendFileSync(process.env.JEV_DESKTOP_LOG, JSON.stringify({ timestamp: new Date().toISOString(), proxyPid: process.pid, ...entry }) + "\n", { mode: 0o600 });
  };
  metadata({ event: "proxy-started", router, mode });
  const host = startDesktopHost({ project, executable, args: process.argv.slice(2), env: process.env, input: process.stdin, output: process.stdout,
    manual: router === "manual",
    manageThread: (p) => !p.remote && !p.remoteUrl && typeof p.cwd === "string" && resolve(p.cwd).toLowerCase() === resolve(project).toLowerCase(),
    route: (task, context, signal) => router === "jev" ? routeTaskWithJev(task, mode, { models, context, signal }) : Promise.resolve(routeTask(task, mode, { models })),
    metadata,
  });
  process.once("SIGINT", () => { void host.close(130); }); process.once("SIGTERM", () => { void host.close(143); });
  void host.closed.then((code) => { process.stdout.write("", () => process.exit(code)); });
} catch { process.stderr.write("Desktop proxy failed; no automatic retry.\n"); process.exitCode = 1; }
