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
  served: { port: number; handler: (request: Request) => Response | Promise<Response> }[];
}

export interface FakeOptions {
  env?: Record<string, string>;
  /** Answers by URL (JSON bodies); anything else is a 404. */
  routes?: Record<string, unknown>;
  /** Text bodies by URL. */
  texts?: Record<string, string>;
  command?: (cmd: string, args: string[]) => CommandResult;
}

export function fakeRuntime(options: FakeOptions = {}): FakeRuntime {
  const db = openDbAt(":memory:");
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const clock = { time: Date.parse("2026-10-19T12:00:00Z") };
  const fetched: string[] = [];

  return {
    env: options.env ?? {},
    out,
    err,
    files,
    clock,
    fetched,
    served: [],
    commands: [],
    now: () => new Date(clock.time),
    fetch: (input) => {
      const url = String(input);
      fetched.push(url);
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
      return Promise.resolve(
        options.command?.(cmd, args) ?? { code: 0, stdout: "", stderr: "" },
      );
    },
    sleep: (ms) => {
      clock.time += ms;
      return Promise.resolve();
    },
    openDb: () => db,
    serve(port, handler) {
      this.served.push({ port, handler });
      return Promise.resolve();
    },
    cacheDir: () => "/cache",
    readTextFile: (path) => Promise.resolve(files.get(path) ?? null),
    writeTextFile: (path, content) => {
      files.set(path, content);
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
