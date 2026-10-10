import { resolve } from "node:path";
import { asError, type Notification, type RpcConnection, type RpcParams } from "./app-server-client.js";
import type { Route } from "./types.js";

export type Sandbox = "read-only" | "workspace-write";
export interface ModelInfo { model: string; supportedReasoningEfforts: { reasoningEffort: string }[]; }
export interface ChatState { version: 1; project: string; threadId: string | null; recentTasks: string[]; }
export interface TurnResult { id: string; status: string; error?: { message: string } | null; }

// This deadline applies only to cancellation, never to normal model execution.
const CANCEL_SETTLE_MS = 30_000;
interface ActiveTurn {
  id?: string;
  threadId?: string;
  cancel: boolean;
  terminal?: TurnResult;
  failure?: Error;
  interruptRequest?: Promise<void>;
  interruptAcknowledged?: boolean;
  cancelPromise?: Promise<void>;
  finished: Promise<void>;
  failed: Promise<never>;
  rejectTurn(error: Error): void;
  cancelTimer?: NodeJS.Timeout;
}

const DIRECT_INSTRUCTIONS = "This thread is managed by the Jev Router input client. Model selection has already happened before each turn. Complete the user's task directly in this thread. Do not call jev_route_and_run, do not invoke the model router through shell commands, and do not delegate the task to another Codex SDK/CLI session. Preserve the existing conversation context. These instructions override repository instructions that ask for rerouting.";

export class ChatSession {
  private active?: ActiveTurn;
  private failure?: Error;
  private models: ModelInfo[] = [];
  private loaded = false;

  constructor(
    private readonly rpc: RpcConnection,
    readonly state: ChatState,
    public sandbox: Sandbox,
    private readonly persist: (state: ChatState) => Promise<void>,
  ) {}

  async prepare(): Promise<ModelInfo[]> {
    const account = await this.rpc.request<{ account: { type: string } | null }>("account/read", { refreshToken: false });
    if (account.account?.type !== "chatgpt") {
      throw new Error("此入口需要已有的 ChatGPT 登录。请先在普通终端运行 codex login，然后重新启动；不会自动切换为 API Key 计费。");
    }
    let cursor: string | null = null;
    const seen = new Set<string>();
    this.models = [];
    do {
      const page: { data: ModelInfo[]; nextCursor: string | null } = await this.rpc.request("model/list", { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
      this.models.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("model/list 返回重复分页游标。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return this.models;
  }

  validateRoute(route: Route): void {
    const model = this.models.find((entry) => entry.model === route.model);
    if (!model) throw new Error(`当前 Codex 模型目录中没有 ${route.model}。用 /models 查看可用模型，并用 --model-${route.tier} 设置映射。`);
    if (!model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === route.effort)) {
      throw new Error(`${route.model} 不支持 ${route.effort} 推理强度；没有自动替换模型。`);
    }
  }

  private threadSettings(): RpcParams {
    return {
      cwd: this.state.project, modelProvider: "openai", sandbox: this.sandbox,
      approvalPolicy: "on-request", approvalsReviewer: "user",
      developerInstructions: DIRECT_INSTRUCTIONS,
      config: { "mcp_servers.jev_model_router.enabled": false },
    };
  }

  async resume(): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.state.threadId || this.loaded) return;
    const read = await this.rpc.request<{ thread: { cwd: string; status?: { type: string } } }>("thread/read", { threadId: this.state.threadId, includeTurns: false });
    if (!sameProject(read.thread.cwd, this.state.project)) throw new Error("会话属于不同项目；请使用原项目路径恢复，或用 --new 创建新会话。");
    if (read.thread.status?.type === "active") throw new Error("此会话仍在运行；请先在原入口结束当前任务，再恢复。");
    const result = await this.rpc.request<{ thread: { id: string; status?: { type: string } } }>("thread/resume", { threadId: this.state.threadId, ...this.threadSettings() });
    if (result.thread.id !== this.state.threadId) throw new Error("App Server 恢复了意外的会话 ID。");
    if (result.thread.status?.type === "active") throw new Error("恢复的会话仍有活动任务，不能提交新一轮。");
    this.loaded = true;
  }

  async newConversation(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.active) throw new Error("请先等待或取消当前任务。");
    this.state.threadId = null;
    this.state.recentTasks = [];
    this.loaded = false;
    await this.persist(this.state);
  }

  async run(task: string, route: Route, onEvent: (event: Notification) => void): Promise<TurnResult> {
    if (this.failure) throw this.failure;
    if (this.active) throw new Error("同一会话不能同时提交两轮任务。");
    this.validateRoute(route);
    let resolveTurn!: (turn: TurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<TurnResult>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    let rejectFailure!: (error: Error) => void;
    const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
    let finish!: () => void;
    let rejectFinished!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; rejectFinished = reject; });
    // These promises can reject before their consumers begin awaiting them.
    void completion.catch(() => {});
    void failed.catch(() => {});
    void finished.catch(() => {});
    const active: ActiveTurn = { cancel: false, finished, failed, rejectTurn: (error) => { rejectTurn(error); rejectFailure(error); } };
    this.active = active;
    let startSubmitted = false;
    let stopEvents = () => {};
    const stopFailure = this.rpc.onFailure((error) => this.unconfirmed(active, error));
    let outcome: TurnResult | undefined;
    let failure: Error | undefined;
    try {
      if (this.state.threadId) await this.resume();
      else {
        const result = await this.rpc.request<{ thread: { id: string } }>("thread/start", { ...this.threadSettings(), model: route.model });
        this.state.threadId = result.thread.id;
        this.loaded = true;
        // Persist before inference: a disconnect must not lose the history pointer.
        await Promise.race([this.persist(this.state), active.failed]);
      }
      if (active.cancel) {
        outcome = { id: "", status: "interrupted" };
      } else {
        active.threadId = this.state.threadId!;
        const buffered: Notification[] = [];
        const accept = (event: Notification) => {
          const params = event.params;
          if (active.failure || params.threadId !== active.threadId) return;
          const turn = params.turn as TurnResult | undefined;
          const turnId = typeof params.turnId === "string" ? params.turnId : turn?.id;
          // Genuine thread events have no turn owner. Usage updates are turn-scoped
          // despite their thread/ prefix; an unowned turn/item event is unsafe.
          if (!turnId && event.method.startsWith("thread/") && event.method !== "thread/tokenUsage/updated") {
            onEvent(event);
            return;
          }
          if (!turnId) return;
          if (!active.id) { buffered.push(event); return; }
          if (turnId !== active.id || active.terminal) return;
          if (event.method === "turn/completed") {
            if (!turn || turn.id !== active.id || turn.status === "inProgress") return;
            active.terminal = turn;
            resolveTurn(turn);
          }
          onEvent(event);
        };
        stopEvents = this.rpc.onNotification(accept);
        startSubmitted = true;
        const result = await this.rpc.request<{ turn: TurnResult }>("turn/start", {
          threadId: active.threadId,
          input: [{ type: "text", text: task, text_elements: [] }],
          model: route.model, effort: route.effort,
          cwd: this.state.project, approvalPolicy: "on-request", approvalsReviewer: "user",
          sandboxPolicy: this.sandbox === "read-only" ? { type: "readOnly" } : {
            type: "workspaceWrite", writableRoots: [this.state.project], networkAccess: false,
          },
        });
        if (!result.turn.id) throw new Error("App Server 未返回有效轮次 ID。");
        // Only the response may establish ownership. Replay includes an early
        // completed notification, so completion before acknowledgement is safe.
        active.id = result.turn.id;
        for (const event of buffered) accept(event);
        buffered.length = 0;
        if (!active.terminal && result.turn.status !== "inProgress") {
          active.terminal = result.turn;
          resolveTurn(result.turn);
        }
        if (active.cancel) this.sendInterrupt(active);
        this.state.recentTasks = [...this.state.recentTasks, task.slice(0, 500)].slice(-3);
        await Promise.race([this.persist(this.state), active.failed]);
        outcome = await completion;
      }
    } catch (error) {
      failure = asError(error);
      // Keep listeners and the active slot until local failures also have a
      // confirmed terminal outcome, or the connection has been invalidated.
      if (startSubmitted && !active.terminal && !active.failure) {
        if (!active.id) this.unconfirmed(active, failure);
        else {
          void this.interrupt().catch(() => {});
          try { await completion; } catch { /* active.failure holds the cause */ }
        }
      }
    } finally {
      // A completed notification can precede the interrupt response. Do not let
      // the next turn start while that request can still fail.
      try { await active.interruptRequest; } catch (error) { failure = asError(error); }
      failure = active.failure ?? failure;
      clearTimeout(active.cancelTimer);
      stopEvents();
      stopFailure();
      if (this.active === active) this.active = undefined;
      if (failure) rejectFinished(failure);
      else finish();
    }
    if (failure) throw failure;
    return outcome!;
  }

  interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return Promise.resolve();
    active.cancel = true;
    // Repeated cancellation, including before turn/start responds, shares the
    // same promise for acknowledgement AND terminal cleanup.
    active.cancelPromise ??= active.finished;
    this.sendInterrupt(active);
    return active.cancelPromise;
  }

  private sendInterrupt(active: ActiveTurn): void {
    if (!active.id || active.terminal || active.failure || active.interruptRequest) return;
    active.cancelTimer = setTimeout(() => {
      if (active.terminal && active.interruptAcknowledged) return;
      this.unconfirmed(active, new Error(`取消后 ${CANCEL_SETTLE_MS / 1000} 秒内未完成确认和收尾`));
    }, CANCEL_SETTLE_MS);
    active.interruptRequest = Promise.race([
      this.rpc.request("turn/interrupt", { threadId: active.threadId, turnId: active.id }),
      active.failed,
    ]).then(
      () => { active.interruptAcknowledged = true; },
      (error: unknown) => { this.unconfirmed(active, asError(error)); throw active.failure; },
    );
    void active.interruptRequest.catch(() => {});
  }

  private unconfirmed(active: ActiveTurn, cause: Error): void {
    if (active.failure) return;
    const error = new Error(`[状态未确认] ${cause.message}；连接不可继续使用，请退出后恢复会话。`);
    active.failure = error;
    this.failure = error;
    active.rejectTurn(error);
    this.rpc.invalidate?.(error);
  }
}

export function sameProject(left: string, right: string): boolean {
  const normalize = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

export function routingContext(state: ChatState): string | undefined {
  return state.recentTasks.length ? state.recentTasks.map((task, i) => `Earlier user request ${i + 1}: ${task.slice(0, 500)}`).join("\n") : undefined;
}
