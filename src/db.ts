/**
 * The bridge's sqlite store, shared by the poller and every agent session (WAL mode, so one
 * writer and many readers get along).
 *
 * - `messages`: every reply by an allowed author the poller has seen.
 * - `posts`: the commits agents posted through `reply`, so a thread can pass through them, with
 *   their text and URL (kept for the dashboard; posts recorded before that have neither).
 * - `subscriptions`: `(subscriber, commit_id)`. A subscriber receives a message when the message's
 *   own id is in its set; the poller adds each new message whose parent is in the set, and `reply`
 *   adds the commit it posts. A watch is therefore a filter over what is stored: watching a commit
 *   adds the whole known tree under it.
 * - `tokens`: the machines allowed to use the API, by the SHA-256 of their token (never the token).
 * - `logins`: `devnull-bridge login` requests waiting for a person to approve them in the browser.
 */
import { DatabaseSync } from "node:sqlite";
import type { Message } from "./types.ts";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  short_hash TEXT NOT NULL,
  parent_id TEXT,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  images TEXT NOT NULL,
  html_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_parent ON messages (parent_id);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  subscriber TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body TEXT,
  html_url TEXT
);
CREATE INDEX IF NOT EXISTS posts_parent ON posts (parent_id);
CREATE TABLE IF NOT EXISTS subscriptions (
  subscriber TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  PRIMARY KEY (subscriber, commit_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_commit ON subscriptions (commit_id);
CREATE TABLE IF NOT EXISTS roots (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  html_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS logins (
  code TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logins_created ON logins (created_at);
CREATE VIEW IF NOT EXISTS edges AS
  SELECT id, parent_id FROM messages WHERE parent_id IS NOT NULL
  UNION
  SELECT id, parent_id FROM posts;
`;

export function openDbAt(path: string): Db {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  addMissingColumns(db, "posts", ["body TEXT", "html_url TEXT"]);
  return db;
}

/** Brings a table created by an older version up to date. */
function addMissingColumns(db: Db, table: string, columns: string[]): void {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row["name"])),
  );
  for (const column of columns) {
    if (!existing.has(column.split(" ")[0]!)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
}

function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function compareIds(a: Message, b: Message): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Stores messages not seen before, oldest first (ids are UUIDv7, so they sort by time), and gives
 * each new one to every subscriber that has its parent. Returns how many were new.
 */
export function ingest(db: Db, messages: Message[]): number {
  let added = 0;
  inTransaction(db, () => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO messages (id, short_hash, parent_id, author, body, images, html_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const propagate = db.prepare(
      "INSERT OR IGNORE INTO subscriptions (subscriber, commit_id) SELECT subscriber, ? FROM subscriptions WHERE commit_id = ?",
    );
    for (const message of [...messages].sort(compareIds)) {
      const result = insert.run(
        message.id,
        message.shortHash,
        message.parentId,
        message.author,
        message.body,
        JSON.stringify(message.images),
        message.htmlUrl,
        message.createdAt,
      );
      if (Number(result.changes) === 0) continue;
      added++;
      if (message.parentId !== null) propagate.run(message.id, message.parentId);
    }
  });
  return added;
}

/** Subscribes to a commit and everything already known under it. Returns how many ids were new. */
export function addTree(db: Db, subscriber: string, rootId: string): number {
  const before = countSubscriptions(db, subscriber);
  db.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT ? UNION SELECT e.id FROM edges e JOIN tree t ON e.parent_id = t.id
     )
     INSERT OR IGNORE INTO subscriptions (subscriber, commit_id) SELECT ?, id FROM tree`,
  ).run(rootId, subscriber);
  return countSubscriptions(db, subscriber) - before;
}

/** Unsubscribes from a commit and everything known under it. Returns how many ids were removed. */
export function removeTree(db: Db, subscriber: string, rootId: string): number {
  const before = countSubscriptions(db, subscriber);
  db.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT ? UNION SELECT e.id FROM edges e JOIN tree t ON e.parent_id = t.id
     )
     DELETE FROM subscriptions WHERE subscriber = ? AND commit_id IN (SELECT id FROM tree)`,
  ).run(rootId, subscriber);
  return before - countSubscriptions(db, subscriber);
}

/**
 * Records a commit an agent posted: every subscriber that has the parent gets it (so a second agent
 * in the thread still sees the replies to it), and so does the poster. The poster's tree is walked
 * too, in case a reply to the new commit was ingested before this ran.
 */
export function recordPost(
  db: Db,
  post: {
    id: string;
    parentId: string;
    subscriber: string;
    createdAt: string;
    body?: string;
    htmlUrl?: string;
  },
): void {
  inTransaction(db, () => {
    db.prepare(
      "INSERT OR IGNORE INTO posts (id, parent_id, subscriber, created_at, body, html_url) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .run(
        post.id,
        post.parentId,
        post.subscriber,
        post.createdAt,
        post.body ?? null,
        post.htmlUrl ?? null,
      );
    db.prepare(
      "INSERT OR IGNORE INTO subscriptions (subscriber, commit_id) SELECT subscriber, ? FROM subscriptions WHERE commit_id = ?",
    ).run(post.id, post.parentId);
    addTree(db, post.subscriber, post.id);
  });
}

/** Agent posts recorded without their text (before `reply` kept it), oldest first. */
export function postsMissingText(db: Db): string[] {
  return db.prepare("SELECT id FROM posts WHERE body IS NULL ORDER BY id").all()
    .map((row) => String(row["id"]));
}

export function fillPost(db: Db, id: string, body: string, htmlUrl: string): void {
  db.prepare("UPDATE posts SET body = ?, html_url = ? WHERE id = ?").run(body, htmlUrl, id);
}

function countSubscriptions(db: Db, subscriber: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE subscriber = ?").get(
    subscriber,
  );
  return Number(row?.["n"] ?? 0);
}

function toMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row["id"]),
    shortHash: String(row["short_hash"]),
    parentId: row["parent_id"] === null ? null : String(row["parent_id"]),
    author: String(row["author"]),
    body: String(row["body"]),
    images: JSON.parse(String(row["images"])) as string[],
    htmlUrl: String(row["html_url"]),
    createdAt: String(row["created_at"]),
  };
}

/** The messages a subscriber has been given, oldest first, optionally only those after an id. */
export function readMessages(db: Db, subscriber: string, after?: string): Message[] {
  const rows = db.prepare(
    `SELECT m.* FROM messages m
     JOIN subscriptions s ON s.commit_id = m.id AND s.subscriber = ?
     WHERE m.id > ? ORDER BY m.id`,
  ).all(subscriber, after ?? "");
  return rows.map(toMessage);
}

/** The threads a subscriber follows: its subscribed commits whose parent it does not follow. */
export function listThreads(
  db: Db,
  subscriber?: string,
): { subscriber: string; commitId: string }[] {
  const rows = db.prepare(
    `SELECT s.subscriber, s.commit_id FROM subscriptions s
     WHERE (? IS NULL OR s.subscriber = ?)
       AND NOT EXISTS (
         SELECT 1 FROM edges e JOIN subscriptions p
           ON p.commit_id = e.parent_id AND p.subscriber = s.subscriber
         WHERE e.id = s.commit_id)
     ORDER BY s.subscriber, s.commit_id`,
  ).all(subscriber ?? null, subscriber ?? null);
  return rows.map((row) => ({
    subscriber: String(row["subscriber"]),
    commitId: String(row["commit_id"]),
  }));
}

export interface TreeRow {
  id: string;
  parentId: string | null;
  /** What is stored about the commit: a reply by an allowed author, an agent's post, or a watched root. */
  kind: "message" | "post" | "root" | "unknown";
  author: string | null;
  body: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
  images: string[];
  /** The subscriber whose `reply` posted it (posts only). */
  postedBy: string | null;
  /** Whether the given subscriber follows it. */
  followed: boolean;
}

/** A commit and everything known under it, in id (time) order, as seen by one subscriber. */
export function readTree(db: Db, subscriber: string, rootId: string): TreeRow[] {
  const rows = db.prepare(
    `WITH RECURSIVE tree(id, parent_id) AS (
       SELECT ?, NULL UNION SELECT e.id, e.parent_id FROM edges e JOIN tree t ON e.parent_id = t.id
     )
     SELECT t.id, t.parent_id,
       m.id IS NOT NULL AS is_message, p.id IS NOT NULL AS is_post, r.id IS NOT NULL AS is_root,
       COALESCE(m.author, r.author) AS author,
       COALESCE(m.body, p.body, r.body) AS body,
       COALESCE(m.html_url, p.html_url, r.html_url) AS html_url,
       COALESCE(m.created_at, p.created_at, r.created_at) AS created_at,
       m.images, p.subscriber AS posted_by,
       EXISTS (SELECT 1 FROM subscriptions s WHERE s.subscriber = ? AND s.commit_id = t.id)
         AS followed
     FROM tree t
     LEFT JOIN messages m ON m.id = t.id
     LEFT JOIN posts p ON p.id = t.id
     LEFT JOIN roots r ON r.id = t.id
     ORDER BY t.id`,
  ).all(rootId, subscriber);
  return rows.map((row): TreeRow => {
    const text = (key: string) => (row[key] === null ? null : String(row[key]));
    return {
      id: String(row["id"]),
      parentId: row["id"] === rootId ? null : text("parent_id"),
      kind: Number(row["is_message"])
        ? "message"
        : Number(row["is_post"])
        ? "post"
        : Number(row["is_root"])
        ? "root"
        : "unknown",
      author: text("author"),
      body: text("body"),
      htmlUrl: text("html_url"),
      createdAt: text("created_at"),
      images: row["images"] === null ? [] : JSON.parse(String(row["images"])) as string[],
      postedBy: text("posted_by"),
      followed: Number(row["followed"]) === 1,
    };
  });
}

/** Ids of stored commits (messages and agent posts) whose short hash is the given one. */
export function findIdsByShortHash(db: Db, shortHash: string): string[] {
  const rows = db.prepare(
    `SELECT id FROM messages WHERE short_hash = ?
     UNION SELECT id FROM posts WHERE substr(replace(id, '-', ''), -7) = ?`,
  ).all(shortHash, shortHash);
  return rows.map((row) => String(row["id"]));
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .run(key, value);
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row === undefined ? null : String(row["value"]);
}

export function countMessages(db: Db): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.["n"] ?? 0);
}

/** Remembers the commit a watch started from, so the dashboard can say what the thread is about. */
export function saveRoot(db: Db, root: Message): void {
  db.prepare(
    "INSERT OR REPLACE INTO roots (id, author, body, html_url, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(root.id, root.author, root.body, root.htmlUrl, root.createdAt);
}

/** How long a login request waits for approval. */
export const LOGIN_TTL_MS = 10 * 60_000;

export interface TokenInfo {
  id: string;
  label: string;
  approvedBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function toTokenInfo(row: Record<string, unknown>): TokenInfo {
  return {
    id: String(row["id"]),
    label: String(row["label"]),
    approvedBy: String(row["approved_by"]),
    createdAt: String(row["created_at"]),
    lastUsedAt: row["last_used_at"] === null ? null : String(row["last_used_at"]),
  };
}

/** Records a login request; requests older than {@link LOGIN_TTL_MS} are dropped first. */
export function startLogin(
  db: Db,
  login: { code: string; tokenHash: string; label: string; now: Date },
): void {
  db.prepare("DELETE FROM logins WHERE created_at < ?").run(
    new Date(login.now.getTime() - LOGIN_TTL_MS).toISOString(),
  );
  // Asking again with the same token replaces the earlier request.
  db.prepare(
    "INSERT OR REPLACE INTO logins (code, token_hash, label, created_at) VALUES (?, ?, ?, ?)",
  )
    .run(login.code, login.tokenHash, login.label, login.now.toISOString());
}

/** How many login requests are still waiting for approval. */
export function countPendingLogins(db: Db, now: Date): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM logins WHERE created_at >= ?").get(
    new Date(now.getTime() - LOGIN_TTL_MS).toISOString(),
  );
  return Number(row?.["n"] ?? 0);
}

/** A login request still waiting for approval, or null. */
export function findLogin(
  db: Db,
  code: string,
  now: Date,
): { label: string; createdAt: string } | null {
  const row = db.prepare("SELECT label, created_at FROM logins WHERE code = ? AND created_at >= ?")
    .get(code, new Date(now.getTime() - LOGIN_TTL_MS).toISOString());
  return row === undefined
    ? null
    : { label: String(row["label"]), createdAt: String(row["created_at"]) };
}

/** Turns a waiting login into a token. False when there is no such request (or it expired). */
export function approveLogin(db: Db, code: string, approvedBy: string, now: Date): boolean {
  return inTransaction(db, () => {
    const row = db.prepare(
      "SELECT token_hash, label FROM logins WHERE code = ? AND created_at >= ?",
    ).get(code, new Date(now.getTime() - LOGIN_TTL_MS).toISOString());
    if (row === undefined) return false;
    db.prepare("DELETE FROM logins WHERE code = ?").run(code);
    db.prepare(
      "INSERT INTO tokens (id, hash, label, approved_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      String(row["token_hash"]),
      String(row["label"]),
      approvedBy,
      now.toISOString(),
    );
    return true;
  });
}

/** The token with this hash, marked as used now, or null when there is none. */
export function useToken(db: Db, hash: string, now: Date): TokenInfo | null {
  const row = db.prepare("SELECT * FROM tokens WHERE hash = ?").get(hash);
  if (row === undefined) return null;
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE hash = ?").run(now.toISOString(), hash);
  return toTokenInfo(row);
}

/** Every token, newest first. */
export function listTokens(db: Db): TokenInfo[] {
  return db.prepare("SELECT * FROM tokens ORDER BY created_at DESC, id").all().map(toTokenInfo);
}

/** Revokes a token. False when there was none with that id. */
export function deleteToken(db: Db, id: string): boolean {
  return Number(db.prepare("DELETE FROM tokens WHERE id = ?").run(id).changes) > 0;
}

/**
 * What export and import carry: everything but who may log in, and meta (the poller's heartbeat
 * belongs to the process that wrote it).
 */
const DATA_TABLES = ["messages", "posts", "subscriptions", "roots"] as const;

/** Thrown when an uploaded file is not a bridge database. */
export class NotADatabase extends Error {}

/**
 * Loads a database file into memory. A live bridge.db (WAL mode) is refused: its latest writes may
 * still be in the -wal file next to it, which an upload leaves behind, and nothing in the file says.
 */
function loadCopy(bytes: Uint8Array): Db {
  const header = new TextDecoder().decode(bytes.subarray(0, 16));
  if (header !== "SQLite format 3\0") throw new NotADatabase("That is not a sqlite file.");
  if (bytes[18] === 2 || bytes[19] === 2) {
    throw new NotADatabase(
      "That is a live bridge.db, whose newest writes may be in its -wal file. " +
        "Run devnull-bridge-server export next to it and import what it writes.",
    );
  }
  const db = new DatabaseSync(":memory:");
  try {
    db.deserialize(bytes);
    // Its views and triggers come from the upload: never run functions from them.
    db.exec("PRAGMA trusted_schema = OFF");
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    throw new NotADatabase(`That sqlite file cannot be read: ${(error as Error).message}`);
  }
  return db;
}

/** The threads, subscriptions and messages as a sqlite file, without tokens or pending logins. */
export function exportData(db: Db): Uint8Array<ArrayBuffer> {
  const copy = new DatabaseSync(":memory:");
  copy.exec(SCHEMA);
  inTransaction(copy, () => copyData(db, copy));
  const bytes = new Uint8Array(copy.serialize());
  copy.close();
  return bytes;
}

/** Replaces the data tables of `to` with those of `from`; the rows read per table. */
function copyData(from: Db, to: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of DATA_TABLES) {
    const columns = to.prepare(`PRAGMA table_info(${table})`).all().map((row) =>
      `"${String(row["name"])}"`
    );
    const rows = from.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
    to.exec(`DELETE FROM ${table}`);
    const insert = to.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) insert.run(...Object.values(row) as (string | number | null)[]);
    counts[table] = rows.length;
  }
  return counts;
}

/**
 * Replaces the threads, subscriptions and messages with those in a sqlite file (an export, or the
 * bridge.db of a single-machine bridge). Tokens stay. Returns the rows read per table.
 */
export function importData(db: Db, bytes: Uint8Array): Record<string, number> {
  const source = loadCopy(bytes);
  const tables = new Set(
    source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => String(row["name"])),
  );
  if (!tables.has("messages") || !tables.has("subscriptions")) {
    throw new NotADatabase("That sqlite file is not a dev-null-bridge database.");
  }
  try {
    // An older bridge's file: bring it up to this schema first.
    source.exec(SCHEMA);
    addMissingColumns(source, "posts", ["body TEXT", "html_url TEXT"]);
    return inTransaction(db, () => copyData(source, db));
  } catch (error) {
    // A file whose tables do not fit (the transaction rolled back): say why, briefly.
    const reason = (error as Error).message.split("\n")[0]!.slice(0, 200);
    throw new NotADatabase(`That file does not fit this bridge's tables: ${reason}`);
  } finally {
    source.close();
  }
}
