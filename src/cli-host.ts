import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { CliProxy, type Message, type ProxyOptions } from "./cli-proxy.js";
import { authorized, childEnvironment } from "./cli-security.js";
import { JsonObjectStream } from "./cli-json-stream.js";

export async function stopChild(child: ChildProcess, ownsProcessGroup = false): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // Kill only the process tree rooted at the child this host created.
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else {
        try { if (ownsProcessGroup) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, 2000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.stdin?.end();
  });
}

export interface HostOptions extends Pick<ProxyOptions, "project" | "manual" | "route" | "metadata" | "controlTimeoutMs" | "classificationTimeoutMs"> {
  executable: string;
  env: NodeJS.ProcessEnv;
  token: string;
  port?: number;
  /** Dependency injection for offline process/transport tests. */
  backendArgs?: string[];
}

export async function startHost(options: HostOptions): Promise<{ url: string; closed: Promise<void>; close(): Promise<void> }> {
  if (options.token.length < 32) throw new Error("Remote capability token must contain at least 32 characters.");
  let child: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  let proxy: CliProxy | undefined;
  let stopping: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
  const close = (): Promise<void> => stopping ??= (async () => {
    proxy?.close(); socket?.terminate();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    ws.close();
    if (child) await stopChild(child, true);
    resolveClosed();
  })();
  server.on("upgrade", (request, connection, head) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (socket || stopping || request.url !== "/" || !authorized(request.headers, request.socket.remoteAddress, port, options.token)) {
      connection.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    ws.handleUpgrade(request, connection, head, (client) => ws.emit("connection", client, request));
  });
  ws.on("connection", (client) => {
    socket = client;
    child = spawn(options.executable, options.backendArgs ?? ["app-server", "--listen", "stdio://", "-c", "mcp_servers.jev_model_router.enabled=false"], {
      cwd: options.project, env: childEnvironment(options.env), stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      // A separate process group keeps terminal Ctrl-C owned by the native TUI.
      detached: true,
    });
    const fail = (reason: string) => {
      if (stopping) return;
      options.metadata?.({ event: "connection-closed", reason });
      void close();
    };
    proxy = new CliProxy({ ...options,
      toBackend(message) { child!.stdin!.write(`${JSON.stringify(message)}\n`); },
      toClient(message) { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); },
      fatal: () => fail("proxy-fatal"),
    });
    const decoder = new JsonObjectStream((message) => proxy!.backend(message));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (stopping) return;
      try { decoder.push(chunk); } catch { fail("backend-invalid-message"); }
    });
    child.stdout!.on("end", () => fail("backend-eof"));
    child.on("error", () => fail("backend-spawn-error")); child.on("close", (code) => fail(`backend-exit-${code}`));
    child.stdin!.on("error", () => fail("backend-write-error")); child.stdout!.on("error", () => fail("backend-stdout-error"));
    // Drain without printing protocol data, secrets, task text or corrupting the TUI.
    child.stderr!.resume(); child.stderr!.on("error", () => fail("backend-stderr-error"));
    client.on("message", (data, binary) => {
      if (binary) { fail("binary-client-message"); return; }
      try { proxy!.client(parseMessage(data.toString())); } catch { fail("client-invalid-message"); }
    });
    client.on("close", (code) => fail(`client-close-${code}`)); client.on("error", () => fail("client-error"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", () => { void close(); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return { url: `ws://127.0.0.1:${address.port}`, closed, close };
}

function parseMessage(text: string): Message {
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Invalid RPC envelope");
  return value;
}
