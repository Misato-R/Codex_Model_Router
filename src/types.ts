export type Tier = "cheap" | "standard" | "hard";
export type Mode = "economy" | "balanced" | "quality";
export type Effort = "low" | "medium" | "high";

export interface Route {
  tier: Tier;
  model: string;
  effort: Effort;
  score?: number;
  reason: string;
  source?: "rules" | "jev" | "fallback";
  confidence?: number;
}

export interface ExecuteOptions {
  run?: boolean;
}

export interface ExecuteResult {
  command: string[];
  exitCode: number | null;
  output: string;
}

export interface TaskExecutor {
  execute(prompt: string, project: string, route: Route, options?: ExecuteOptions): Promise<ExecuteResult>;
}

/** Extension point for a future LangChain/LangGraph orchestration layer. */
export interface AgentRuntime {
  invoke(input: { prompt: string; project: string; route: Route }): Promise<string>;
}

export interface MemoryStore {
  read(project: string): Promise<string>;
  append(project: string, task: string, summary: string): Promise<void>;
}
