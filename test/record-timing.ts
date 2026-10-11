import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log('npm run record:timing -- desktop|cli --project "输入项目路径"\n先退出桌面应用。日志写入 test/log；桌面模式保持此窗口打开，Enter 停止记录。');
  process.exit(0);
}
const target = args[0] ?? "desktop";
if (!["desktop", "cli"].includes(target)) throw new Error("Use desktop or cli followed by the usual launch options.");
const log = join(root, "test", "log");
mkdirSync(log, { recursive: true });
const marker = join(root, "test", `.recording-${randomUUID()}.active`);
writeFileSync(marker, "active\n");
const stop = () => rmSync(marker, { force: true });
process.once("exit", stop);
process.once("SIGTERM", () => { stop(); process.exit(0); });
process.on("SIGINT", () => { if (target === "desktop") { stop(); process.exit(0); } });
console.log(`耗时与 Codex Token 用量记录已启用，JSON 保存到：${log}`);
const child = spawn(process.execPath, ["--import", pathToFileURL(join(root, "node_modules", "tsx", "dist", "loader.mjs")).href,
  join(root, "src", `${target}.ts`), ...args.slice(1)], {
  cwd: root, stdio: "inherit", shell: false,
  env: { ...process.env, CMR_TIMING_DIR: log, CMR_TIMING_ACTIVE: marker, CMR_TIMING_OWNER: String(process.pid) },
});
child.once("error", () => { stop(); console.error("启动失败，记录已停止。"); process.exitCode = 1; });
child.once("close", code => {
  if (code !== 0 || target === "cli") { stop(); process.exitCode = code ?? 1; return; }
  console.log("请在启动的桌面应用中提问。保持此窗口打开；按 Enter 或 Ctrl+C 停止计时。停止计时后桌面应用仍可使用。");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  input.once("line", () => { stop(); input.close(); console.log("计时记录已停止。"); });
  input.once("close", stop);
});
