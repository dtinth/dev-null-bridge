/**
 * devnull-bridge — entry point. Wires {@link Runtime} to the real Deno APIs and runs.
 */
import { runCli } from "./cli.ts";
import { openDbAt } from "./db.ts";
import type { CommandResult, Runtime } from "./runtime.ts";

const env = Deno.env.toObject();
const home = env["HOME"] ?? "";

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

async function runCommand(
  cmd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  try {
    const { code, stdout, stderr } = await new Deno.Command(cmd, {
      args,
      env: extraEnv ?? {},
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

const encoder = new TextEncoder();

const runtime: Runtime = {
  env,
  now: () => new Date(),
  fetch,
  stdout: (text) => void Deno.stdout.writeSync(encoder.encode(text)),
  stderr: (text) => void Deno.stderr.writeSync(encoder.encode(text)),
  runCommand,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openDb() {
    const path = env["BRIDGE_DB"] ??
      `${env["XDG_DATA_HOME"] ?? `${home}/.local/share`}/dev-null-bridge/bridge.db`;
    Deno.mkdirSync(dirname(path), { recursive: true });
    return openDbAt(path);
  },
  cacheDir: () => `${env["XDG_CACHE_HOME"] ?? `${home}/.cache`}/dev-null-bridge`,
  async readTextFile(path) {
    try {
      return await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  },
  async writeTextFile(path, content) {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, content, { mode: 0o600 });
  },
};

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args, runtime));
}
