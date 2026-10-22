/**
 * Command dispatch. Every external effect goes through {@link Runtime}.
 */
import { type Api, ApiError, createApi } from "./api.ts";
import { dashboardHandler } from "./dashboard.ts";
import {
  addTree,
  countMessages,
  fillPost,
  getMeta,
  listThreads,
  postsMissingText,
  readMessages,
  recordPost,
  removeTree,
  saveRoot,
} from "./db.ts";
import {
  CLI_NAME,
  formatLongPollCommand,
  lastId,
  pollerWarning,
  waitForMessages,
} from "./longpoll.ts";
import { runPoller } from "./poller.ts";
import { postCommit } from "./post.ts";
import { resolveRef, shortHashOf } from "./refs.ts";
import { allowedAuthors, baseUrl, botUser, type Runtime } from "./runtime.ts";
import { formatMessage, type Message } from "./types.ts";

const HELP = `${CLI_NAME} — talk to dtinth on dev-null.sh, many agent sessions through one poller

Usage:
  ${CLI_NAME} watch <name> <commit>          Follow a thread as subscriber <name>; prints the commit
                                             and what has been said under it so far
  ${CLI_NAME} unwatch <name> <commit>        Stop following that thread
  ${CLI_NAME} read <name> [--after id]       Print the messages <name> has received, once
  ${CLI_NAME} long-poll <name> --after id [--interval secs] [--timeout secs]
                                             Block until a message newer than id arrives, print it
                                             and the command to run next, then exit
  ${CLI_NAME} reply <name> <commit> [--image path]... <text>
                                             Post a reply as the bot and follow it as <name>
  ${CLI_NAME} list [name]                    The threads each subscriber follows
  ${CLI_NAME} status                         Who the bridge listens to and posts as, and whether
                                             the poller is running
  ${CLI_NAME} poller                         Run the poller (a daemon: see the README)
  ${CLI_NAME} dashboard [--port 8787]        A web page on 127.0.0.1 listing every subscription
  ${CLI_NAME} backfill                       Fetch the text of agent posts recorded without it

A <commit> is its URL, its id, or the 7-character hash the site shows.
Only replies by ${"$"}BRIDGE_AUTHORS (default: dtinth) are ever stored or printed.

Config (environment):
  BRIDGE_DB             sqlite file (default: ~/.local/share/dev-null-bridge/bridge.db)
  BRIDGE_AUTHORS        comma-separated usernames whose replies count (default: dtinth)
  BRIDGE_BOT_USER       the account agents post as (default: dtinth-bot)
  BRIDGE_INTERVAL       seconds between polls (default: 20)
  BRIDGE_COMMIT_SCRIPT  use this commit script instead of downloading one
  DEVNULL_URL           the site (default: https://dev-null.sh)
`;

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

function printMessages(rt: Runtime, messages: Message[]): void {
  for (const message of messages) rt.stdout(`${formatMessage(message)}\n`);
}

function nextLine(name: string, after: string): string {
  return `>>> Next, in the background: ${formatLongPollCommand({ name, after })}\n`;
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
      case "watch":
        return await watch(rt, args);
      case "unwatch":
        return await unwatch(rt, args);
      case "read":
        return read(rt, args);
      case "long-poll":
        return await longPoll(rt, args);
      case "reply":
        return await reply(rt, args);
      case "list":
        return list(rt, args);
      case "status":
        return status(rt);
      case "poller":
        return await poller(rt);
      case "dashboard":
        return await dashboard(rt, args);
      case "backfill":
        return await backfill(rt);
      default:
        throw new UsageError(`Unknown command ${command}. Try ${CLI_NAME} help.`);
    }
  } catch (error) {
    rt.stderr(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

async function watch(rt: Runtime, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, []);
  const name = subscriberName(positionals[0]);
  const ref = positionals[1];
  if (ref === undefined || positionals.length > 2) {
    throw new UsageError(`usage: ${CLI_NAME} watch <name> <commit>`);
  }

  const db = rt.openDb();
  const api = createApi(rt.fetch, baseUrl(rt.env));
  const id = await resolveRef(ref, {
    db,
    api,
    users: [...allowedAuthors(rt.env), botUser(rt.env)],
  });
  const root = await api.getCommit(id);
  if (root === null) {
    throw new Error(`There is no public commit ${id}. Is it still pending review?`);
  }

  saveRoot(db, root);
  addTree(db, name, id);
  const replies = readMessages(db, name).filter((message) => message.id !== id);
  const printed = [root, ...replies];
  printMessages(rt, printed);

  const warning = pollerWarning(db, rt.now());
  if (warning !== null) rt.stderr(`${CLI_NAME}: warning: ${warning}\n`);

  rt.stdout(nextLine(name, printed.map((m) => m.id).sort().at(-1)!));
  return 0;
}

async function unwatch(rt: Runtime, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, []);
  const name = subscriberName(positionals[0]);
  const ref = positionals[1];
  if (ref === undefined || positionals.length > 2) {
    throw new UsageError(`usage: ${CLI_NAME} unwatch <name> <commit>`);
  }

  const db = rt.openDb();
  const id = await resolveRef(ref, {
    db,
    api: createApi(rt.fetch, baseUrl(rt.env)),
    users: [...allowedAuthors(rt.env), botUser(rt.env)],
  });
  rt.stdout(`${name} no longer follows ${removeTree(db, name, id)} commit(s) under ${id}\n`);
  return 0;
}

function read(rt: Runtime, args: string[]): number {
  const parsed = parseArgs(args, ["after"]);
  const name = subscriberName(parsed.positionals[0]);
  if (parsed.positionals.length > 1) {
    throw new UsageError(`usage: ${CLI_NAME} read <name> [--after id]`);
  }
  const after = flag(parsed, "after") ?? "0";

  const messages = readMessages(rt.openDb(), name, after === "0" ? undefined : after);
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
  const db = rt.openDb();

  const warning = pollerWarning(db, rt.now());
  if (warning !== null) rt.stderr(`${CLI_NAME}: warning: ${warning}\n`);

  const messages = await waitForMessages(rt, db, {
    name,
    after: after === "0" ? "" : after,
    intervalMs: (intervalSeconds ?? 1) * 1000,
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
  });

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

async function reply(rt: Runtime, args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["image"]);
  const name = subscriberName(parsed.positionals[0]);
  const ref = parsed.positionals[1];
  const text = parsed.positionals.slice(2).join(" ");
  const images = parsed.flags.get("image") ?? [];
  if (ref === undefined || (text === "" && images.length === 0)) {
    throw new UsageError(`usage: ${CLI_NAME} reply <name> <commit> [--image path]... <text>`);
  }

  const db = rt.openDb();
  const parentId = await resolveRef(ref, {
    db,
    api: createApi(rt.fetch, baseUrl(rt.env)),
    users: [...allowedAuthors(rt.env), botUser(rt.env)],
  });

  const posted = await postCommit(rt, { replyTo: shortHashOf(parentId), images, text });
  recordPost(db, {
    id: posted.id,
    parentId,
    subscriber: name,
    createdAt: rt.now().toISOString(),
    body: text,
    htmlUrl: posted.url,
  });

  rt.stdout(`Posted ${posted.url}\n${name} follows ${posted.id}\n`);
  return 0;
}

function list(rt: Runtime, args: string[]): number {
  const { positionals } = parseArgs(args, []);
  const name = positionals[0] === undefined ? undefined : subscriberName(positionals[0]);
  const threads = listThreads(rt.openDb(), name);
  for (const thread of threads) rt.stdout(`${thread.subscriber}\t${thread.commitId}\n`);
  if (threads.length === 0) rt.stderr("no subscriptions\n");
  return 0;
}

function status(rt: Runtime): number {
  const db = rt.openDb();
  const heartbeat = getMeta(db, "poller_heartbeat");
  const warning = pollerWarning(db, rt.now());
  rt.stdout(`listening to: ${allowedAuthors(rt.env).map((u) => `@${u}`).join(", ")}\n`);
  rt.stdout(`posting as: @${botUser(rt.env)}\n`);
  rt.stdout(`messages stored: ${countMessages(db)}\n`);
  rt.stdout(`poller heartbeat: ${heartbeat ?? "never"}\n`);
  rt.stdout(`poller: ${warning === null ? "running" : `DOWN, ${warning}`}\n`);
  return warning === null ? 0 : 1;
}

async function poller(rt: Runtime): Promise<number> {
  const interval = Number(rt.env["BRIDGE_INTERVAL"] ?? "20");
  if (!Number.isFinite(interval) || interval < 5) {
    throw new UsageError("BRIDGE_INTERVAL is at least 5 seconds.");
  }

  await runPoller(rt, rt.openDb(), createApi(rt.fetch, baseUrl(rt.env)), {
    authors: allowedAuthors(rt.env),
    intervalMs: interval * 1000,
  });
  return 0;
}

/** Posts recorded before `reply` kept their text get it from the public API, by full id. */
async function backfill(rt: Runtime): Promise<number> {
  const db = rt.openDb();
  const api = createApi(rt.fetch, baseUrl(rt.env));
  const bot = botUser(rt.env);
  let filled = 0;
  let missing = 0;
  for (const id of postsMissingText(db)) {
    const commit = await getCommitPolitely(rt, api, id);
    if (commit === null || commit.author !== bot) {
      missing++;
      continue;
    }
    fillPost(db, id, commit.body, commit.htmlUrl);
    filled++;
  }
  rt.stdout(`filled ${filled} post(s)${missing === 0 ? "" : `, ${missing} not found`}\n`);
  return 0;
}

/** One lookup a second, waiting a minute when the site says to slow down (three tries). */
async function getCommitPolitely(rt: Runtime, api: Api, id: string): Promise<Message | null> {
  for (let attempt = 1;; attempt++) {
    await rt.sleep(1000);
    try {
      return await api.getCommit(id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 429) || attempt === 3) throw error;
      rt.stderr("rate limited, waiting a minute\n");
      await rt.sleep(60_000);
    }
  }
}

async function dashboard(rt: Runtime, args: string[]): Promise<number> {
  const parsed = parseArgs(args, ["port"]);
  const port = Number(flag(parsed, "port") ?? rt.env["BRIDGE_DASHBOARD_PORT"] ?? "8787");
  if (parsed.positionals.length > 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`usage: ${CLI_NAME} dashboard [--port 8787]`);
  }

  rt.stderr(`dashboard on http://127.0.0.1:${port}\n`);
  await rt.serve(
    port,
    dashboardHandler(rt.openDb(), () => rt.now(), {
      baseUrl: baseUrl(rt.env),
      botUser: botUser(rt.env),
    }),
  );
  return 0;
}
