import { createInterface } from "node:readline";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { AppServerClient, asError, type Notification, type ServerRequest } from "./app-server-client.js";
import { ChatSession, routingContext, type Sandbox } from "./chat-session.js";
import { ChatStore } from "./chat-store.js";
import { routeTaskWithJev } from "./jev-router.js";
import { routeTask, type RouteOptions } from "./router.js";
import { getTypesafeApiKey } from "./windows-env.js";
import type { Mode, Route, Tier } from "./types.js";

const HELP = `Jev Router Chat — 同一会话内逐轮选择模型

启动：npm run chat -- --project "C:\\你的项目"
默认：--router jev --mode balanced --sandbox read-only --session default

选项：
  --router jev|rules                Jev 在线分档，或本地规则
  --mode balanced|economy|quality   路由模式
  --sandbox read-only|workspace-write  项目读写权限
  --session NAME                   本地命名会话，重新打开时自动恢复
  --new                            为此名称开始新会话（旧历史仍保存在 Codex）
  --resume THREAD_ID               显式恢复同一项目的 Codex 会话
  --model-cheap/standard/hard NAME  覆盖对应模型，也支持 ROUTER_MODEL_* 环境变量
  --check                          只检查 ChatGPT 登录、模型目录和 Key 是否存在；不推理
  --task "问题"                    执行一轮后退出，下次仍可恢复
  --help                           显示帮助

对话命令：
  /status  /models  /mode balanced|economy|quality  /router jev|rules
  /sandbox read-only|workspace-write  /new  /cancel  /quit
  /paste   输入多行任务，以单独一行 /end 提交

Jev 会收到本轮问题和最多三条近期用户问题片段，不发送完整回答或项目源码。
此入口沿用 ChatGPT 登录；不要在输入框粘贴 API Key。`;

function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function print(value: string): void { process.stdout.write(clean(value)); }

class Terminal {
  private readonly rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  private pending?: (answer: string | null) => void;
  private queued: string[] = [];
  private busy = false;
  closed = false;
  onCancel: () => void = () => {};
  onQuit: () => void = () => {};

  constructor() {
    this.rl.on("line", (line) => {
      if (line === "/cancel" || line === "/quit" || line === "/exit") {
        if (line === "/cancel") this.onCancel();
        else this.onQuit();
        this.cancelPrompt();
      } else if (this.pending) {
        const resolve = this.pending; this.pending = undefined; resolve(line);
      } else if (!this.busy) this.queued.push(line);
      else print("\n当前任务进行中。输入 /cancel 取消，或 /quit 退出。\n");
    });
    this.rl.on("SIGINT", () => { this.onCancel(); this.cancelPrompt(); });
    this.rl.on("close", () => { this.closed = true; this.onQuit(); this.cancelPrompt(); });
  }
  ask(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.pending) return Promise.reject(new Error("已有输入请求等待处理。"));
    print(prompt);
    if (this.queued.length) return Promise.resolve(this.queued.shift()!);
    return new Promise((resolve) => { this.pending = resolve; });
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
    // Pasted-ahead lines must never become answers to later approval prompts.
    if (busy && this.queued.length) { this.queued = []; print("\n多余输入已丢弃；粘贴多行任务请先输入 /paste。\n"); }
  }
  cancelPrompt(): void { this.queued = []; const pending = this.pending; this.pending = undefined; pending?.(null); }
  close(): void { this.rl.close(); }
}

async function handleServerRequest(request: ServerRequest, terminal?: Terminal): Promise<unknown> {
  const params = request.params;
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
    print(`\n[需要确认] ${request.method.includes("commandExecution") ? "执行命令" : "修改文件"}\n`);
    for (const field of ["command", "cwd", "reason", "grantRoot", "networkApprovalContext"]) {
      if (params[field] != null) print(`${field}: ${typeof params[field] === "string" ? params[field] : JSON.stringify(params[field])}\n`);
    }
    const answer = terminal ? await terminal.ask("仅批准本次？输入 y 批准，其余拒绝：") : null;
    const accepted = answer?.trim().toLowerCase() === "y";
    // Never create a persistent rule or approve an entire session.
    const available = params.availableDecisions;
    if (accepted && Array.isArray(available) && !available.includes("accept")) {
      print("此请求未提供单次批准选项，已取消。\n");
      return { decision: "cancel" };
    }
    return { decision: accepted ? "accept" : "decline" };
  }
  if (request.method === "item/tool/requestUserInput") {
    const answers: Record<string, { answers: string[] }> = {};
    const questions = params.questions as { id: string; question: string; isSecret?: boolean; options?: { label: string; description: string }[] }[];
    for (const question of questions) {
      if (question.isSecret) throw new Error("此终端入口不接收密钥，请在环境中配置认证。");
      print(`\n${question.question}\n`);
      for (const option of question.options ?? []) print(`- ${option.label}: ${option.description}\n`);
      const answer = terminal ? await terminal.ask("回答：") : null;
      answers[question.id] = { answers: answer ? [answer] : [] };
    }
    return { answers };
  }
  if (request.method === "item/permissions/requestApproval") {
    print("\n[权限] 额外权限请求已拒绝；请使用受支持的项目沙箱设置。\n");
    return { permissions: {}, scope: "turn" };
  }
  if (request.method === "mcpServer/elicitation/request") return { action: "decline" };
  throw new Error(`此入口尚不支持服务端请求 ${request.method}，已拒绝而非自动批准。`);
}

function eventPrinter(): { receive(event: Notification): void; finish(): void } {
  const printed = new Set<string>();
  let currentItem = "";
  let usage: { last?: Record<string, number>; total?: Record<string, number> } | undefined;
  let lastOutput = Date.now();
  const started = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastOutput > 25_000) print(`\n[等待] Codex 仍在执行，已用 ${Math.round((Date.now() - started) / 1000)} 秒；/cancel 可取消。\n`);
  }, 30_000);
  return {
    receive(event) {
      const p = event.params;
      if (event.method === "item/agentMessage/delta") {
        const id = String(p.itemId);
        if (currentItem !== id) { print("\n"); currentItem = id; }
        printed.add(id);
        print(String(p.delta ?? ""));
        lastOutput = Date.now();
      } else if (event.method === "item/completed") {
        const item = p.item as { id: string; type: string; text?: string; status?: string };
        if (item.type === "agentMessage" && !printed.has(item.id)) print(`\n${item.text ?? ""}`);
        else if (item.type === "commandExecution" || item.type === "fileChange") print(`\n[${item.type === "fileChange" ? "文件修改" : "命令"}] ${item.status ?? "完成"}\n`);
      } else if (event.method === "item/started") {
        const item = p.item as { type: string; command?: string; changes?: { path: string; diff?: string }[] };
        if (item.type === "commandExecution") print(`\n[执行] ${item.command ?? "命令"}\n`);
        if (item.type === "fileChange") {
          print("\n[修改文件]\n");
          for (const change of item.changes ?? []) print(`${change.path}\n${(change.diff ?? "").slice(0, 12000)}\n`);
        }
      } else if (event.method === "thread/tokenUsage/updated") {
        usage = p.tokenUsage as typeof usage;
      } else if (event.method === "model/rerouted") {
        print(`\n[服务端模型调整] ${p.fromModel} → ${p.toModel}: ${p.reason}\n`);
      } else if (event.method === "error") {
        const error = p.error as { message?: string } | undefined;
        print(`\n[Codex] ${error?.message ?? "执行错误"}${p.willRetry ? "（服务端将重试）" : ""}\n`);
      }
    },
    finish() {
      clearInterval(heartbeat);
      print("\n");
      if (usage?.total) print(`[会话累计 Token] 输入 ${usage.total.inputTokens}，缓存输入 ${usage.total.cachedInputTokens}，输出 ${usage.total.outputTokens}，推理输出 ${usage.total.reasoningOutputTokens}（用量分类可能重叠，不等于额度百分比）\n`);
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    project: { type: "string" }, router: { type: "string", default: "jev" }, mode: { type: "string", default: "balanced" },
    sandbox: { type: "string", default: "read-only" }, session: { type: "string", default: "default" },
    new: { type: "boolean" }, resume: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean" }, task: { type: "string" },
    "model-cheap": { type: "string" }, "model-standard": { type: "string" }, "model-hard": { type: "string" },
  } });
  if (values.help) { print(`${HELP}\n`); return; }
  if (values.new && values.resume) throw new Error("--new 和 --resume 不能同时使用。");
  if (values.check && values.task) throw new Error("--check 不执行任务，不能和 --task 同时使用。");
  if (values.task !== undefined && !values.task.trim()) throw new Error("--task 不能为空。");
  let mode = values.mode as Mode;
  let routing = values.router;
  const sandbox = values.sandbox as Sandbox;
  if (!["balanced", "economy", "quality"].includes(mode)) throw new Error("无效 --mode。");
  if (!["jev", "rules"].includes(routing)) throw new Error("无效 --router。");
  if (!["read-only", "workspace-write"].includes(sandbox)) throw new Error("无效 --sandbox。");
  const project = await realpath(resolve(values.project ?? process.cwd()));
  if (!(await stat(project)).isDirectory()) throw new Error("--project 必须是目录。");
  const options: RouteOptions = { models: {} };
  for (const tier of ["cheap", "standard", "hard"] as Tier[]) {
    const model = values[`model-${tier}`] ?? process.env[`ROUTER_MODEL_${tier.toUpperCase()}`];
    if (model) options.models![tier] = model;
  }
  const interactive = !values.check && values.task === undefined;
  if (interactive && !process.stdin.isTTY) throw new Error("交互模式需要终端；脚本调用请使用 --task 或 --check。");
  const store = new ChatStore(project, values.session);
  let client: AppServerClient | undefined;
  let terminal: Terminal | undefined;
  let session: ChatSession | undefined;
  let quitting = false;
  let busy = false;
  let controller: AbortController | undefined;
  let requestQueue: Promise<unknown> = Promise.resolve();
  const cancel = () => {
    if (!busy) { quitting = true; terminal?.cancelPrompt(); return; }
    print("\n[取消] 正在停止本轮任务…\n");
    controller?.abort();
    terminal?.cancelPrompt();
    const cancelledController = controller;
    void session?.interrupt().catch((error: unknown) => {
      // Session owns cancellation cleanup and connection invalidation. A late
      // callback from a previous task must never close the shared connection.
      if (busy && controller === cancelledController) print(`[取消未完成] ${asError(error).message}\n`);
    });
  };
  const signal = () => cancel();
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  try {
    await store.acquire();
    const state = await store.read();
    if (values.new) { state.threadId = null; state.recentTasks = []; }
    if (values.resume) { state.threadId = values.resume; state.recentTasks = []; }
    if (interactive) {
      terminal = new Terminal();
      terminal.onCancel = cancel;
      terminal.onQuit = () => { quitting = true; cancel(); };
    }
    client = AppServerClient.launch(project, (request) => {
      const answer = requestQueue.then(() => handleServerRequest(request, terminal));
      requestQueue = answer.catch(() => {});
      return answer;
    });
    client.onFailure((error) => { if (!quitting) print(`\n[连接] ${error.message}\n`); quitting = true; terminal?.cancelPrompt(); });
    await client.initialize();
    session = new ChatSession(client, state, sandbox, (updated) => store.save(updated));
    const models = await session.prepare();
    if (values.check) {
      print(`ChatGPT 登录：已确认\n项目：${project}\nJev Key：${getTypesafeApiKey() ? "已配置" : "未配置"}\n`);
      for (const tier of ["cheap", "standard", "hard"] as Tier[]) {
        const { routeFromTier } = await import("./router.js");
        const route = routeFromTier(tier, "balanced", options);
        session.validateRoute(route);
        print(`${tier}: ${route.model} / ${route.effort} 可用\n`);
      }
      print("检查完成，未调用 Jev 分类或 Codex 推理。\n");
      return;
    }
    if (routing === "jev" && !getTypesafeApiKey()) throw new Error("未找到 TYPESAFE_API_KEY，请配置后重新启动，或显式使用 --router rules。");
    await session.resume();
    // Persist explicit --new/--resume even before the first task.
    await store.save(state);
    print(`\nJev Router Chat\n项目：${project}\n会话：${state.threadId ?? "首轮提交时创建"}（名称 ${values.session}）\n模式：${mode}；路由：${routing}；权限：${sandbox}\n`);
    print("当前入口直接执行任务，持续保留本会话历史。Jev 接收本轮问题及最多三条近期问题片段。\n");
    if (interactive) print("输入 /help 查看命令；/paste 输入多行；Ctrl+C 或 /cancel 取消运行中的任务。\n");
    do {
      let task = values.task ?? await terminal!.ask("\n你 > ");
      if (task === null || quitting) break;
      task = task.trim();
      if (!task) continue;
      if (interactive && task.startsWith("/")) {
        const [command, arg] = task.split(/\s+/);
        if (command === "/help") print(`${HELP}\n`);
        else if (command === "/status") print(`会话 ${state.threadId ?? "尚未创建"}\n项目 ${project}\n${routing} / ${mode} / ${session.sandbox}\n`);
        else if (command === "/models") for (const model of models) print(`${model.model}: ${model.supportedReasoningEfforts.map((item) => item.reasoningEffort).join(", ")}\n`);
        else if (command === "/mode" && ["balanced", "economy", "quality"].includes(arg)) { mode = arg as Mode; print(`模式：${mode}\n`); }
        else if (command === "/router" && ["jev", "rules"].includes(arg)) { routing = arg; print(`路由：${routing}\n`); }
        else if (command === "/sandbox" && ["read-only", "workspace-write"].includes(arg)) { session.sandbox = arg as Sandbox; print(`后续任务权限：${arg}\n`); }
        else if (command === "/new") { print(`原会话：${state.threadId ?? "无"}\n`); await session.newConversation(); print("下一条问题会创建新会话。\n"); }
        else if (command === "/paste") {
          const lines: string[] = [];
          print("输入多行内容，单独一行 /end 提交：\n");
          while (!quitting) { const line = await terminal!.ask(""); if (line === null) { lines.length = 0; break; } if (line === "/end") break; lines.push(line); }
          task = lines.join("\n").trim();
          if (!task || quitting) continue;
        } else print("无效命令或参数，请输入 /help。\n");
        if (command !== "/paste") continue;
      }
      busy = true;
      terminal?.setBusy(true);
      controller = new AbortController();
      try {
        print(`[分档] ${routing === "jev" ? "正在请求 Jev" : "使用本地规则"}…\n`);
        const route: Route = routing === "jev"
          ? await routeTaskWithJev(task, mode, { ...options, context: routingContext(state), signal: controller.signal })
          : routeTask(task, mode, options);
        if (controller.signal.aborted) continue;
        print(`[路由] ${route.tier} → ${route.model} / ${route.effort}；模式 ${mode}；来源 ${route.source}${route.confidence === undefined ? "" : `；置信度 ${Math.round(route.confidence * 100)}%`}\n[判断依据] ${route.reason}（最终档位已应用模式约束）\n`);
        const printer = eventPrinter();
        try {
          const turn = await session.run(task, route, printer.receive);
          print(`\n[本轮 ${turn.status}] 会话 ${state.threadId}${turn.error ? `\n${turn.error.message}` : ""}\n`);
          if (turn.status === "failed") process.exitCode = 1;
          if (turn.status === "interrupted" && values.task !== undefined) process.exitCode = 130;
        } finally { printer.finish(); }
      } catch (error) {
        const cancelled = controller.signal.aborted && asError(error).name === "AbortError";
        print(`\n[${cancelled ? "已取消" : "失败"}] ${asError(error).message}\n`);
        if (values.task !== undefined) process.exitCode = 1;
      } finally { busy = false; terminal?.setBusy(false); controller = undefined; }
    } while (interactive && !quitting);
  } finally {
    quitting = true;
    terminal?.close();
    await client?.close();
    await store.release();
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  }
}

void main().catch((error: unknown) => { print(`\n[错误] ${asError(error).message}\n`); process.exitCode = 1; });
