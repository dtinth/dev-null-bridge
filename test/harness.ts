/**
 * The CLI and the server together, in one process: the CLI's fetch goes straight to the server's
 * handler, the server's effects go to a fake runtime, and the CLI starts out logged in.
 */
import { runCli as runAgentCli } from "../agent/cli.ts";
import type { Runtime as AgentRuntime } from "../agent/runtime.ts";
import { sha256Hex } from "../src/auth.ts";
import { approveLogin, startLogin } from "../src/db.ts";
import {
  commitJson,
  type FakeOptions,
  type FakeRuntime,
  fakeRuntime,
} from "../src/fake_runtime.ts";
import { createServer, type ServerConfig } from "../src/server.ts";
import { uuid } from "../src/test_util.ts";

export const SERVER = "https://bridge.example";
export const API = "https://dev-null.sh/api/v1/commits";
export const ROOT = uuid(1);
export const COMMIT_SCRIPT = "#!/usr/bin/env bash\nssh-keygen -Y sign\n";
export const TOKEN = "dnb_test-token";

export interface Agent extends AgentRuntime {
  out: string[];
  err: string[];
  files: Map<string, string>;
  binaries: Map<string, Uint8Array<ArrayBuffer>>;
  clock: { time: number };
  stdin: string | null;
}

export interface Harness {
  server: FakeRuntime;
  handler: (request: Request) => Promise<Response>;
  config: ServerConfig;
  agent: Agent;
  run(...argv: string[]): Promise<number>;
  lines(): string[];
  jsonLines(): Record<string, unknown>[];
}

export function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    authors: ["dtinth"],
    botUser: "dtinth-bot",
    devnullUrl: "https://dev-null.sh",
    publicUrl: SERVER,
    oauth: { clientId: "client", clientSecret: "secret" },
    sessionSecret: "a session secret that is long enough",
    ...overrides,
  };
}

/** A server that knows ROOT and whose commit script "posts" uuid(2) as a reply. */
export function serverRuntime(options: FakeOptions = {}): FakeRuntime {
  return fakeRuntime({
    routes: { [`${API}/${ROOT}`]: { data: commitJson(ROOT, null, { body: "Please build X" }) } },
    texts: { "https://dev-null.sh/commit": COMMIT_SCRIPT },
    command: (_cmd, args) => ({
      code: 0,
      stdout: `Committed: https://dev-null.sh/@dtinth-bot/commits/${
        args.includes("--reply") ? uuid(2) : uuid(9)
      } (pending review)\n`,
      stderr: "",
    }),
    ...options,
  });
}

export function agentRuntime(
  handler: (request: Request) => Promise<Response>,
  env: Record<string, string>,
): Agent {
  const clock = { time: Date.parse("2026-10-19T12:00:00Z") };
  const files = new Map<string, string>();
  const binaries = new Map<string, Uint8Array<ArrayBuffer>>();
  const agent: Agent = {
    env,
    out: [],
    err: [],
    files,
    binaries,
    clock,
    stdin: null,
    now: () => new Date(clock.time),
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (!request.url.startsWith(SERVER)) {
        return Promise.reject(new TypeError(`no route to ${request.url}`));
      }
      return handler(request);
    },
    stdout: (text) => void agent.out.push(text),
    stderr: (text) => void agent.err.push(text),
    sleep: (ms) => {
      clock.time += ms;
      return Promise.resolve();
    },
    readStdin: () => Promise.resolve(agent.stdin),
    readFile: (path) => Promise.resolve(binaries.get(path) ?? null),
    readTextFile: (path) => Promise.resolve(files.get(path) ?? null),
    writeTextFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    removeFile: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
    hostname: () => "box-1",
  };
  return agent;
}

/** A machine that already logged in with TOKEN. */
export async function harness(
  options: { server?: FakeRuntime; config?: Partial<ServerConfig> } = {},
): Promise<Harness> {
  const server = options.server ?? serverRuntime();
  const config = serverConfig(options.config);
  const handler = createServer(server, server.openDb(), config);
  const now = server.now();
  startLogin(server.openDb(), {
    code: "BCDF-GHJK",
    tokenHash: await sha256Hex(TOKEN),
    label: "box-1",
    now,
  });
  approveLogin(server.openDb(), "BCDF-GHJK", "dtinth", now);

  const agent = agentRuntime(handler, { BRIDGE_SERVER: SERVER, BRIDGE_TOKEN: TOKEN });
  const lines = () => agent.out.join("").split("\n").filter(Boolean);
  return {
    server,
    handler,
    config,
    agent,
    run: (...argv) => runAgentCli(argv, agent),
    lines,
    jsonLines: () => lines().filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)),
  };
}
