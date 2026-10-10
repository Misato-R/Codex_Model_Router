import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const TOKEN_ENV = "ROUTER_CLI_REMOTE_TOKEN";
export function authorized(headers: IncomingHttpHeaders, address: string | undefined, port: number, token: string): boolean {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")) return false;
  // The native CLI sends no Origin. Reject browser contexts, including localhost sites.
  if (headers.origin !== undefined) return false;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(headers.host ?? "")) return false;
  const supplied = Buffer.from(headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !["typesafe_api_key", TOKEN_ENV.toLowerCase()].includes(key.toLowerCase())));
}

export function frontendArgs(url: string, resume: string | undefined, args: string[]): string[] {
  // The caller owns native CLI options after --; transport options are reserved.
  if (args.some((arg) => /^--remote(?:=|$)|^--remote-auth-token-env(?:=|$)/.test(arg))) throw new Error("Remote transport flags are managed by the proxy.");
  return ["--remote", url, "--remote-auth-token-env", TOKEN_ENV, ...(resume ? ["resume", resume] : []), ...args];
}
