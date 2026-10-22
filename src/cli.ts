/**
 * The server's own commands. Every external effect goes through {@link Runtime}.
 */
import { type Api, ApiError, createApi } from "./api.ts";
import { ensureBotKey } from "./botkey.ts";
import { fillPost, postsMissingText } from "./db.ts";
import { runPoller } from "./poller.ts";
import { allowedAuthors, baseUrl, botUser, type Runtime } from "./runtime.ts";
import { createServer, type ServerConfig } from "./server.ts";
import type { Message } from "./types.ts";

const NAME = "devnull-bridge-server";

const HELP = `${NAME} — the central half of dev-null-bridge: polls dev-null.sh, keeps the
sqlite file, posts as the bot, and serves the CLI's API and the web UI

Usage:
  ${NAME} serve       Run the poller and the HTTP server
  ${NAME} backfill    Fetch the text of agent posts recorded before replies kept it

Config (environment):
  BRIDGE_DB              sqlite file (default: ~/.local/share/dev-null-bridge/bridge.db); the
                         bot's SSH key is made on first start next to it, in bot/.ssh/
  BRIDGE_AUTHORS         comma-separated usernames whose replies count and who may use the web UI
                         (default: dtinth)
  BRIDGE_BOT_USER        the account agents post as (default: dtinth-bot)
  BRIDGE_INTERVAL        seconds between polls (default: 20)
  BRIDGE_COMMIT_SCRIPT   use this commit script instead of downloading one
  BRIDGE_PUBLIC_URL      where the server is reached (default: http://localhost:<port>)
  BRIDGE_SESSION_SECRET  signs web sessions (32+ characters; required with GitHub login)
  GITHUB_CLIENT_ID       a GitHub OAuth app, for the web UI's login
  GITHUB_CLIENT_SECRET
  PORT                   port to listen on (default: 8787)
  BRIDGE_HOSTNAME        address to listen on (default: 0.0.0.0)
  DEVNULL_URL            the site (default: https://dev-null.sh)
`;

class UsageError extends Error {}

export async function runCli(argv: string[], rt: Runtime): Promise<number> {
  const [command, ...args] = argv;

  try {
    if (args.length > 0) throw new UsageError(`${command} takes no arguments.`);
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        rt.stdout(HELP);
        return 0;
      case "serve":
        return await serve(rt);
      case "backfill":
        return await backfill(rt);
      default:
        throw new UsageError(`Unknown command ${command}. Try ${NAME} help.`);
    }
  } catch (error) {
    rt.stderr(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

export function serverConfig(env: Record<string, string>, port: number): ServerConfig {
  const clientId = env["GITHUB_CLIENT_ID"] ?? "";
  const clientSecret = env["GITHUB_CLIENT_SECRET"] ?? "";
  const sessionSecret = env["BRIDGE_SESSION_SECRET"] ?? "";
  if ((clientId === "") !== (clientSecret === "")) {
    throw new UsageError("Set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither.");
  }
  if (clientId !== "" && sessionSecret.length < 32) {
    throw new UsageError("BRIDGE_SESSION_SECRET must be at least 32 characters.");
  }

  return {
    authors: allowedAuthors(env),
    botUser: botUser(env),
    devnullUrl: baseUrl(env),
    publicUrl: (env["BRIDGE_PUBLIC_URL"] ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    oauth: clientId === "" ? null : { clientId, clientSecret },
    sessionSecret,
  };
}

async function serve(rt: Runtime): Promise<number> {
  const interval = Number(rt.env["BRIDGE_INTERVAL"] ?? "20");
  if (!Number.isFinite(interval) || interval < 5) {
    throw new UsageError("BRIDGE_INTERVAL is at least 5 seconds.");
  }
  const port = Number(rt.env["PORT"] ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError("PORT is a port number.");
  }
  const hostname = rt.env["BRIDGE_HOSTNAME"] ?? "0.0.0.0";
  const config = serverConfig(rt.env, port);
  const publicKey = await ensureBotKey(rt, config.botUser);
  if (rt.env["BRIDGE_SSH_PRIVATE_KEY"] !== undefined) {
    rt.stderr(
      "BRIDGE_SSH_PRIVATE_KEY is no longer read: the server signs with its own key (see Bot key in " +
        "the web UI). To keep an old key, put it at bot/.ssh/id_ed25519 next to the database.\n",
    );
  }
  const db = rt.openDb();

  rt.stderr(`serving on http://${hostname}:${port} as ${config.publicUrl}\n`);
  rt.stderr(`posting as @${config.botUser} with ${publicKey}\n`);
  if (config.oauth === null) rt.stderr("no GitHub OAuth app set: the web UI is closed\n");
  await Promise.all([
    runPoller(rt, db, createApi(rt.fetch, config.devnullUrl), {
      authors: config.authors,
      intervalMs: interval * 1000,
    }),
    rt.serve(port, hostname, createServer(rt, db, config)),
  ]);
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
