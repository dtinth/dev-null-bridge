/**
 * Every external effect of the server goes through here, so it can be tested without a network, a
 * clock, a subprocess or a real database. (Same idea as claw's agent CLI.)
 */
import type { Db } from "./db.ts";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runtime {
  env: Record<string, string>;
  now(): Date;
  fetch: typeof fetch;
  stdout(text: string): void;
  stderr(text: string): void;
  runCommand(cmd: string, args: string[], env?: Record<string, string>): Promise<CommandResult>;
  sleep(ms: number): Promise<void>;
  openDb(): Db;
  /** Directory for things the bridge downloads, such as the commit script. */
  cacheDir(): string;
  /** Directory the sqlite file is in; the bot's SSH key is kept there too. */
  dataDir(): string;
  /** Serve HTTP until the process is stopped. */
  serve(
    port: number,
    hostname: string,
    handler: (request: Request) => Response | Promise<Response>,
  ): Promise<void>;
  readTextFile(path: string): Promise<string | null>;
  writeTextFile(path: string, content: string): Promise<void>;
  /** Make a directory (and its parents) that only the owner can open. */
  makePrivateDir(path: string): Promise<void>;
  /** A new private directory for files that only live while one request is handled. */
  makeTempDir(): Promise<string>;
  /** Write a new file (only the owner can read it); fails if one is there. */
  writeFile(path: string, content: Uint8Array): Promise<void>;
  removeDir(path: string): Promise<void>;
}

/** Who may give instructions: only these authors' replies are ever stored. */
export function allowedAuthors(env: Record<string, string>): string[] {
  return (env["BRIDGE_AUTHORS"] ?? "dtinth").split(",").map((a) => a.trim()).filter(Boolean);
}

/** The account agents post as. */
export function botUser(env: Record<string, string>): string {
  return env["BRIDGE_BOT_USER"] ?? "dtinth-bot";
}

export function baseUrl(env: Record<string, string>): string {
  return (env["DEVNULL_URL"] ?? "https://dev-null.sh").replace(/\/+$/, "");
}
