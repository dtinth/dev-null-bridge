/**
 * devnull-bridge — entry point. Wires {@link Runtime} to the real Deno APIs and runs.
 */
import { runCli } from "./cli.ts";
import type { Runtime } from "./runtime.ts";

const encoder = new TextEncoder();

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

const runtime: Runtime = {
  env: Deno.env.toObject(),
  now: () => new Date(),
  fetch,
  stdout: (text) => void Deno.stdout.writeSync(encoder.encode(text)),
  stderr: (text) => void Deno.stderr.writeSync(encoder.encode(text)),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  async readStdin() {
    if (Deno.stdin.isTerminal()) return null;
    return await new Response(Deno.stdin.readable).text();
  },
  readFile: (path) => orNull(() => Deno.readFile(path)),
  readTextFile: (path) => orNull(() => Deno.readTextFile(path)),
  async writeTextFile(path, content) {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, content, { mode: 0o600 });
  },
  removeFile: async (path) => void await orNull(() => Deno.remove(path)),
  hostname: () => Deno.hostname(),
};

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args, runtime));
}
