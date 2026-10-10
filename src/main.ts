import { resolve } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { routeTask, DEFAULT_MODELS } from "./router.js";
import { routeTaskWithJev } from "./jev-router.js";
import { FileMemory } from "./memory.js";
import { CodexCliExecutor, CodexSdkExecutor } from "./executor.js";
import type { Mode, Tier } from "./types.js";

const argv = process.argv.slice(2);
function value(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}
function requiredValue(name: string, fallback?: string): string | undefined {
  const found = value(name) ?? fallback;
  if (argv.includes(name) && !found) throw new Error(`${name} requires a value`);
  return found;
}

const project = resolve(requiredValue("--project", process.cwd())!);
const mode = (requiredValue("--mode", "balanced") ?? "balanced") as Mode;
if (!["balanced", "economy", "quality"].includes(mode)) throw new Error("--mode must be balanced, economy, or quality");
const adapter = requiredValue("--adapter", "cli") ?? "cli";
if (adapter !== "cli" && adapter !== "sdk") throw new Error("--adapter must be cli or sdk");
const routing = requiredValue("--router", "rules") ?? "rules";
if (routing !== "rules" && routing !== "jev") throw new Error("--router must be rules or jev");
const prompt = requiredValue("--task") ?? "";
if (!prompt.trim()) {
  console.log('Usage: npm run dev -- --project "D:\\Project" --task "Analyze the project" [--mode balanced] [--router rules|jev] [--adapter cli|sdk] [--classify|--run]');
  process.exit(0);
}

const models: Partial<Record<Tier, string>> = {
  cheap: requiredValue("--model-cheap", process.env.ROUTER_MODEL_CHEAP ?? DEFAULT_MODELS.cheap),
  standard: requiredValue("--model-standard", process.env.ROUTER_MODEL_STANDARD ?? DEFAULT_MODELS.standard),
  hard: requiredValue("--model-hard", process.env.ROUTER_MODEL_HARD ?? DEFAULT_MODELS.hard),
};
const run = argv.includes("--run");
const classifyOnly = argv.includes("--classify");
if (routing === "jev" && !run && !classifyOnly) {
  throw new Error("Jev is an online, metered classifier. Add --classify to call Jev only, or --run to classify and then call Codex.");
}
if (routing === "rules" && classifyOnly) throw new Error("--classify is only used with --router jev.");

const route = routing === "jev"
  ? await routeTaskWithJev(prompt, mode, { models })
  : routeTask(prompt, mode, { models });
if (classifyOnly) {
  console.log(JSON.stringify({ project, mode, router: routing, route, jevClassified: true, codexExecuted: false }, null, 2));
  // Let fetch/Undici finish closing its handles; process.exit() can trigger a
  // libuv UV_HANDLE_CLOSING assertion on some Windows Node.js builds.
  process.exitCode = 0;
} else {
  const memory = new FileMemory();
  const past = run ? await memory.read(project) : "";
  const fullPrompt = past
    ? `Project history (potentially outdated; verify against source files):\n${past}\n\nCurrent task:\n${prompt}`
    : prompt;
  const executor = adapter === "sdk" ? new CodexSdkExecutor() : new CodexCliExecutor();
  const result = await executor.execute(fullPrompt, project, route, { run });
  console.log(JSON.stringify({ project, mode, router: routing, adapter, route, jevClassified: routing === "jev", codexExecuted: run, command: result.command, exitCode: result.exitCode, output: result.output.slice(0, 3000) }, null, 2));
  if (run) {
    await memory.append(project, prompt, result.output.slice(-600));
    const directory = resolve(project, ".router-memory");
    await mkdir(directory, { recursive: true });
    await appendFile(resolve(directory, "runs.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), mode, adapter, route, exitCode: result.exitCode })}\n`);
    if (result.exitCode !== 0) process.exitCode = 1;
  }
}
