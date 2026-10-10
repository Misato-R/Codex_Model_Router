import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

export type RpcParams = Record<string, unknown>;
export type Notification = { method: string; params: RpcParams };
export type ServerRequest = Notification & { id: number | string };
export interface RpcConnection {
  request<T = RpcParams>(method: string, params?: RpcParams): Promise<T>;
  onNotification(listener: (event: Notification) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  /** Permanently reject further work when a turn's terminal state is unknown. */
  invalidate?(error: Error): void;
}

/** Resolve the SDK's installed native runtime; never ask cmd.exe to interpret arguments. */
export function codexRuntime(): { executable: string; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  // Only the router process needs the TypeSafe credential.
  delete env.TYPESAFE_API_KEY;
  if (process.env.CODEX_PATH) {
    const executable = process.env.CODEX_PATH;
    if (!isAbsolute(executable) || !existsSync(executable) || /\.(cmd|bat|ps1)$/i.test(executable)) {
      throw new Error("CODEX_PATH 必须指向存在的原生 Codex 可执行文件的绝对路径。");
    }
    return { executable, env };
  }
  const localRequire = createRequire(import.meta.url);
  const resolvers = [localRequire];
  try { resolvers.push(createRequire(localRequire.resolve("@openai/codex-sdk"))); } catch { /* try local */ }
  const triples: Record<string, string> = {
    "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin",
  };
  const platform = `${process.platform}-${process.arch}`;
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  for (const resolvePackage of resolvers) {
    for (const packageName of [`@openai/codex-${platform}`, "@openai/codex"]) {
      try {
        const root = join(dirname(resolvePackage.resolve(`${packageName}/package.json`)), "vendor", triples[platform] ?? platform);
        const executable = [join(root, "bin", binary), join(root, "codex", binary)].find(existsSync);
        if (!executable) continue;
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
        const extra = [join(root, "codex-path"), join(root, "path")].filter(existsSync);
        env[pathKey] = [...extra, env[pathKey] ?? ""].join(delimiter);
        return { executable, env };
      } catch { /* try the other installed package layout */ }
    }
  }
  throw new Error("找不到 Codex 原生运行时。请运行 npm install，或设置 CODEX_PATH 指向 codex.exe。");
}

export class AppServerClient implements RpcConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(event: Notification) => void>();
  private failures = new Set<(error: Error) => void>();
  private failure?: Error;
  private closing = false;
  private stderr = "";
  private readonly exited: Promise<void>;
  private readonly lines;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handleRequest: (request: ServerRequest) => Promise<unknown>,
    private readonly requestTimeoutMs = 30_000,
  ) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.receive(line));
    this.lines.on("error", (error) => this.fail(error));
    this.lines.once("close", () => this.fail(new Error("App Server 输出通道已关闭；请退出后恢复会话。")));
    child.stdout.on("error", (error) => this.fail(error));
    child.stdout.once("end", () => this.fail(new Error("App Server 输出通道已结束；请退出后恢复会话。")));
    child.stdout.once("close", () => this.fail(new Error("App Server 输出流已关闭；请退出后恢复会话。")));
    child.stderr.setEncoding("utf8").on("data", (text: string) => { this.stderr = (this.stderr + text).slice(-4000); });
    child.stdin.on("error", (error) => this.fail(error));
    child.once("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) => {
      child.once("close", (code) => {
        this.lines.close();
        this.fail(new Error(`Codex App Server 已退出 (${code})。${this.closing ? "" : this.stderr}`));
        resolve();
      });
    });
  }

  static launch(project: string, handler: (request: ServerRequest) => Promise<unknown>): AppServerClient {
    const runtime = codexRuntime();
    const child = spawn(runtime.executable, [
      "app-server", "--listen", "stdio://", "-c", "mcp_servers.jev_model_router.enabled=false",
    ], { cwd: project, env: runtime.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return new AppServerClient(child, handler);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "codex_model_router", title: "Jev Router Chat", version: "0.2.0" } });
    this.send({ method: "initialized", params: {} });
  }

  request<T = RpcParams>(method: string, params: RpcParams = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error("App Server 正在关闭。"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // An unacknowledged mutation could still be running. Fail the connection,
        // rather than retrying turn/start and accidentally executing twice.
        this.fail(new Error(`${method} 在 ${this.requestTimeoutMs / 1000} 秒内未确认；请退出后恢复会话，勿自动重试。`));
        reject(this.failure!);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.send({ id, method, params }); } catch (error) { this.fail(asError(error)); }
    });
  }

  onNotification(listener: (event: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failures.delete(listener);
  }

  private send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(line: string): void {
    if (this.failure || this.closing) return;
    try {
      const message = JSON.parse(line) as RpcParams;
      if (typeof message.method === "string") {
        const event = { method: message.method, params: (message.params ?? {}) as RpcParams };
        if (typeof message.id === "number" || typeof message.id === "string") {
          const id = message.id;
          void this.handleRequest({ ...event, id }).then(
            (result) => { if (!this.closing && !this.failure) this.send({ id, result }); },
            (error: unknown) => { if (!this.closing && !this.failure) this.send({ id, error: { code: -32603, message: asError(error).message } }); },
          ).catch((error: unknown) => this.fail(asError(error)));
        } else {
          for (const listener of this.listeners) listener(event);
        }
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(String((message.error as RpcParams).message ?? "App Server 请求失败")));
        else pending.resolve(message.result);
      }
    } catch (error) { this.fail(new Error(`App Server 协议处理失败：${asError(error).message}`)); }
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
  }

  invalidate(error: Error): void { this.fail(error); }

  async close(): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    this.fail(new Error("App Server 连接已关闭。"));
    this.child.stdin.end();
    const killTimer = setTimeout(() => {
      if (!this.child.pid || this.child.exitCode !== null) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
        killer.on("error", () => this.child.kill());
      } else this.child.kill("SIGTERM");
    }, 2000);
    try { await this.exited; } finally { clearTimeout(killTimer); }
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
