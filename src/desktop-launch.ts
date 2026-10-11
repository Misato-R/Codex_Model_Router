import { spawn } from "node:child_process";

export function requireDesktopStopped(running: boolean): void {
  if (running) throw new Error("Desktop is running. Fully exit it before launch (check/prepare are allowed). No existing process was changed.");
}

export function desktopLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // FORCE_CLI also changes cloud hosts. Keep their transport under desktop control.
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !["codex_cli_path", "codex_app_server_force_cli", "codex_app_server_ws_url"].includes(key.toLowerCase()) &&
    !key.toUpperCase().startsWith("JEV_DESKTOP_")));
}

export function launchDesktop(options: { running: boolean; app: string; project: string; env: NodeJS.ProcessEnv }, launch = spawn) {
  requireDesktopStopped(options.running);
  return launch(options.app, [], { env: options.env, cwd: options.project, detached: true, stdio: "ignore", windowsHide: true, shell: false });
}
