/**
 * devnull-bridge-server — entry point. Wires {@link Runtime} to the real Deno APIs and runs.
 */
import { runCli } from "./cli.ts";
import { openDbAt } from "./db.ts";
import type { CommandResult, Runtime } from "./runtime.ts";

const env = Deno.env.toObject();
const home = env["HOME"] ?? "";
const dbPath = env["BRIDGE_DB"] ??
  `${env["XDG_DATA_HOME"] ?? `${home}/.local/share`}/dev-null-bridge/bridge.db`;

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash) || "/";
}

async function runCommand(
  cmd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  try {
    const { code, stdout, stderr } = await new Deno.Command(cmd, {
      args,
      // Only what the commit script needs: never the server's secrets.
      clearEnv: true,
      env: { HOME: home, PATH: env["PATH"] ?? "/usr/bin:/bin", ...extraEnv },
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
    Deno.mkdirSync(dirname(dbPath), { recursive: true });
    return openDbAt(dbPath);
  },
  dataDir: () => dirname(dbPath),
  serve: (port, hostname, handler) =>
    Deno.serve({ hostname, port, onListen: () => {} }, handler).finished,
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
  async makePrivateDir(path) {
    await Deno.mkdir(path, { recursive: true, mode: 0o700 });
    await Deno.chmod(path, 0o700);
  },
  makeTempDir: () => Deno.makeTempDir({ prefix: "devnull-bridge-" }),
  // Never over an existing file (export could otherwise clobber the live database).
  writeFile: (path, content) => Deno.writeFile(path, content, { mode: 0o600, createNew: true }),
  removeDir: (path) => Deno.remove(path, { recursive: true }),
};

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args, runtime));
}
