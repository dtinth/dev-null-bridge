/** A Runtime for tests: nothing real is touched, and everything the CLI printed is kept. */
import { openDbAt } from "./db.ts";
import type { CommandResult, Runtime } from "./runtime.ts";

export interface FakeRuntime extends Runtime {
  out: string[];
  err: string[];
  commands: { cmd: string; args: string[]; env: Record<string, string> | undefined }[];
  files: Map<string, string>;
  clock: { time: number };
  fetched: string[];
  served: {
    port: number;
    hostname: string;
    handler: (request: Request) => Response | Promise<Response>;
  }[];
  /** Files written with writeFile, by path; removed with their directory. */
  binaries: Map<string, Uint8Array>;
}

export interface FakeOptions {
  env?: Record<string, string>;
  /** Answers by URL (JSON bodies); anything else is a 404. */
  routes?: Record<string, unknown>;
  /** Text bodies by URL. */
  texts?: Record<string, string>;
  /** Answers for subprocesses; by default they succeed, and ssh-keygen -f makes a key. */
  command?: (cmd: string, args: string[]) => CommandResult;
  /** Answers for any other request (a POST, a header check), after routes and texts. */
  handle?: (request: Request) => Response | undefined;
}

/** The public key the fake ssh-keygen makes, without its comment. */
export const FAKE_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey";

export function fakeRuntime(options: FakeOptions = {}): FakeRuntime {
  const db = openDbAt(":memory:");
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const clock = { time: Date.parse("2026-10-19T12:00:00Z") };
  const fetched: string[] = [];
  const binaries = new Map<string, Uint8Array>();
  let temps = 0;

  return {
    env: options.env ?? {},
    out,
    err,
    files,
    clock,
    fetched,
    binaries,
    served: [],
    commands: [],
    now: () => new Date(clock.time),
    fetch: (input, init) => {
      const url = String(input);
      fetched.push(url);
      const handled = options.handle?.(new Request(url, init));
      if (handled !== undefined) return Promise.resolve(handled);
      const text = options.texts?.[url];
      if (text !== undefined) return Promise.resolve(new Response(text));
      const route = options.routes?.[url];
      if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(Response.json(route));
    },
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    runCommand(cmd, args, env) {
      this.commands.push({ cmd, args, env });
      if (options.command !== undefined) return Promise.resolve(options.command(cmd, args));
      const keyPath = args[args.indexOf("-f") + 1];
      if (cmd === "ssh-keygen" && keyPath !== undefined) {
        files.set(keyPath, "PRIVATE KEY");
        files.set(`${keyPath}.pub`, `${FAKE_PUBLIC_KEY} ${args[args.indexOf("-C") + 1]}\n`);
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    sleep: (ms) => {
      clock.time += ms;
      return Promise.resolve();
    },
    openDb: () => db,
    serve(port, hostname, handler) {
      this.served.push({ port, hostname, handler });
      return Promise.resolve();
    },
    cacheDir: () => "/cache",
    dataDir: () => "/data",
    readTextFile: (path) => Promise.resolve(files.get(path) ?? null),
    writeTextFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    makePrivateDir: () => Promise.resolve(),
    makeTempDir: () => Promise.resolve(`/tmp/upload-${++temps}`),
    writeFile: (path, content) => {
      if (binaries.has(path)) return Promise.reject(new Error(`${path} already exists`));
      binaries.set(path, content);
      return Promise.resolve();
    },
    removeDir: (path) => {
      for (const file of [...binaries.keys()]) {
        if (file.startsWith(`${path}/`)) binaries.delete(file);
      }
      return Promise.resolve();
    },
  };
}

/** The API's JSON for one commit. */
export function commitJson(
  id: string,
  parentId: string | null,
  extra: { author?: string; body?: string; images?: string[] } = {},
): Record<string, unknown> {
  return {
    id,
    short_hash: id.replaceAll("-", "").slice(-7),
    parent_id: parentId,
    body: extra.body ?? `body of ${id}`,
    html_url: `https://dev-null.sh/@${extra.author ?? "dtinth"}/commits/${id}`,
    created_at: "2026-10-19T12:00:00Z",
    images: (extra.images ?? []).map((url) => ({ url })),
    author: { username: extra.author ?? "dtinth" },
  };
}
