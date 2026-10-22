/**
 * The server: one HTTP handler with two doors.
 *
 * - `/api/...` is for the CLI on each machine, with a bearer token. It does what the CLI used to
 *   do against a local sqlite file: watch, read, reply (which runs the commit script here, so only
 *   the server holds the bot's SSH key), and starting a login.
 * - Everything else is the web UI, for the people in BRIDGE_AUTHORS after a GitHub login: the
 *   dashboard, the tokens (revoke one there), and approving a `devnull-bridge login`.
 */
import { type Api, ApiError, createApi } from "./api.ts";
import {
  bearerToken,
  cookieHeader,
  githubAuthorizeUrl,
  githubLogin,
  type GitHubOAuth,
  newLoginCode,
  randomState,
  readCookie,
  SESSION_TTL_SECONDS,
  sha256Hex,
  signSession,
  verifySession,
} from "./auth.ts";
import { collectDashboard, collectThread, renderDashboard, renderThread } from "./dashboard.ts";
import {
  addTree,
  approveLogin,
  countMessages,
  countPendingLogins,
  type Db,
  deleteToken,
  exportData,
  findLogin,
  getMeta,
  importData,
  listThreads,
  listTokens,
  NotADatabase,
  readMessages,
  recordPost,
  removeTree,
  saveRoot,
  startLogin,
  useToken,
} from "./db.ts";
import { pollerWarning } from "./poller.ts";
import { keyOnGitHub, readBotKey } from "./botkey.ts";
import { postCommit } from "./post.ts";
import { resolveRef } from "./refs.ts";
import type { Runtime } from "./runtime.ts";
import { messageJson } from "./types.ts";
import {
  renderApprove,
  renderApproved,
  renderBotKey,
  renderData,
  renderImported,
  renderMessage,
  renderTokens,
} from "./web.ts";

export interface ServerConfig {
  /** Whose replies count, and who may use the web UI. */
  authors: string[];
  /** The account agents post as. */
  botUser: string;
  /** The dev-null.sh site. */
  devnullUrl: string;
  /** Where this server is reached, for links it hands out and the GitHub callback. */
  publicUrl: string;
  /** Null leaves the web UI closed (the API still works). */
  oauth: GitHubOAuth | null;
  sessionSecret: string;
}

/** An error whose message is meant for the caller, with the status to answer with. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const SESSION_COOKIE = "bridge_session";
const STATE_COOKIE = "bridge_oauth_state";
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // No page here is ever shown inside another site's frame (an Approve button, say).
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      ...headers,
    },
  });

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, ...headers } });

export function subscriberName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
    throw new HttpError(
      400,
      "A subscriber name is 1-40 letters, digits, dots, dashes or underscores.",
    );
  }
  return name;
}

function field(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new HttpError(400, `${name} is missing.`);
  return value;
}

/** Small JSON bodies only; anything bigger is refused before it is read into memory. */
const MAX_JSON_BYTES = 16 * 1024;
/** Three images and their text, with room for the multipart framing. */
const MAX_REPLY_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + 1024 * 1024;
/** The largest database file an import takes. */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const DATA_LINK = { href: "/data", text: "Back to Data" };
/** Login requests waiting for approval at once; more is someone filling the database. */
const MAX_PENDING_LOGINS = 50;

/** The body, read up to `max` bytes; a longer one is refused without reading the rest. */
async function limitedBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length") ?? 0) > max) {
    throw new HttpError(413, "That request is too large.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > max) throw new HttpError(413, "That request is too large.");
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await limitedBody(request, MAX_JSON_BYTES);
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Answered below.
  }
  throw new HttpError(400, "Send a JSON object.");
}

/** Only a path on this server, so a login can never be bounced to another site. */
function safeNext(next: string | null): string {
  if (next === null || !next.startsWith("/") || next[1] === "/" || next[1] === "\\") return "/";
  // Browsers also read `/\evil.com`, or a slash, tab, slash, as another host.
  const unsafe = [...next].some((c) => c === "\\" || c.charCodeAt(0) <= 0x20 || c === "\x7f");
  return unsafe ? "/" : next;
}

export function createServer(
  rt: Runtime,
  db: Db,
  config: ServerConfig,
): (request: Request) => Promise<Response> {
  const api: Api = createApi(rt.fetch, config.devnullUrl);
  const users = [...config.authors, config.botUser];
  const secure = config.publicUrl.startsWith("https://");
  const callbackUrl = `${config.publicUrl}/auth/callback`;
  const links = { baseUrl: config.devnullUrl, botUser: config.botUser };

  /** Errors about the commit are the caller's (400); the site failing to answer is not (502). */
  const resolve = async (ref: unknown) => {
    try {
      return await resolveRef(field(ref, "commit"), { db, api, users });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(error instanceof ApiError ? 502 : 400, message);
    }
  };
  const getCommit = async (id: string) => {
    try {
      return await api.getCommit(id);
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : String(error));
    }
  };

  async function apiRoute(request: Request, url: URL): Promise<Response> {
    const route = `${request.method} ${url.pathname}`;

    if (route === "POST /api/logins") {
      const body = await jsonBody(request);
      const label = field(body["label"], "label").slice(0, 100);
      const tokenHash = field(body["token_hash"], "token_hash");
      if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
        throw new HttpError(400, "token_hash is a SHA-256 in hex.");
      }
      if (countPendingLogins(db, rt.now()) >= MAX_PENDING_LOGINS) {
        throw new HttpError(429, "Too many logins are waiting for approval. Try again later.");
      }
      const code = newLoginCode();
      startLogin(db, { code, tokenHash, label, now: rt.now() });
      return Response.json({
        code,
        url: `${config.publicUrl}/approve?code=${encodeURIComponent(code)}`,
      });
    }

    const token = bearerToken(request);
    const machine = token === null ? null : useToken(db, await sha256Hex(token), rt.now());
    if (machine === null) {
      throw new HttpError(
        401,
        "Not logged in, or the token was revoked. Run: devnull-bridge login <server>",
      );
    }

    switch (route) {
      case "GET /api/whoami":
        return Response.json({ label: machine.label });

      case "GET /api/status": {
        const warning = pollerWarning(db, rt.now());
        return Response.json({
          listening_to: config.authors,
          posting_as: config.botUser,
          messages: countMessages(db),
          poller: { heartbeat: getMeta(db, "poller_heartbeat"), warning },
          machine: machine.label,
        });
      }

      case "POST /api/watch": {
        const body = await jsonBody(request);
        const name = subscriberName(body["name"]);
        const id = await resolve(body["commit"]);
        const root = await getCommit(id);
        if (root === null) {
          throw new HttpError(404, `There is no public commit ${id}. Is it still pending review?`);
        }
        saveRoot(db, root);
        addTree(db, name, id);
        const replies = readMessages(db, name).filter((message) => message.id !== id);
        return Response.json({
          messages: [root, ...replies].map(messageJson),
          warning: pollerWarning(db, rt.now()),
        });
      }

      case "POST /api/unwatch": {
        const body = await jsonBody(request);
        const name = subscriberName(body["name"]);
        const id = await resolve(body["commit"]);
        return Response.json({ id, removed: removeTree(db, name, id) });
      }

      case "GET /api/messages": {
        const name = subscriberName(url.searchParams.get("name"));
        const after = url.searchParams.get("after") ?? "";
        return Response.json({
          messages: readMessages(db, name, after === "0" ? "" : after).map(messageJson),
          warning: pollerWarning(db, rt.now()),
        });
      }

      case "GET /api/threads": {
        const name = url.searchParams.get("name");
        const threads = listThreads(db, name === null ? undefined : subscriberName(name));
        return Response.json({
          threads: threads.map((t) => ({ subscriber: t.subscriber, commit_id: t.commitId })),
        });
      }

      case "POST /api/reply":
        return await reply(request);
    }
    throw new HttpError(404, `No such API: ${route}`);
  }

  async function reply(request: Request): Promise<Response> {
    let form: FormData;
    try {
      const body = await limitedBody(request, MAX_REPLY_BYTES);
      form = await new Response(body, { headers: request.headers }).formData();
    } catch {
      throw new HttpError(400, "Send the reply as multipart/form-data.");
    }
    const name = subscriberName(form.get("name"));
    // Multipart encoding turns every newline in a text field into CRLF; the post keeps the LFs.
    const text = typeof form.get("text") === "string"
      ? String(form.get("text")).replaceAll("\r\n", "\n")
      : "";
    const images = form.getAll("image").filter((entry): entry is File => entry instanceof File);
    if (images.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images.`);
    for (const image of images) {
      if (IMAGE_TYPES[image.type] === undefined) {
        throw new HttpError(400, `${image.name} is not a JPEG, PNG or WebP image.`);
      }
      if (image.size > MAX_IMAGE_BYTES) throw new HttpError(400, `${image.name} is over 10 MB.`);
    }
    // The commit script needs a message: without one it would ask a terminal there is none of.
    if (text.trim() === "") throw new HttpError(400, "A reply needs text (images go with it).");
    const parentId = await resolve(form.get("commit"));

    // The commit script reads images from disk; they only live while it runs.
    const dir = await rt.makeTempDir();
    try {
      const paths: string[] = [];
      for (const [index, image] of images.entries()) {
        const path = `${dir}/image-${index + 1}.${IMAGE_TYPES[image.type]}`;
        await rt.writeFile(path, new Uint8Array(await image.arrayBuffer()));
        paths.push(path);
      }
      // The full id, not the short hash: dev-null.sh refuses a hash more than one commit ends with.
      const posted = await postCommit(rt, { replyTo: parentId, images: paths, text });
      recordPost(db, {
        id: posted.id,
        parentId,
        subscriber: name,
        createdAt: rt.now().toISOString(),
        body: text,
        htmlUrl: posted.url,
      });
      return Response.json({ id: posted.id, url: posted.url });
    } finally {
      await rt.removeDir(dir);
    }
  }

  async function sessionLogin(request: Request): Promise<string | null> {
    const cookie = readCookie(request, SESSION_COOKIE);
    if (cookie === null) return null;
    const login = await verifySession(cookie, config.sessionSecret, rt.now());
    return login !== null && config.authors.includes(login) ? login : null;
  }

  async function webRoute(request: Request, url: URL): Promise<Response> {
    if (config.oauth === null) {
      return html(
        renderMessage(
          "Web UI not set up",
          "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to log in here.",
        ),
        503,
      );
    }

    if (url.pathname === "/auth/login" && request.method === "GET") {
      const state = randomState();
      const next = safeNext(url.searchParams.get("next"));
      return redirect(githubAuthorizeUrl(config.oauth, callbackUrl, state), {
        "set-cookie": cookieHeader(STATE_COOKIE, `${state}.${encodeURIComponent(next)}`, {
          maxAge: 600,
          secure,
        }),
      });
    }

    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const saved = readCookie(request, STATE_COOKIE) ?? "";
      const dot = saved.indexOf(".");
      const state = dot === -1 ? "" : saved.slice(0, dot);
      const next = saved.slice(dot + 1);
      const code = url.searchParams.get("code");
      if (!state || state !== url.searchParams.get("state") || code === null) {
        return html(renderMessage("Login failed", "That login link expired. Try again."), 400);
      }
      const login = await githubLogin(rt.fetch, config.oauth, code, callbackUrl);
      if (!config.authors.includes(login)) {
        return html(renderMessage("Not allowed", `@${login} may not use this server.`), 403);
      }
      const expires = new Date(rt.now().getTime() + SESSION_TTL_SECONDS * 1000);
      const headers = new Headers({ location: safeNext(decodeURIComponent(next)) });
      headers.append(
        "set-cookie",
        cookieHeader(
          SESSION_COOKIE,
          await signSession(login, expires, config.sessionSecret),
          { maxAge: SESSION_TTL_SECONDS, secure },
        ),
      );
      headers.append("set-cookie", cookieHeader(STATE_COOKIE, "", { maxAge: 0, secure }));
      return new Response(null, { status: 303, headers });
    }

    const login = await sessionLogin(request);
    if (login === null) {
      if (request.method !== "GET") return html(renderMessage("Log in first", ""), 401);
      return redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }

    if (request.method === "POST") {
      // SameSite=Lax already keeps the cookie off cross-site POSTs; this is a second lock.
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== new URL(config.publicUrl).origin) {
        return html(renderMessage("Refused", "That form came from another site."), 403);
      }
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return redirect("/auth/signed-out", {
        "set-cookie": cookieHeader(SESSION_COOKIE, "", { maxAge: 0, secure }),
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return html(renderDashboard(collectDashboard(db, rt.now()), login));
    }
    if (url.pathname === "/state.json" && request.method === "GET") {
      return Response.json(collectDashboard(db, rt.now()), {
        headers: { "cache-control": "no-store" },
      });
    }

    const threadMatch = url.pathname.match(/^\/threads\/([^/]+)\/([^/]+)$/);
    if (threadMatch !== null && request.method === "GET") {
      const thread = collectThread(
        db,
        decodeURIComponent(threadMatch[1]!),
        decodeURIComponent(threadMatch[2]!),
        links,
      );
      if (thread === null) return html(renderMessage("No such thread", ""), 404);
      return html(renderThread(thread, login));
    }

    if (url.pathname === "/tokens" && request.method === "GET") {
      return html(renderTokens(listTokens(db), login));
    }
    const revokeMatch = url.pathname.match(/^\/tokens\/([^/]+)\/revoke$/);
    if (revokeMatch !== null && request.method === "POST") {
      deleteToken(db, decodeURIComponent(revokeMatch[1]!));
      return redirect("/tokens");
    }

    if (url.pathname === "/bot-key" && request.method === "GET") {
      const publicKey = await readBotKey(rt);
      const onGitHub = publicKey === null ? null : await keyOnGitHub(rt, config.botUser, publicKey);
      return html(renderBotKey(config.botUser, publicKey, onGitHub, login));
    }

    if (url.pathname === "/data" && request.method === "GET") {
      return html(renderData(login));
    }
    if (url.pathname === "/data/export" && request.method === "GET") {
      const date = rt.now().toISOString().slice(0, 10);
      return new Response(exportData(db), {
        headers: {
          "content-type": "application/vnd.sqlite3",
          "content-disposition": `attachment; filename="bridge-${date}.db"`,
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/data/import" && request.method === "POST") {
      let file: FormDataEntryValue | null;
      try {
        const body = await limitedBody(request, MAX_IMPORT_BYTES);
        file = (await new Response(body, { headers: request.headers }).formData()).get("file");
      } catch (error) {
        if (error instanceof HttpError) throw error;
        file = null;
      }
      if (!(file instanceof File) || file.size === 0) {
        return html(renderMessage("No file", "Choose a .db file to import.", DATA_LINK), 400);
      }
      try {
        const counts = importData(db, new Uint8Array(await file.arrayBuffer()));
        return html(renderImported(counts, login));
      } catch (error) {
        if (!(error instanceof NotADatabase)) throw error;
        return html(renderMessage("Not imported", error.message, DATA_LINK), 400);
      }
    }

    if (url.pathname === "/approve") {
      const code = request.method === "POST"
        ? String(
          new URLSearchParams(
            new TextDecoder().decode(await limitedBody(request, MAX_JSON_BYTES)),
          ).get("code") ?? "",
        )
        : url.searchParams.get("code") ?? "";
      if (request.method === "POST") {
        return approveLogin(db, code, login, rt.now())
          ? html(renderApproved(login))
          : html(renderMessage("Expired", "Run devnull-bridge login again."), 404);
      }
      const pending = findLogin(db, code, rt.now());
      if (pending === null) {
        return html(renderMessage("Expired", "Run devnull-bridge login again."), 404);
      }
      return html(renderApprove(code, pending, login));
    }

    return html(renderMessage("Not found", ""), 404);
  }

  return async (request) => {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname === "/auth/signed-out") {
        return html(renderMessage("Signed out", "", { href: "/", text: "Log in again" }));
      }
      if (url.pathname.startsWith("/api/")) return await apiRoute(request, url);
      return await webRoute(request, url);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 500) {
        rt.stderr(`${rt.now().toISOString()} ${request.method} ${url.pathname}: ${message}\n`);
      }
      if (url.pathname.startsWith("/api/")) return Response.json({ error: message }, { status });
      return html(renderMessage("Something went wrong", ""), status);
    }
  };
}
