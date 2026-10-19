/**
 * The bridge's sqlite store, shared by the poller and every agent session (WAL mode, so one
 * writer and many readers get along).
 *
 * - `messages`: every reply by an allowed author the poller has seen.
 * - `posts`: the commits agents posted through `reply`, so a thread can pass through them.
 * - `subscriptions`: `(subscriber, commit_id)`. A subscriber receives a message when the message's
 *   own id is in its set; the poller adds each new message whose parent is in the set, and `reply`
 *   adds the commit it posts. A watch is therefore a filter over what is stored: watching a commit
 *   adds the whole known tree under it.
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_parent ON posts (parent_id);
CREATE TABLE IF NOT EXISTS subscriptions (
  subscriber TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  PRIMARY KEY (subscriber, commit_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_commit ON subscriptions (commit_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  return db;
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
  post: { id: string; parentId: string; subscriber: string; createdAt: string },
): void {
  inTransaction(db, () => {
    db.prepare(
      "INSERT OR IGNORE INTO posts (id, parent_id, subscriber, created_at) VALUES (?, ?, ?, ?)",
    )
      .run(post.id, post.parentId, post.subscriber, post.createdAt);
    db.prepare(
      "INSERT OR IGNORE INTO subscriptions (subscriber, commit_id) SELECT subscriber, ? FROM subscriptions WHERE commit_id = ?",
    ).run(post.id, post.parentId);
    addTree(db, post.subscriber, post.id);
  });
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
