import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  addTree,
  findIdsByShortHash,
  getMeta,
  ingest,
  listThreads,
  openDbAt,
  readMessages,
  recordPost,
  removeTree,
  setMeta,
} from "./db.ts";
import { message, uuid } from "./test_util.ts";

const R = uuid(1);
const B1 = uuid(2);
const D1 = uuid(3);
const B2 = uuid(4);
const D2 = uuid(5);

function ids(messages: { id: string }[]): string[] {
  return messages.map((m) => m.id);
}

Deno.test("a reply to a watched commit reaches the watcher, and so do replies under it", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);
  recordPost(db, { id: B1, parentId: R, subscriber: "x", createdAt: "t" });

  ingest(db, [message(D1, B1)]);
  recordPost(db, { id: B2, parentId: D1, subscriber: "x", createdAt: "t" });
  ingest(db, [message(D2, B2)]);

  assertEquals(ids(readMessages(db, "x")), [D1, D2]);
});

Deno.test("messages in a thread nobody watches are stored but delivered to no one", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);
  ingest(db, [message(D1, uuid(99))]);

  assertEquals(readMessages(db, "x"), []);
  assertEquals(readMessages(db, "y"), []);
});

Deno.test("a chain of replies in one batch resolves because ids are handled oldest first", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);

  // The newest is listed first, as the API does.
  ingest(db, [message(D2, D1), message(D1, R)]);

  assertEquals(ids(readMessages(db, "x")), [D1, D2]);
});

Deno.test("watching later is retroactive: it adds the tree already stored", () => {
  const db = openDbAt(":memory:");
  ingest(db, [message(D1, R), message(D2, D1), message(uuid(50), uuid(49))]);

  addTree(db, "late", R);

  assertEquals(ids(readMessages(db, "late")), [D1, D2]);
});

Deno.test("watching later also walks through commits agents posted", () => {
  const db = openDbAt(":memory:");
  recordPost(db, { id: B1, parentId: R, subscriber: "first", createdAt: "t" });
  ingest(db, [message(D1, B1)]);

  addTree(db, "second", R);

  assertEquals(ids(readMessages(db, "second")), [D1]);
});

Deno.test("two subscribers in one thread each get every reply", () => {
  const db = openDbAt(":memory:");
  addTree(db, "a", R);
  addTree(db, "b", R);
  recordPost(db, { id: B1, parentId: R, subscriber: "a", createdAt: "t" });

  ingest(db, [message(D1, B1)]);

  assertEquals(ids(readMessages(db, "a")), [D1]);
  assertEquals(ids(readMessages(db, "b")), [D1]);
});

Deno.test("a reply recorded after its answer was ingested still finds it", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);
  ingest(db, [message(D1, B1)]);

  recordPost(db, { id: B1, parentId: R, subscriber: "x", createdAt: "t" });

  assertEquals(ids(readMessages(db, "x")), [D1]);
});

Deno.test("--after only returns newer messages", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);
  ingest(db, [message(D1, R), message(D2, R)]);

  assertEquals(ids(readMessages(db, "x", D1)), [D2]);
  assertEquals(ids(readMessages(db, "x", D2)), []);
});

Deno.test("ingesting a message twice delivers it once", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);

  assertEquals(ingest(db, [message(D1, R)]), 1);
  assertEquals(ingest(db, [message(D1, R)]), 0);
  assertEquals(ids(readMessages(db, "x")), [D1]);
});

Deno.test("unwatch removes the commit and what is known under it, for that subscriber only", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);
  addTree(db, "y", R);
  recordPost(db, { id: B1, parentId: R, subscriber: "x", createdAt: "t" });
  ingest(db, [message(D1, B1)]);

  assertEquals(removeTree(db, "x", R), 3);

  assertEquals(readMessages(db, "x"), []);
  assertEquals(ids(readMessages(db, "y")), [D1]);
  ingest(db, [message(D2, D1)]);
  assertEquals(readMessages(db, "x"), []);
});

Deno.test("threads lists each followed thread once, not every reply in it", () => {
  const db = openDbAt(":memory:");
  addTree(db, "x", R);
  recordPost(db, { id: B1, parentId: R, subscriber: "x", createdAt: "t" });
  ingest(db, [message(D1, B1)]);
  addTree(db, "x", uuid(70));

  assertEquals(listThreads(db, "x").map((t) => t.commitId), [R, uuid(70)]);
});

Deno.test("short hashes find stored messages and agent posts", () => {
  const db = openDbAt(":memory:");
  ingest(db, [message(D1, R)]);
  recordPost(db, { id: B1, parentId: R, subscriber: "x", createdAt: "t" });

  assertEquals(findIdsByShortHash(db, D1.replaceAll("-", "").slice(-7)), [D1]);
  assertEquals(findIdsByShortHash(db, B1.replaceAll("-", "").slice(-7)), [B1]);
});

Deno.test("meta values can be set and replaced", () => {
  const db = openDbAt(":memory:");
  assertEquals(getMeta(db, "k"), null);
  setMeta(db, "k", "1");
  setMeta(db, "k", "2");
  assertEquals(getMeta(db, "k"), "2");
});

Deno.test("a database made before posts kept their text gains the columns", () => {
  const path = Deno.makeTempFileSync({ suffix: ".db" });
  try {
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE posts (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, subscriber TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    old.exec("INSERT INTO posts VALUES ('p', 'r', 'x', 't')");
    old.close();

    const db = openDbAt(path);
    recordPost(db, { id: "q", parentId: "r", subscriber: "x", createdAt: "t", body: "hi" });

    assertEquals(
      db.prepare("SELECT id, body FROM posts ORDER BY id").all().map((r) => [r["id"], r["body"]]),
      [["p", null], ["q", "hi"]],
    );
    db.close();
  } finally {
    Deno.removeSync(path);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        Deno.removeSync(path + suffix);
      } catch {
        // SQLite removes them itself when the last connection closes.
      }
    }
  }
});
