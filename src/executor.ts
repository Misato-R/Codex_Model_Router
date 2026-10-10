import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExecuteResult, Route, TaskExecutor } from "./types.js";

const OUTPUT_LIMIT = 1_000_000;

function cliPath(): string {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  if (process.platform !== "win32") return "codex";
  try {
    const candidates = execFileSync("where.exe", ["codex"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const native = candidates.find((item) => /\.exe$/i.test(item) && existsSync(item));
    if (native) return native;
    const shim = candidates.find((item) => /\.cmd$/i.test(item));
    if (shim) throw new Error(`Only a .cmd Codex shim was found (${shim}). Install the native Codex CLI or set CODEX_PATH to codex.exe.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Only a .cmd")) throw error;
  }
  return "codex";
}

function collect(child: ReturnType<typeof spawn>, command: string[], input: string): Promise<ExecuteResult> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    let capped = false;
    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (output.length + stderr.length >= OUTPUT_LIMIT) {
        if (!capped) { capped = true; child.kill(); }
        return;
      }
      const value = chunk.toString("utf8");
      if (target === "stdout") output += value.slice(0, OUTPUT_LIMIT - output.length - stderr.length);
      else stderr += value.slice(0, OUTPUT_LIMIT - output.length - stderr.length);
    };
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      command,
      exitCode: code,
      output: `${output || stderr}${capped ? "\n[output limit reached; process stopped]" : ""}`,
    }));
    child.stdin?.end(input);
  });
}

export class CodexCliExecutor implements TaskExecutor {
  async execute(prompt: string, project: string, route: Route, options: { run?: boolean } = {}): Promise<ExecuteResult> {
    const args = [
      "exec", "-C", project, "-s", "workspace-write", "-m", route.model,
      "-c", `model_reasoning_effort=${JSON.stringify(route.effort)}`, "--json", "-",
    ];
    const executable = options.run ? cliPath() : process.env.CODEX_PATH ?? "codex";
    const command = [executable, ...args];
    if (!options.run) return { command, exitCode: null, output: "Dry run: no Codex process started; no model invocation." };
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return collect(child, command, prompt);
  }
}

interface SdkThreadOptions {
  model: string;
  modelReasoningEffort: Route["effort"];
  workingDirectory: string;
  sandboxMode: "read-only" | "workspace-write";
  skipGitRepoCheck: true;
}
interface SdkTurn { finalResponse: string; }
interface CodexSdkLike {
  startThread(options: SdkThreadOptions): { run(prompt: string): Promise<SdkTurn> };
}

/** Uses the official SDK when installed; SDK itself launches the Codex CLI and reuses its ChatGPT login. */
export class CodexSdkExecutor implements TaskExecutor {
  async execute(prompt: string, project: string, route: Route, options: { run?: boolean; sandboxMode?: "read-only" | "workspace-write" } = {}): Promise<ExecuteResult> {
    const command = ["@openai/codex-sdk", "startThread", route.model, project];
    if (!options.run) return { command, exitCode: null, output: "Dry run: SDK was not loaded and no model invocation occurred." };
    let imported: { Codex: new (options?: { config?: Record<string, unknown> }) => CodexSdkLike };
    try {
      const packageName = "@openai/codex-sdk";
      imported = await import(packageName) as unknown as { Codex: new (options?: { config?: Record<string, unknown> }) => CodexSdkLike };
    } catch {
      throw new Error("The optional SDK adapter requires @openai/codex-sdk. Install it in this project with `npm install @openai/codex-sdk`.");
    }
    const codex = new imported.Codex({
      // The router tool may run Codex inside this same repository. Disable its
      // MCP server for the child thread so AGENTS.md cannot recursively reroute.
      config: { mcp_servers: { jev_model_router: { enabled: false } } },
    });
    const thread = codex.startThread({
      model: route.model,
      modelReasoningEffort: route.effort,
      workingDirectory: project,
      sandboxMode: options.sandboxMode ?? "workspace-write",
      skipGitRepoCheck: true,
    });
    const turn = await thread.run(prompt);
    return { command, exitCode: 0, output: turn.finalResponse };
  }
}

/** Explicit extension point for a LangChain/LangGraph runtime adapter. */
export class RuntimeExecutor implements TaskExecutor {
  constructor(private readonly invoke: (input: { prompt: string; project: string; route: Route }) => Promise<string>) {}
  async execute(prompt: string, project: string, route: Route, options: { run?: boolean } = {}): Promise<ExecuteResult> {
    const command = ["agent-runtime", route.model, project];
    if (!options.run) return { command, exitCode: null, output: "Dry run: agent runtime was not invoked." };
    return { command, exitCode: 0, output: await this.invoke({ prompt, project, route }) };
  }
}
