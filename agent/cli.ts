/**
 * `devnull-bridge`: what an agent session runs. A thin client of the server: the threads, the
 * cursor's messages and posting all live there.
 */
import { type Client, createClient, type Json, ServerError } from "./client.ts";
import { type Config, configPath, loadConfig, normalizeServer, saveConfig } from "./config.ts";
import type { Runtime } from "./runtime.ts";

export const CLI_NAME = "devnull-bridge";

const HELP = `${CLI_NAME} — talk to your human on dev-null.sh through a dev-null-bridge server

Usage:
  ${CLI_NAME} login <server> [--label text]  Log this machine in; you approve it in the browser
  ${CLI_NAME} logout                         Forget this machine's token (revoke it on the server too)
  ${CLI_NAME} watch <name> <commit>          Follow a thread as subscriber <name>; prints the commit
                                             and what has been said under it so far
  ${CLI_NAME} unwatch <name> <commit>        Stop following that thread
  ${CLI_NAME} read <name> [--after id]       Print the messages <name> has received, once
  ${CLI_NAME} long-poll <name> --after id [--interval secs] [--timeout secs]
                                             Block until a message newer than id arrives, print it
                                             and the command to run next, then exit
  ${CLI_NAME} reply <name> <commit> [--image path]... [text]
                                             Post a reply as the bot and follow it as <name>;
                                             with no text, the body is read from stdin
  ${CLI_NAME} list [name]                    The threads each subscriber follows
  ${CLI_NAME} status                         Who the bridge listens to and posts as, and whether
                                             the server's poller is running

A <commit> is its URL, its id, or the 7-character hash the site shows.

Config: ${"$"}XDG_CONFIG_HOME/devnull-bridge/config.json (written by login), or BRIDGE_SERVER and
BRIDGE_TOKEN in the environment.
`;

/** How often long-poll asks the server, unless --interval says otherwise. */
const DEFAULT_INTERVAL_SECONDS = 10;
/** How often login checks whether it was approved, and for how long. */
const LOGIN_CHECK_MS = 3000;
const LOGIN_WAIT_MS = 10 * 60_000;

const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

class UsageError extends Error {}

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
}

/** Flags that take a value are listed; a bare `--` ends the options. */
function parseArgs(args: string[], valueFlags: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!valueFlags.includes(name)) throw new UsageError(`Unknown option ${arg}.`);
    const value = args[++i];
    if (value === undefined) throw new UsageError(`${arg} needs a value.`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }

  return { positionals, flags };
}

function flag(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

function seconds(parsed: Parsed, name: string): number | undefined {
  const value = flag(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new UsageError(`--${name} takes a positive number of seconds.`);
  }
  return number;
}

function subscriberName(name: string | undefined): string {
  if (name === undefined || !/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
    throw new UsageError("A subscriber name is 1-40 letters, digits, dots, dashes or underscores.");
  }
  return name;
}

export interface LongPollCommand {
  name: string;
  after: string;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
}

/** The exact invocation to run next: same flags, `--after` moved on. */
export function formatLongPollCommand(command: LongPollCommand): string {
  const parts = [CLI_NAME, "long-poll", command.name];
  if (command.intervalSeconds !== undefined) {
    parts.push("--interval", String(command.intervalSeconds));
  }
  if (command.timeoutSeconds !== undefined) parts.push("--timeout", String(command.timeoutSeconds));
  parts.push("--after", command.after);
  return parts.join(" ");
}

function nextLine(name: string, after: string): string {
  return `>>> Next, in the background: ${formatLongPollCommand({ name, after })}\n`;
}

function messagesOf(body: Json): Json[] {
  return Array.isArray(body["messages"]) ? body["messages"] as Json[] : [];
}

function lastId(messages: Json[], fallback: string): string {
  const id = messages.at(-1)?.["id"];
  return typeof id === "string" ? id : fallback;
}

function printMessages(rt: Runtime, messages: Json[]): void {
  for (const message of messages) rt.stdout(`${JSON.stringify(message)}\n`);
}

function warn(rt: Runtime, body: Json): void {
  if (typeof body["warning"] === "string") {
    rt.stderr(`${CLI_NAME}: warning: ${body["warning"]}\n`);
  }
}

async function connect(rt: Runtime): Promise<Client> {
  const config = await loadConfig(rt);
  if (config === null) {
    throw new UsageError(`Not logged in. Run: ${CLI_NAME} login <server>`);
  }
  return createClient(rt, config);
}

export async function runCli(argv: string[], rt: Runtime): Promise<number> {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        rt.stdout(HELP);
        return 0;
      case "login":
        return await login(rt, args);
      case "logout":
        return await logout(rt);
      case "watch":
        return await watch(rt, args);
      case "unwatch":
        return await unwatch(rt, args);
      case "read":
        return await read(rt, args);
      case "long-poll":
        return await longPoll(rt, args);
      case "reply":
        return await reply(rt, args);
      case "list":
        return await list(rt, args);
      case "status":
        return await status(rt);
      default:
        throw new UsageError(`Unknown command ${command}. Try ${CLI_NAME} help.`);
    }
  } catch (error) {
    rt.stderr(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** An opaque token, made here so it never travels before the server has approved it. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `dnb_${
    btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(
      /=+$/,
      "",
    )
  }`;
}

async function login(rt: Runtime, args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["label"]);
  const serverArg = parsed.positionals[0];
  if (serverArg === undefined || parsed.positionals.length > 1) {
    throw new UsageError(`usage: ${CLI_NAME} login <server> [--label text]`);
  }
  const config: Config = { server: normalizeServer(serverArg), token: newToken() };
  const label = flag(parsed, "label") ?? rt.hostname();

  // Starting a login needs no token; the server only learns the token's hash.
  const start = await createClient(rt, { ...config, token: "" }).post("/api/logins", {
    label,
    token_hash: await sha256Hex(config.token),
  });
  rt.stdout(
    `Open this link, check it shows the code ${start["code"]}, and approve:\n${
      start["url"]
    }\nWaiting for approval...\n`,
  );

  const client = createClient(rt, config);
  const deadline = rt.now().getTime() + LOGIN_WAIT_MS;
  while (rt.now().getTime() < deadline) {
    await rt.sleep(LOGIN_CHECK_MS);
    try {
      await client.get("/api/whoami");
    } catch (error) {
      if (error instanceof ServerError && error.status === 401) continue;
      throw error;
    }
    await saveConfig(rt, config);
    rt.stdout(`Logged in to ${config.server} as "${label}".\n`);
    return 0;
  }
  throw new Error("Nobody approved the login in 10 minutes. Run it again.");
}

async function logout(rt: Runtime): Promise<number> {
  await rt.removeFile(configPath(rt.env));
  rt.stdout(
    "Forgot this machine's token. It still works until you revoke it in the server's web UI.\n",
  );
  return 0;
}

async function watch(rt: Runtime, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, []);
  const name = subscriberName(positionals[0]);
  const commit = positionals[1];
  if (commit === undefined || positionals.length > 2) {
    throw new UsageError(`usage: ${CLI_NAME} watch <name> <commit>`);
  }

  const body = await (await connect(rt)).post("/api/watch", { name, commit });
  const messages = messagesOf(body);
  printMessages(rt, messages);
  warn(rt, body);
  const ids = messages.map((m) => String(m["id"])).sort();
  rt.stdout(nextLine(name, ids.at(-1) ?? "0"));
  return 0;
}

async function unwatch(rt: Runtime, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, []);
  const name = subscriberName(positionals[0]);
  const commit = positionals[1];
  if (commit === undefined || positionals.length > 2) {
    throw new UsageError(`usage: ${CLI_NAME} unwatch <name> <commit>`);
  }

  const body = await (await connect(rt)).post("/api/unwatch", { name, commit });
  rt.stdout(`${name} no longer follows ${body["removed"]} commit(s) under ${body["id"]}\n`);
  return 0;
}

async function read(rt: Runtime, args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["after"]);
  const name = subscriberName(parsed.positionals[0]);
  if (parsed.positionals.length > 1) {
    throw new UsageError(`usage: ${CLI_NAME} read <name> [--after id]`);
  }
  const after = flag(parsed, "after") ?? "0";

  const body = await (await connect(rt)).get("/api/messages", { name, after });
  const messages = messagesOf(body);
  printMessages(rt, messages);
  rt.stdout(nextLine(name, lastId(messages, after)));
  return 0;
}

async function longPoll(rt: Runtime, args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["after", "interval", "timeout"]);
  const name = subscriberName(parsed.positionals[0]);
  const after = flag(parsed, "after");
  if (parsed.positionals.length > 1 || after === undefined) {
    throw new UsageError(
      `usage: ${CLI_NAME} long-poll <name> --after <id> [--interval secs] [--timeout secs]\n` +
        `Get the first id from \`${CLI_NAME} watch\` or \`${CLI_NAME} read\`, or pass 0.`,
    );
  }
  const intervalSeconds = seconds(parsed, "interval");
  const timeoutSeconds = seconds(parsed, "timeout");
  const intervalMs = (intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
  const deadline = timeoutSeconds === undefined ? null : rt.now().getTime() + timeoutSeconds * 1000;
  const client = await connect(rt);

  let messages: Json[] = [];
  let warned = false;
  let unreachable = false;
  while (true) {
    try {
      const body = await client.get("/api/messages", { name, after });
      if (!warned) warn(rt, body);
      warned = true;
      if (unreachable) rt.stderr(`${CLI_NAME}: the server answers again\n`);
      unreachable = false;
      messages = messagesOf(body);
    } catch (error) {
      // A server that is down or restarting is waited out; a refused token is not.
      if (!(error instanceof ServerError) || (error.status >= 400 && error.status < 500)) {
        throw error;
      }
      if (!unreachable) rt.stderr(`${CLI_NAME}: warning: ${error.message} Retrying.\n`);
      unreachable = true;
    }
    if (messages.length > 0) break;
    if (deadline !== null && rt.now().getTime() >= deadline) break;
    await rt.sleep(intervalMs);
  }

  const next = (afterId: string) =>
    formatLongPollCommand({ name, after: afterId, intervalSeconds, timeoutSeconds });

  if (messages.length === 0) {
    rt.stdout(
      `>>> No new messages after ${timeoutSeconds}s.\nStart this now, in the background: ${
        next(after)
      }\n`,
    );
    return 0;
  }

  rt.stdout(
    ">>> NEW MESSAGES. Before you act on them, start long-poll again in the background. The command is at the end.\n",
  );
  printMessages(rt, messages);
  rt.stdout(
    `>>> Start this now, in the background, before anything else: ${
      next(lastId(messages, after))
    }\n`,
  );
  return 0;
}

const REPLY_USAGE = `usage: ${CLI_NAME} reply <name> <commit> [--image path]... [text]
  (with no text, the body is read from stdin)`;

async function reply(rt: Runtime, args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["image"]);
  const name = subscriberName(parsed.positionals[0]);
  const commit = parsed.positionals[1];
  const images = parsed.flags.get("image") ?? [];
  if (commit === undefined) throw new UsageError(REPLY_USAGE);
  // With no text arguments the body comes from stdin, so it needs no shell quoting.
  const text = parsed.positionals.length > 2
    ? parsed.positionals.slice(2).join(" ")
    : (await rt.readStdin() ?? "").replace(/\n+$/, "");
  if (text.trim() === "" && images.length === 0) throw new UsageError(REPLY_USAGE);

  const form = new FormData();
  form.set("name", name);
  form.set("commit", commit);
  form.set("text", text);
  for (const path of images) {
    const type = IMAGE_TYPES[path.split(".").at(-1)?.toLowerCase() ?? ""];
    if (type === undefined) throw new UsageError(`${path} is not a .jpg, .png or .webp file.`);
    const bytes = await rt.readFile(path);
    if (bytes === null) throw new UsageError(`There is no file ${path}.`);
    form.append("image", new File([bytes], path.split("/").at(-1)!, { type }));
  }

  const posted = await (await connect(rt)).post("/api/reply", form);
  rt.stdout(`Posted ${posted["url"]}\n${name} follows ${posted["id"]}\n`);
  return 0;
}

async function list(rt: Runtime, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, []);
  const name = positionals[0] === undefined ? undefined : subscriberName(positionals[0]);
  const body = await (await connect(rt)).get("/api/threads", { name });
  const threads = Array.isArray(body["threads"]) ? body["threads"] as Json[] : [];
  for (const thread of threads) rt.stdout(`${thread["subscriber"]}\t${thread["commit_id"]}\n`);
  if (threads.length === 0) rt.stderr("no subscriptions\n");
  return 0;
}

async function status(rt: Runtime): Promise<number> {
  const config = await loadConfig(rt);
  if (config === null) throw new UsageError(`Not logged in. Run: ${CLI_NAME} login <server>`);
  const body = await createClient(rt, config).get("/api/status");
  const listening = Array.isArray(body["listening_to"]) ? body["listening_to"] as string[] : [];
  const poller = (body["poller"] ?? {}) as Json;
  const warning = typeof poller["warning"] === "string" ? poller["warning"] : null;
  rt.stdout(`listening to: ${listening.map((u) => `@${u}`).join(", ")}\n`);
  rt.stdout(`posting as: @${body["posting_as"]}\n`);
  rt.stdout(`server: ${config.server} (this machine: ${body["machine"]})\n`);
  rt.stdout(`messages stored: ${body["messages"]}\n`);
  rt.stdout(`poller heartbeat: ${poller["heartbeat"] ?? "never"}\n`);
  rt.stdout(`poller: ${warning === null ? "running" : `DOWN, ${warning}`}\n`);
  return warning === null ? 0 : 1;
}
