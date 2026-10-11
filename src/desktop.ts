import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { requireDesktopStopped, desktopLaunchEnvironment, launchDesktop } from "./desktop-launch.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function powershell(script: string): string { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim(); }
try {
  if (process.argv.includes("--help")) {
    console.log(`Experimental original desktop + stdio Jev proxy
npm run desktop -- [--project PATH] [--router jev|rules] [--mode balanced|economy|quality]
  [--manual] [--model-cheap ID] [--model-standard ID] [--model-hard ID]
  [--app APP_EXE] [--codex MATCHING_BACKEND_EXE] [--isolated-profile PATH]
--check: discover paths without launching. --prepare: compile only.
Fully exit the existing desktop before launch. Only the selected local project is routed.
Quit this experimental app and launch the normal shortcut to restore normal startup.`);
    process.exit(0);
  }
  const { values: v } = parseArgs({ options: { check: { type: "boolean" }, prepare: { type: "boolean" }, app: { type: "string" }, codex: { type: "string" }, project: { type: "string" }, router: { type: "string", default: "jev" }, manual: { type: "boolean" }, mode: { type: "string", default: "balanced" }, "isolated-profile": { type: "string" }, "model-cheap": { type: "string" }, "model-standard": { type: "string" }, "model-hard": { type: "string" } } });
  if (process.platform !== "win32") throw new Error("Desktop experiment requires Windows");
  const router = v.manual ? "manual" : v.router!;
  if (!["manual", "rules", "jev"].includes(router) || !["balanced", "economy", "quality"].includes(v.mode!)) throw new Error("Invalid router/mode");
  const app = resolve(v.app ?? join(powershell("(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"), "app", "ChatGPT.exe"));
  // Never resolve the npm SDK backend: the desktop package owns its protocol version.
  const codex = resolve(v.codex ?? join(dirname(app), "resources", "codex.exe"));
  if (!existsSync(app) || !existsSync(codex)) throw new Error("Desktop/backend not found; provide --app and --codex executable paths");
  const project = realpathSync(resolve(v.project ?? root));
  if (!statSync(project).isDirectory()) throw new Error("Project must be a directory");
  const output = join(root, ".router-memory", "desktop");
  const csc = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const running = powershell("@(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -or $_.ProcessName -eq 'ChatGPT' }).Count") !== "0";
  if (v.check) { console.log(JSON.stringify({ app, codex, compiler: existsSync(csc), running, project, router, launch: false }, null, 2)); }
  else {
    if (!v.prepare) requireDesktopStopped(running);
    mkdirSync(output, { recursive: true });
    const shim = join(output, "jev-desktop-shim.exe");
    execFileSync(csc, ["/nologo", "/target:exe", "/optimize+", "/out:" + shim, join(root, "src", "desktop-shim.cs")], { windowsHide: true, timeout: 30000, stdio: "pipe" });
    if (v.prepare) console.log(JSON.stringify({ shim, launch: false }));
    else {
      const models = Object.fromEntries(["cheap", "standard", "hard"].map((tier) => [tier, v[`model-${tier}` as keyof typeof v] ?? process.env[`ROUTER_MODEL_${tier.toUpperCase()}`]]).filter(([, value]) => value));
      const inherited = desktopLaunchEnvironment(process.env);
      const env = { ...inherited, CODEX_CLI_PATH: shim, JEV_DESKTOP_CODEX: codex, JEV_DESKTOP_NODE: process.execPath, JEV_DESKTOP_TSX: pathToFileURL(join(root, "node_modules", "tsx", "dist", "loader.mjs")).href, JEV_DESKTOP_ENTRY: join(root, "src", "desktop-entry.ts"), JEV_DESKTOP_PROJECT: project, JEV_DESKTOP_ROUTER: router, JEV_DESKTOP_MODE: v.mode!, JEV_DESKTOP_MODELS: JSON.stringify(models), JEV_DESKTOP_LOG: join(output, `routes-${Date.now()}.jsonl`), ...(v["isolated-profile"] ? { CODEX_ELECTRON_USER_DATA_PATH: resolve(v["isolated-profile"]) } : {}) };
      const child = launchDesktop({ running, app, project, env });
      child.once("error", () => { console.error("Desktop launch failed"); process.exitCode = 1; });
      child.once("spawn", () => { console.log(JSON.stringify({ launchedPid: child.pid, shim, router })); child.unref(); });
    }
  }
} catch (error) { console.error(error instanceof Error ? error.message : "Desktop preparation failed"); process.exitCode = 1; }
