import type { Route } from "./types.js";
import type { ModelInfo } from "./chat-session.js";

// Deliberately transport independent: no terminal rendering and no synthetic model events.
export type Message = { id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: any; [key: string]: any };
type Id = string | number;
type Pending = { original?: Id; method: string; params: Record<string, any>; managed?: boolean; resolve?: (value: any) => void; reject?: (error: Error) => void; timer?: NodeJS.Timeout };
type Turn = { phase: "routing" | "starting" | "active"; controller: AbortController; id?: string };
// Native CLI and desktop use different labels for a new user submission.
// Keep automation, retries and tool continuations on their existing settings.
const USER_TURN_TRIGGERS = new Set([
  "user", "composer", "composer_queue", "composer_queue_run_now",
  "page_composer", "edit_user_message", "chatgpt_handoff",
]);
export const ROUTED_INSTRUCTIONS = "This thread is managed by the Jev CLI proxy. Routing has already been handled before each new user turn (or explicitly disabled in manual mode). Execute the task directly in this same thread. Do not call jev_route_and_run, invoke the router through shell commands, or delegate to a separate Codex SDK/CLI session. Preserve conversation context. This overrides repository instructions requesting rerouting.";

export interface ProxyOptions {
  project: string;
  manual?: boolean;
  controlTimeoutMs?: number;
  classificationTimeoutMs?: number;
  manageThread?(params: Record<string, any>): boolean;
  route(task: string, context: string, signal: AbortSignal): Promise<Route>;
  toBackend(message: Message): void;
  toClient(message: Message): void;
  fatal(): void;
  metadata?(entry: Record<string, unknown>): void;
}

export class CliProxy {
  private sequence = 0;
  private pending = new Map<Id, Pending>();
  private clientIds = new Set<Id>();
  private serverIds = new Map<Id, Id>();
  private serverReverse = new Map<Id, Id>();
  private turns = new Map<string, Turn>();
  private completed = new Set<string>();
  private recent = new Map<string, string[]>();
  private submitted = new Set<Id>();
  private initialized = false;
  private closed = false;
  private models: ModelInfo[] = [];
  private managed = new Set<string>();
  private prepared?: Promise<void>;

  constructor(private readonly options: ProxyOptions) {}

  client(message: Message): void {
    if (this.closed) return;
    if (!message.method) {
      const id = this.serverIds.get(message.id!);
      if (id !== undefined) {
        this.serverIds.delete(message.id!);
        this.options.toBackend({ ...message, id });
      }
      return;
    }
    if (message.id === undefined) {
      this.options.toBackend(message);
      if (message.method === "initialized") this.initialized = true;
      return;
    }
    if (this.clientIds.has(message.id)) { this.options.toClient({ id: message.id, error: { code: -32000, message: "Duplicate in-flight request id" } }); return; }
    this.clientIds.add(message.id);
    // Never await this on the transport receive loop: approvals and interrupts stay live.
    void this.dispatch(message).catch(() => this.error(message.id!, "Proxy preflight or routing failed; no new turn was submitted. Check login, model mapping and Jev availability."));
  }

  private async dispatch(message: Message): Promise<void> {
    const p = message.params ?? {};
    const thread = String(p.threadId ?? "");
    const active = this.turns.get(thread);
    if (message.method === "turn/interrupt" && active?.phase === "routing") {
      active.controller.abort();
      this.turns.delete(thread);
      this.reply(message.id!, {}); // Cancels only the proxy's not-yet-submitted work.
      return;
    }
    if (message.method === "turn/steer" && active && active.phase !== "active") {
      this.error(message.id!, "Turn is not acknowledged yet; wait before steering."); return;
    }
    if (["thread/start", "thread/resume", "thread/fork"].includes(message.method!)) {
      let scope = p;
      if (this.options.manageThread && !p.cwd && p.threadId && !p.remote && !p.remoteUrl) {
        const read = await this.internal("thread/read", { threadId: p.threadId, includeTurns: false });
        scope = { ...p, cwd: read.thread?.cwd };
      }
      if (this.options.manageThread && !this.options.manageThread(scope)) { this.forward(message, false); return; }
      await this.prepare();
      const config = await this.internal("config/read", { cwd: scope.cwd ?? this.options.project, includeLayers: false });
      const existing = p.developerInstructions ?? p.config?.developer_instructions ?? config.config?.developer_instructions ?? "";
      this.forward({ ...message, params: { ...p,
        developerInstructions: [existing, ROUTED_INSTRUCTIONS].filter(Boolean).join("\n\n"),
        config: { ...p.config, "mcp_servers.jev_model_router.enabled": false },
      } }, true);
      return;
    }
    if (message.method !== "turn/start") { this.forward(message); return; }
    if (this.options.manageThread && !this.managed.has(thread)) {
      this.options.metadata?.({ event: "turn-bypassed", threadId: thread, reason: "unmanaged-thread" });
      this.forward(message); return;
    }
    if (this.submitted.has(message.id!)) { this.error(message.id!, "Repeated turn/start id; not retried."); return; }
    this.submitted.add(message.id!);
    if (active && active.phase !== "active") { this.error(message.id!, "Another turn submission is pending for this thread."); return; }
    // Native turn/start can append to an active turn. Preserve it just like turn/steer.
    if (active || p.toolOutput || (p.turnTrigger && !USER_TURN_TRIGGERS.has(p.turnTrigger))) {
      this.options.metadata?.({ event: "turn-bypassed", threadId: thread,
        reason: active ? "active-turn" : p.toolOutput ? "tool-output" : "non-user-trigger" });
      this.forward(message); return;
    }
    const state: Turn = { phase: "routing", controller: new AbortController() };
    this.turns.set(thread, state);
    const task = (Array.isArray(p.input) ? p.input : []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(this.options.classificationTimeoutMs ?? 25_000)]);
    try {
      await this.abortable(this.prepare(), signal);
      await this.abortable(this.checkAccount(), signal);
      let params = p;
      if (!this.options.manual) {
        const context = (this.recent.get(thread) ?? []).map((text, i) => `${i + 1}. ${text}`).join("\n");
        const route = await this.abortable(this.options.route(task || "[Non-text user input]", context, signal), signal);
        const model = this.models.find((entry) => entry.model === route.model);
        if (!model?.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === route.effort)) throw new Error("Unavailable model/effort");
        params = { ...p, model: route.model, effort: route.effort };
        // The native TUI sends this experimental mask; it takes precedence over
        // top-level settings. Preserve Plan/Default and its developer instructions.
        if (p.collaborationMode?.settings) params.collaborationMode = {
          ...p.collaborationMode, settings: { ...p.collaborationMode.settings, model: route.model, reasoning_effort: route.effort },
        };
        this.options.metadata?.({ event: "route-selected", threadId: thread, model: route.model, effort: route.effort, tier: route.tier, source: route.source });
      }
      signal.throwIfAborted();
      if (this.closed || this.turns.get(thread) !== state) return;
      state.phase = "starting";
      this.forward({ ...message, params });
      if (task) this.recent.set(thread, [...(this.recent.get(thread) ?? []), task.slice(0, 500)].slice(-3));
    } catch {
      if (this.turns.get(thread) === state) this.turns.delete(thread);
      this.error(message.id!, signal.aborted ? "Turn cancelled or classification timed out; not submitted." : "Routing/preflight failed; turn not submitted. Check ChatGPT login, model mapping and Jev availability.");
    }
  }

  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Cancelled"));
      if (signal.aborted) { void promise.catch(() => {}); reject(new Error("Cancelled")); return; }
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async checkAccount(): Promise<void> {
    const result = await this.internal("account/read", { refreshToken: false });
    if (result.account?.type !== "chatgpt") throw new Error("ChatGPT login required");
  }
  private prepare(): Promise<void> {
    if (!this.initialized) return Promise.reject(new Error("Initialize first"));
    if (this.prepared) return this.prepared;
    const pending = (async () => {
      await this.checkAccount();
      this.models = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.internal("model/list", { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
        this.models.push(...page.data);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated model cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    })();
    this.prepared = pending;
    // A native /login or a repaired connection setting can make preflight valid later.
    void pending.catch(() => { if (this.prepared === pending) this.prepared = undefined; });
    return pending;
  }
  private internal(method: string, params: Record<string, any>): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Disconnected"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Control timeout")); }, this.options.controlTimeoutMs ?? 30_000);
      this.pending.set(id, { method, params, resolve, reject, timer });
      this.options.toBackend({ id, method, params });
    });
  }
  private forward(message: Message, managed?: boolean): void {
    if (this.closed) return;
    const id = ++this.sequence;
    const pending: Pending = { original: message.id, method: message.method!, params: message.params ?? {}, managed };
    // This is only an acknowledgement deadline, never a reasoning deadline.
    if (message.method === "turn/start") pending.timer = setTimeout(() => {
      this.error(message.id!, "turn/start acknowledgement timed out; outcome unknown. Reconnect and inspect history; do not retry automatically.");
      this.close(); this.options.fatal();
    }, this.options.controlTimeoutMs ?? 30_000);
    this.pending.set(id, pending);
    this.options.toBackend({ ...message, id });
  }

  backend(message: Message): void {
    if (this.closed) return;
    if (message.method && message.id !== undefined) {
      const id = `proxy-server-${++this.sequence}`;
      this.serverIds.set(id, message.id);
      this.serverReverse.set(message.id, id);
      this.options.toClient({ ...message, id }); return;
    }
    if (message.method) {
      const p = message.params ?? {};
      const state = this.turns.get(p.threadId);
      const turnId = p.turn?.id;
      if (message.method === "thread/settings/updated" && p.threadSettings) {
        this.options.metadata?.({ event: "backend-settings", threadId: p.threadId,
          model: p.threadSettings.model, effort: p.threadSettings.effort });
      }
      if (message.method === "turn/completed" && turnId) {
        this.options.metadata?.({ event: "turn-completed", threadId: p.threadId, turnId, status: p.turn.status });
        this.completed.add(`${p.threadId}:${turnId}`);
        if (this.completed.size > 1024) this.completed.delete(this.completed.values().next().value!);
        if (state?.id === turnId || (state?.phase === "active" && !state.id)) this.turns.delete(p.threadId);
      }
      if (message.method === "turn/started" && turnId && !state && !this.completed.has(`${p.threadId}:${turnId}`)) {
        this.turns.set(p.threadId, { phase: "active", id: turnId, controller: new AbortController() });
      }
      if (message.method === "serverRequest/resolved") {
        const id = this.serverReverse.get(p.requestId);
        if (id !== undefined) {
          this.serverReverse.delete(p.requestId); this.serverIds.delete(id);
          message = { ...message, params: { ...p, requestId: id } };
        }
      }
      this.options.toClient(message); return;
    }
    const pending = this.pending.get(message.id!);
    if (!pending) return;
    this.pending.delete(message.id!); clearTimeout(pending.timer);
    if (pending.original === undefined) {
      if (message.error) pending.reject!(new Error("Backend control request failed"));
      else pending.resolve!(message.result);
      return;
    }
    // The installed desktop proceeds after the initialize response without an
    // initialized notification. Observe the backend's acknowledgement before
    // forwarding it, so a following resume can pass preflight in either client.
    if (pending.method === "initialize" && !message.error && message.result != null) {
      this.initialized = true;
      this.options.metadata?.({ event: "backend-initialized" });
    }
    if (pending.method === "turn/start") {
      const thread = pending.params.threadId;
      const state = this.turns.get(thread);
      this.options.metadata?.({ event: message.error ? "turn-rejected" : "turn-accepted", threadId: thread,
        turnId: message.result?.turn?.id, model: pending.params.model, effort: pending.params.effort });
      if (state?.phase === "starting") {
        const turn = message.result?.turn;
        if (message.error || !turn || turn.status !== "inProgress" || this.completed.has(`${thread}:${turn.id}`)) this.turns.delete(thread);
        else { state.id = turn.id; state.phase = "active"; }
      }
    }
    if (["thread/start", "thread/resume", "thread/fork"].includes(pending.method) && !message.error && message.result?.thread?.id) {
      const id = message.result.thread.id;
      if (pending.managed) this.managed.add(id); else this.managed.delete(id);
      this.options.metadata?.({ event: pending.managed ? "thread-managed" : "thread-bypassed", threadId: id });
    }
    if (["thread/resume", "thread/fork"].includes(pending.method)) {
      const thread = message.result?.thread;
      const turn = thread?.turns?.findLast((item: any) => item.status === "inProgress");
      if (thread && (turn || thread.status?.type === "active")) this.turns.set(thread.id, { phase: "active", id: turn?.id, controller: new AbortController() });
    }
    this.clientIds.delete(pending.original);
    this.options.toClient({ ...message, id: pending.original });
  }
  private reply(id: Id, result: unknown): void { this.clientIds.delete(id); if (!this.closed) this.options.toClient({ id, result }); }
  private error(id: Id, message: string): void { this.clientIds.delete(id); if (!this.closed) this.options.toClient({ id, error: { code: -32000, message } }); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const turn of this.turns.values()) turn.controller.abort();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject?.(new Error("Disconnected")); }
    this.pending.clear(); this.turns.clear(); this.recent.clear(); this.serverIds.clear(); this.serverReverse.clear();
  }
}
