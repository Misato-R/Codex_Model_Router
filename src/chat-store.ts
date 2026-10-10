import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sameProject, type ChatState } from "./chat-session.js";

export class ChatStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly lock: string;
  private token = randomUUID();
  private acquired = false;

  constructor(private readonly project: string, sessionName: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionName)) throw new Error("--session 只允许 1–64 个英文字母、数字、下划线或连字符。");
    this.directory = join(project, ".router-memory", "chat");
    this.file = join(this.directory, `${sessionName}.json`);
    this.lock = `${this.file}.lock`;
  }

  async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(this.lock, "wx");
        try { await file.writeFile(JSON.stringify({ pid: process.pid, token: this.token })); }
        finally { await file.close(); }
        this.acquired = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lock = JSON.parse(await readFile(this.lock, "utf8")) as { pid: number };
        if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error(`无效会话锁：${this.lock}`);
        try { process.kill(lock.pid, 0); }
        catch (check) {
          if ((check as NodeJS.ErrnoException).code === "ESRCH" && attempt === 0) { await unlink(this.lock); continue; }
        }
        throw new Error("该命名会话已在另一个入口打开。请先退出原入口，或使用不同的 --session 名称。");
      }
    }
  }

  async read(): Promise<ChatState> {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as ChatState;
      if (state.version !== 1 || !sameProject(state.project, this.project) ||
          (state.threadId !== null && (typeof state.threadId !== "string" || !state.threadId)) ||
          !Array.isArray(state.recentTasks) || !state.recentTasks.every((item) => typeof item === "string")) {
        throw new Error("会话记录不符合当前项目或格式。");
      }
      return { ...state, recentTasks: state.recentTasks.slice(-3).map((task) => task.slice(0, 500)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, project: this.project, threadId: null, recentTasks: [] };
    }
  }

  async save(state: ChatState): Promise<void> {
    if (!this.acquired) throw new Error("会话未加锁，不能保存。");
    const temporary = `${this.file}.${this.token}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    const lock = JSON.parse(await readFile(this.lock, "utf8")) as { token: string };
    if (lock.token === this.token) await unlink(this.lock);
    this.acquired = false;
  }
}
