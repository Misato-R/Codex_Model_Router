import { execFileSync } from "node:child_process";

/** Read a persisted Windows environment value when a host starts with a filtered environment block. */
function readWindowsEnvironmentValue(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const registryKeys = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  for (const key of registryKeys) {
    try {
      const output = execFileSync("reg.exe", ["query", key, "/v", name], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = output.match(new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$`, "im"));
      const value = match?.[1]?.trim();
      if (value) return value;
    } catch {
      // Try the other scope; never expose registry command output.
    }
  }
  return undefined;
}

export function getTypesafeApiKey(): string | undefined {
  const inherited = process.env.TYPESAFE_API_KEY?.trim();
  return inherited || readWindowsEnvironmentValue("TYPESAFE_API_KEY");
}
