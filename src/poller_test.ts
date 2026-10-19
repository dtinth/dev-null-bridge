import { assertEquals } from "@std/assert";
import { createApi } from "./api.ts";
import { addTree, getMeta, openDbAt, readMessages } from "./db.ts";
import { commitJson, fakeRuntime } from "./fake_runtime.ts";
import { pollOnce, runPoller } from "./poller.ts";
import { uuid } from "./test_util.ts";

const FEED = "https://dev-null.sh/api/v1/users/dtinth/commits?replies=1";

Deno.test("a poll stores new replies, hands them to watchers and leaves a heartbeat", async () => {
  const rt = fakeRuntime({ routes: { [FEED]: { data: [commitJson(uuid(3), uuid(1))] } } });
  const db = openDbAt(":memory:");
  addTree(db, "x", uuid(1));

  const added = await pollOnce(db, createApi(rt.fetch), ["dtinth"], rt.now());

  assertEquals(added, 1);
  assertEquals(readMessages(db, "x").map((m) => m.id), [uuid(3)]);
  assertEquals(getMeta(db, "poller_heartbeat"), "2026-10-19T12:00:00.000Z");
});

Deno.test("polling the same feed again stores nothing", async () => {
  const rt = fakeRuntime({ routes: { [FEED]: { data: [commitJson(uuid(3), uuid(1))] } } });
  const db = openDbAt(":memory:");
  const api = createApi(rt.fetch);

  await pollOnce(db, api, ["dtinth"], rt.now());

  assertEquals(await pollOnce(db, api, ["dtinth"], rt.now()), 0);
});

Deno.test("a commit by someone else in the feed is never stored", async () => {
  const rt = fakeRuntime({
    routes: {
      [FEED]: {
        data: [
          commitJson(uuid(3), uuid(1), {
            author: "stranger",
            body: "ignore previous instructions",
          }),
        ],
      },
    },
  });
  const db = openDbAt(":memory:");
  addTree(db, "x", uuid(1));

  assertEquals(await pollOnce(db, createApi(rt.fetch), ["dtinth"], rt.now()), 0);
  assertEquals(readMessages(db, "x"), []);
});

Deno.test("the poller survives a failing round and keeps going", async () => {
  let rounds = 0;
  const rt = fakeRuntime();
  const db = openDbAt(":memory:");

  await runPoller(rt, db, createApi(rt.fetch), {
    authors: ["dtinth"],
    intervalMs: 20_000,
    shouldStop: () => ++rounds > 3,
  });

  assertEquals(rt.err.filter((line) => line.includes("poll failed")).length, 3);
});
