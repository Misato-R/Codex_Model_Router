import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { CliProxy, type ProxyOptions } from "./cli-proxy.js";
import { JsonObjectStream } from "./cli-json-stream.js";
import { childEnvironment } from "./cli-security.js";

export function desktopBackendEnv(env: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv {
  const clean = childEnvironment(env);
  for (const key of Object.keys(clean)) if (key.toLowerCase() === "codex_cli_path" || key.toUpperCase().startsWith("JEV_DESKTOP_")) delete clean[key];
  return { ...clean, CODEX_CLI_PATH: executable };
}
export async function stopDesktopChild(child: ChildProcess, grace = 1200): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let killer: ChildProcess | undefined;
    const done = () => { clearTimeout(force); clearTimeout(limit); child.removeListener("close", done); resolve(child.exitCode !== null || child.signalCode !== null); };
    const force = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      try { if (process.platform === "win32") {
        killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { try { child.kill(); } catch { /* deadline still applies */ } });
        killer.on("exit", (code) => { if (code !== 0) { try { child.kill(); } catch { /* deadline still applies */ } } });
      } else child.kill("SIGKILL"); } catch { try { child.kill(); } catch { /* deadline still applies */ } }
    }, grace);
    const limit = setTimeout(() => { try { killer?.kill(); child.kill(); } catch { /* no unbounded wait */ } child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); done(); }, grace + 1500);
    child.once("close", done);
    child.stdin?.end();
  });
}
export function startDesktopHost(options: Omit<ProxyOptions, "toBackend" | "toClient" | "fatal"> & {
  executable: string; args: string[]; env: NodeJS.ProcessEnv; input: Readable; output: Writable;
}): { closed: Promise<number>; close(code?: number): Promise<number> } {
  const child = spawn(options.executable, options.args, { env: desktopBackendEnv(options.env, options.executable), cwd: options.project, windowsHide: true, stdio: "pipe", shell: false });
  let stopping: Promise<number> | undefined;
  let finish!: (code: number) => void;
  const closed = new Promise<number>((resolve) => { finish = resolve; });
  const close = (code = 0) => stopping ??= (async () => {
    proxy.close(); options.input.pause(); options.input.removeListener("data", receive);
    const confirmed = await stopDesktopChild(child);
    let result = confirmed ? code : 1;
    try { options.metadata?.({ event: "proxy-closed", exitCode: result, backendExitConfirmed: confirmed }); } catch { result = 1; }
    finish(result); return result;
  })();
  const proxy = new CliProxy({ ...options,
    toBackend: (message) => { if (!stopping) child.stdin.write(JSON.stringify(message) + "\n"); },
    toClient: (message) => { if (!stopping) options.output.write(JSON.stringify(message) + "\n"); },
    fatal: () => { void close(1); },
  });
  const fromClient = new JsonObjectStream((value) => proxy.client(value));
  const fromBackend = new JsonObjectStream((value) => proxy.backend(value));
  const receive = (data: string) => { try { fromClient.push(data); } catch { void close(1); } };
  options.input.setEncoding("utf8"); options.input.on("data", receive);
  options.input.once("end", () => { void close(); });
  options.input.on("error", () => { void close(1); }); options.output.on("error", () => { void close(1); });
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (data: string) => { try { fromBackend.push(data); } catch { void close(1); } });
  child.stderr.resume();
  // close follows pipe draining; exit can precede the last JSON reply on stdout.
  child.on("error", () => { void close(1); }); child.on("close", (code) => { void close(code ?? 1); });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => { void close(1); });
  child.stdout.on("end", () => { const timer = setTimeout(() => { void close(child.exitCode ?? 1); }, 100); timer.unref(); });
  return { closed, close };
}
