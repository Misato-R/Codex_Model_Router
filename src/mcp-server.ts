import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { routeTaskWithJev } from "./jev-router.js";
import { CodexSdkExecutor } from "./executor.js";
import type { Mode } from "./types.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const modes: Mode[] = ["balanced", "economy", "quality"];
const tiersDescription = "Jev selects cheap, standard, or hard, then the router maps that tier to a Codex model and reasoning effort.";

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function routeAndExecute(args: Record<string, unknown>) {
  const task = args.task;
  const project = args.project;
  const mode = args.mode ?? "balanced";
  const sandboxMode = args.sandboxMode ?? "read-only";
  if (typeof task !== "string" || !task.trim()) throw new Error("task must be a non-empty string.");
  if (typeof project !== "string" || !isAbsolute(project)) throw new Error("project must be an absolute project directory path.");
  if (mode !== "balanced" && mode !== "economy" && mode !== "quality") throw new Error("mode must be balanced, economy, or quality.");
  if (sandboxMode !== "read-only" && sandboxMode !== "workspace-write") throw new Error("sandboxMode must be read-only or workspace-write.");

  const projectPath = resolve(project);
  await access(projectPath);
  const route = await routeTaskWithJev(task, mode, {});
  const childPrompt = `You are executing a task delegated by the Jev Model Router. Do not try to route this task again. Complete it directly in the selected project.\n\nUser task:\n${task}`;
  const result = await new CodexSdkExecutor().execute(childPrompt, projectPath, route, {
    run: true,
    sandboxMode,
  });
  return {
    project: projectPath,
    mode,
    router: "jev",
    route,
    adapter: "sdk",
    sandboxMode,
    exitCode: result.exitCode,
    output: result.output.slice(0, 20_000),
  };
}

const tools = [{
  name: "jev_route_and_run",
  title: "Route a task through Jev and run it with Codex",
  description: `Use when the user wants a task evaluated by Jev and then executed by the selected Codex model. ${tiersDescription} Calls TypeSafe Jev and Codex. The task text is sent to TypeSafe. Requires TYPESAFE_API_KEY. Default sandboxMode is read-only; use workspace-write only when the user requests file changes.`,
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "The complete task to send to Jev and Codex." },
      project: { type: "string", description: "Absolute path to the project directory Codex should work in." },
      mode: { type: "string", enum: modes, description: "Routing mode; defaults to balanced." },
      sandboxMode: { type: "string", enum: ["read-only", "workspace-write"], description: "Defaults to read-only; choose workspace-write only when changes are requested." },
    },
    required: ["task", "project"],
    additionalProperties: false,
  },
}];

async function handle(request: JsonRpcRequest): Promise<void> {
  const id = request.id;
  const method = request.method;
  if (typeof method !== "string") {
    if (id !== undefined) rpcError(id, -32600, "Invalid request: missing method.");
    return;
  }
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-model-router", version: "0.2.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const params = request.params ?? {};
    if (params.name !== "jev_route_and_run") {
      rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      return;
    }
    try {
      const args = typeof params.arguments === "object" && params.arguments !== null
        ? params.arguments as Record<string, unknown>
        : {};
      const result = await routeAndExecute(args);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ jsonrpc: "2.0", id, result: toolError(message) });
    }
    return;
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    rpcError(null, -32700, "Parse error: expected one JSON-RPC message per line.");
    return;
  }
  void handle(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (request.id !== undefined) rpcError(request.id, -32603, message);
    else process.stderr.write(`${message}\n`);
  });
});
