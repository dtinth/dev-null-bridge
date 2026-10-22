/**
 * The dashboard: a page listing every subscriber, how many commits each follows, and the threads
 * those make up, with a page per thread showing what was said in it. Everything comes from the
 * server's sqlite file.
 */
import { countMessages, type Db, getMeta, listThreads, readTree, type TreeRow } from "./db.ts";
import { STALE_POLLER_MS } from "./poller.ts";
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

export interface Links {
  baseUrl: string;
  botUser: string;
}

const DEFAULT_LINKS: Links = { baseUrl: "https://dev-null.sh", botUser: "dtinth-bot" };

export interface ThreadEntry {
  id: string;
  shortHash: string;
  /** The commit it replies to, inside this thread; null for the first commit. */
  parentId: string | null;
  author: string | null;
  body: string | null;
  url: string;
  createdAt: string | null;
  images: string[];
  /** The subscriber whose `reply` posted it, for an agent's post. */
  postedBy: string | null;
  followed: boolean;
}

export interface ThreadData {
  subscriber: string;
  rootId: string;
  shortHash: string;
  entries: ThreadEntry[];
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

const STYLE =
  `  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --ink: #1c1c1a; --muted: #6b6b66; --line: #e3e3de; --ok: #1a7f46; --bad: #b3261e; --accent: #3a5ccc; }
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
  .hash code { color: var(--accent); }
  .back { display: inline-block; margin: 0 0 12px; }
  .entry { position: relative; padding: 10px 0 10px 14px; border-top: 1px solid var(--line); }
  .entry:first-child { border-top: 0; padding-top: 0; }
  .entry.unfollowed { opacity: .55; }
  .entry .who { font-weight: 600; }
  .entry .who.bot { color: var(--accent); }
  .entry .when { color: var(--muted); font-size: 13px; }
  .entry .body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0 0; }
  .entry .note { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
  .entry .images a { font-size: 13px; margin-right: 10px; }
  nav { display: flex; gap: 14px; align-items: baseline; margin: 0 0 18px; font-size: 14px; }
  nav .who { margin-left: auto; color: var(--muted); }
  nav form { display: inline; }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .code { font: 600 24px ui-monospace, monospace; letter-spacing: .08em; margin: 8px 0 12px; }
`;

/**
 * One thread as a subscriber sees it: the commit it started from and everything known under it,
 * depth first, oldest reply first. Null when the subscriber does not follow that commit.
 */
export function collectThread(
  db: Db,
  subscriber: string,
  rootId: string,
  links: Links = DEFAULT_LINKS,
): ThreadData | null {
  const rows = readTree(db, subscriber, rootId);
  if (!rows.some((row) => row.id === rootId && row.followed)) return null;

  const children = new Map<string | null, TreeRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentId) ?? [];
    siblings.push(row);
    children.set(row.parentId, siblings);
  }

  const entries: ThreadEntry[] = [];
  const visit = (row: TreeRow) => {
    const author = row.kind === "post" ? links.botUser : row.author;
    entries.push({
      id: row.id,
      shortHash: shortHashOf(row.id),
      parentId: row.parentId,
      author,
      body: row.body,
      url: row.htmlUrl ?? `${links.baseUrl}/@${author ?? links.botUser}/commits/${row.id}`,
      createdAt: row.createdAt,
      images: row.images,
      postedBy: row.postedBy,
      followed: row.followed,
    });
    for (const child of children.get(row.id) ?? []) visit(child);
  };
  for (const row of children.get(null) ?? []) visit(row);

  return { subscriber, rootId, shortHash: shortHashOf(rootId), entries };
}

export function threadPath(subscriber: string, rootId: string): string {
  return `/threads/${encodeURIComponent(subscriber)}/${encodeURIComponent(rootId)}`;
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Only http(s) links are ever made clickable. */
export function link(url: string | null, text: string): string {
  if (url === null || !/^https?:\/\//.test(url)) return escapeHtml(text);
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function renderDashboard(data: DashboardData, login: string): string {
  const poller = data.poller;
  const pollerText = poller.heartbeat === null
    ? "never ran"
    : poller.running
    ? `running, last poll ${poller.ageSeconds}s ago`
    : `down, last poll ${poller.ageSeconds}s ago`;

  const cards = data.subscribers.map((subscriber) => {
    const threads = subscriber.threads.map((thread) => `
        <li>
          <a class="hash" href="${threadPath(subscriber.name, thread.rootId)}"><code>${
      escapeHtml(thread.shortHash)
    }</code></a>
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

  return page(
    "dev-null-bridge",
    `  <h1>dev-null-bridge</h1>
  <p class="status"><span class="dot${poller.running ? " ok" : ""}"></span>poller ${
      escapeHtml(pollerText)
    } · ${plural(data.messages, "message")} stored · ${
      plural(data.subscribers.length, "subscriber")
    }</p>${
      cards === ""
        ? '\n  <p class="empty">No subscriptions yet. Run <code>devnull-bridge watch &lt;name&gt; &lt;commit&gt;</code>.</p>'
        : cards
    }`,
    { login, refresh: true },
  );
}

/** A whole page; with a login, it has the nav bar of the signed-in UI. */
export function page(
  title: string,
  body: string,
  options: { login?: string; refresh?: boolean } = {},
): string {
  const nav = options.login === undefined ? "" : `  <nav>
    <a href="/">Subscriptions</a>
    <a href="/tokens">Tokens</a>
    <span class="who">@${escapeHtml(options.login)}</span>
    <form method="post" action="/auth/logout"><button>Log out</button></form>
  </nav>
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${
    options.refresh ? '\n<meta http-equiv="refresh" content="5">' : ""
  }
<title>${escapeHtml(title)}</title>
<style>
${STYLE}</style>
</head>
<body>
<main>
${nav}${body}
</main>
</body>
</html>
`;
}

export function renderThread(thread: ThreadData, login: string): string {
  const entries = thread.entries.map((entry, index) => {
    const previous = thread.entries[index - 1];
    // A thread is shown flat; a reply that does not follow the commit above it says what it answers.
    const branch = entry.parentId === null || entry.parentId === previous?.id
      ? ""
      : ` · ↳ ${escapeHtml(shortHashOf(entry.parentId))}`;
    const who = entry.author === null ? "unknown" : `@${entry.author}`;
    const by = entry.postedBy === null
      ? ""
      : ` <span class="when">via ${escapeHtml(entry.postedBy)}</span>`;
    const body = entry.body === null
      ? `<p class="note">${
        entry.postedBy === null ? "Not stored." : "Posted before the bridge kept agents' text."
      }</p>`
      : `<p class="body">${escapeHtml(entry.body)}</p>`;
    const images = entry.images.length === 0
      ? ""
      : `<p class="images">${
        entry.images.map((image, index) => link(image, `image ${index + 1}`)).join("")
      }</p>`;
    return `
    <article class="entry${entry.followed ? "" : " unfollowed"}">
      <span class="who${entry.postedBy === null ? "" : " bot"}">${escapeHtml(who)}</span>${by}
      <span class="when">· ${link(entry.url, entry.shortHash)}${
      entry.createdAt === null ? "" : ` · ${escapeHtml(entry.createdAt)}`
    }${branch}${entry.followed ? "" : " · not followed"}</span>${body}${images}
    </article>`;
  }).join("");

  return page(
    `${thread.shortHash} · ${thread.subscriber} · dev-null-bridge`,
    `  <a class="back" href="/">← all subscriptions</a>
  <h1>Thread <code>${escapeHtml(thread.shortHash)}</code></h1>
  <p class="status">as seen by <code>${escapeHtml(thread.subscriber)}</code> · ${
      plural(thread.entries.length, "commit")
    }</p>
  <section class="card">${entries}
  </section>`,
    { login },
  );
}
