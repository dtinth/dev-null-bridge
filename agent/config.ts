/**
 * Which server to talk to and the token for it. `login` writes them to a file only the user can
 * read; BRIDGE_SERVER and BRIDGE_TOKEN override the file (for a container, say).
 */
import type { Runtime } from "./runtime.ts";

export interface Config {
  server: string;
  token: string;
}

export function configPath(env: Record<string, string>): string {
  const base = env["XDG_CONFIG_HOME"] ?? `${env["HOME"] ?? ""}/.config`;
  return `${base}/devnull-bridge/config.json`;
}

export async function loadConfig(rt: Runtime): Promise<Config | null> {
  let saved: Partial<Config> = {};
  const text = await rt.readTextFile(configPath(rt.env));
  if (text !== null) {
    try {
      saved = JSON.parse(text) as Partial<Config>;
    } catch {
      throw new Error(`${configPath(rt.env)} is not valid JSON. Run devnull-bridge login again.`);
    }
  }
  const server = rt.env["BRIDGE_SERVER"] ?? saved.server;
  const token = rt.env["BRIDGE_TOKEN"] ?? saved.token;
  if (typeof server !== "string" || typeof token !== "string") return null;
  return { server: normalizeServer(server), token };
}

export async function saveConfig(rt: Runtime, config: Config): Promise<void> {
  await rt.writeTextFile(configPath(rt.env), `${JSON.stringify(config, null, 2)}\n`);
}

/** `example.com` and `https://example.com/` both mean `https://example.com`. */
export function normalizeServer(server: string): string {
  const withScheme = /^https?:\/\//.test(server) ? server : `https://${server}`;
  return withScheme.replace(/\/+$/, "");
}
