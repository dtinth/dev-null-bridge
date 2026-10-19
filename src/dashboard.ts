/**
 * `dashboard`: a read-only page on 127.0.0.1 listing every subscriber, how many commits each
 * follows, and the threads those make up. Everything comes from the sqlite file the agents share.
 */
import { countMessages, type Db, getMeta, listThreads } from "./db.ts";
import { STALE_POLLER_MS } from "./longpoll.ts";
import { shortHashOf } from "./refs.ts";

export interface ThreadInfo {
  rootId: string;
  shortHash: string;
  author: string | null;
  excerpt: string | null;
  url: string | null;
  /** Commits followed in this thread, the root included. */
  commits: number;
}

export interface SubscriberInfo {
  name: string;
  /** Every commit id the subscriber follows: the number a reply to one of them is matched against. */
  commits: number;
  threads: ThreadInfo[];
  /** Messages from dtinth the subscriber has been given. */
  delivered: number;
  lastMessageAt: string | null;
}

export interface DashboardData {
  generatedAt: string;
  poller: { heartbeat: string | null; ageSeconds: number | null; running: boolean };
  messages: number;
  subscribers: SubscriberInfo[];
}

function number(row: Record<string, unknown> | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

function excerpt(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function collectDashboard(db: Db, now: Date): DashboardData {
  const heartbeat = getMeta(db, "poller_heartbeat");
  const age = heartbeat === null ? null : now.getTime() - Date.parse(heartbeat);

  const subscribers = db.prepare(
    "SELECT subscriber, COUNT(*) AS commits FROM subscriptions GROUP BY subscriber ORDER BY subscriber",
  ).all().map((row): SubscriberInfo => {
    const name = String(row["subscriber"]);

    const threads = listThreads(db, name).map((thread): ThreadInfo => {
      const root = db.prepare("SELECT author, body, html_url FROM roots WHERE id = ?").get(
        thread.commitId,
      );
      const size = db.prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT ? UNION SELECT e.id FROM edges e JOIN tree t ON e.parent_id = t.id
         )
         SELECT COUNT(*) AS n FROM tree
         WHERE id IN (SELECT commit_id FROM subscriptions WHERE subscriber = ?)`,
      ).get(thread.commitId, name);
      return {
        rootId: thread.commitId,
        shortHash: shortHashOf(thread.commitId),
        author: root === undefined ? null : String(root["author"]),
        excerpt: root === undefined ? null : excerpt(String(root["body"])),
        url: root === undefined ? null : String(root["html_url"]),
        commits: number(size, "n"),
      };
    });

    const delivered = db.prepare(
      `SELECT COUNT(*) AS n, MAX(m.created_at) AS last FROM messages m
       JOIN subscriptions s ON s.commit_id = m.id AND s.subscriber = ?`,
    ).get(name);

    return {
      name,
      commits: number(row, "commits"),
      threads,
      delivered: number(delivered, "n"),
      lastMessageAt: delivered?.["last"] === null || delivered === undefined
        ? null
        : String(delivered["last"]),
    };
  });

  return {
    generatedAt: now.toISOString(),
    poller: {
      heartbeat,
      ageSeconds: age === null ? null : Math.round(age / 1000),
      running: age !== null && age <= STALE_POLLER_MS,
    },
    messages: countMessages(db),
    subscribers,
  };
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Only http(s) links are ever made clickable. */
function link(url: string | null, text: string): string {
  if (url === null || !/^https?:\/\//.test(url)) return escapeHtml(text);
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function renderDashboard(data: DashboardData): string {
  const poller = data.poller;
  const pollerText = poller.heartbeat === null
    ? "never ran"
    : poller.running
    ? `running, last poll ${poller.ageSeconds}s ago`
    : `down, last poll ${poller.ageSeconds}s ago`;

  const cards = data.subscribers.map((subscriber) => {
    const threads = subscriber.threads.map((thread) => `
        <li>
          <code>${escapeHtml(thread.shortHash)}</code>
          <span class="excerpt">${
      thread.excerpt === null ? "<em>no preview</em>" : link(thread.url, thread.excerpt)
    }</span>
          <span class="count">${plural(thread.commits, "commit")}</span>
        </li>`).join("");

    return `
      <section class="card">
        <header>
          <h2>${escapeHtml(subscriber.name)}</h2>
          <p class="big">${subscriber.commits}<span> commit ids followed</span></p>
        </header>
        <p class="meta">${plural(subscriber.threads.length, "thread")} · ${
      plural(subscriber.delivered, "message")
    } delivered${
      subscriber.lastMessageAt === null ? "" : `, last ${escapeHtml(subscriber.lastMessageAt)}`
    }</p>
        <ul>${threads}</ul>
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>dev-null-bridge</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --ink: #1c1c1a; --muted: #6b6b66; --line: #e3e3de; --ok: #1a7f46; --bad: #b3261e; --accent: #3a5ccc; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1f1d; --ink: #ececE8; --muted: #9a9a93; --line: #33332f; --ok: #55c28a; --bad: #f2877f; --accent: #8da4f5; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .status { color: var(--muted); margin: 0 0 20px; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; background: var(--bad); }
  .dot.ok { background: var(--ok); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 0 0 14px; }
  .card header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  h2 { font-size: 17px; margin: 0; font-family: ui-monospace, monospace; }
  .big { font-size: 28px; font-weight: 650; margin: 0; }
  .big span { font-size: 13px; font-weight: 400; color: var(--muted); }
  .meta { color: var(--muted); margin: 2px 0 10px; font-size: 13px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--line); }
  code { font: 13px ui-monospace, monospace; color: var(--muted); }
  .excerpt { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .count { color: var(--muted); font-size: 13px; white-space: nowrap; }
  a { color: var(--accent); }
  .empty { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>dev-null-bridge</h1>
  <p class="status"><span class="dot${poller.running ? " ok" : ""}"></span>poller ${
    escapeHtml(pollerText)
  } · ${plural(data.messages, "message")} stored · ${
    plural(data.subscribers.length, "subscriber")
  }</p>${
    cards === ""
      ? '\n  <p class="empty">No subscriptions yet. Run <code>devnull-bridge watch &lt;name&gt; &lt;commit&gt;</code>.</p>'
      : cards
  }
</main>
</body>
</html>
`;
}

export function dashboardHandler(db: Db, now: () => Date): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

    if (url.pathname === "/") {
      return new Response(renderDashboard(collectDashboard(db, now())), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/state.json") {
      return Response.json(collectDashboard(db, now()), {
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}
