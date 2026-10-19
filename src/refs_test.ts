import { assertEquals, assertRejects } from "@std/assert";
import { createApi } from "./api.ts";
import { ingest, openDbAt } from "./db.ts";
import { commitJson, fakeRuntime } from "./fake_runtime.ts";
import { parseCommitRef, resolveRef, shortHashOf } from "./refs.ts";
import { message, uuid } from "./test_util.ts";

Deno.test("a ref can be an id, a url or a 7-character hash", () => {
  assertEquals(parseCommitRef(uuid(5)), { kind: "id", id: uuid(5) });
  assertEquals(parseCommitRef(`https://dev-null.sh/@dtinth/commits/${uuid(5).toUpperCase()}`), {
    kind: "id",
    id: uuid(5),
  });
  assertEquals(parseCommitRef("361191D"), { kind: "short", short: "361191d" });
  assertEquals(parseCommitRef("nope"), null);
  assertEquals(parseCommitRef("12345678"), null);
});

Deno.test("the short hash is the last 7 hex digits", () => {
  assertEquals(shortHashOf("01a155a3-41f4-7385-aef0-6811a361191d"), "361191d");
});

Deno.test("a short hash is found in the database first", async () => {
  const db = openDbAt(":memory:");
  ingest(db, [message(uuid(5), null)]);
  const rt = fakeRuntime();

  assertEquals(
    await resolveRef("0000005", { db, api: createApi(rt.fetch), users: ["dtinth"] }),
    uuid(5),
  );
  assertEquals(rt.fetched, []);
});

Deno.test("a short hash the database does not know is looked for in the feeds", async () => {
  const rt = fakeRuntime({
    routes: {
      "https://dev-null.sh/api/v1/users/dtinth/commits": { data: [] },
      "https://dev-null.sh/api/v1/users/dtinth/commits?replies=1": { data: [] },
      "https://dev-null.sh/api/v1/users/dtinth-bot/commits": {
        data: [commitJson(uuid(9), null, { author: "dtinth-bot" })],
      },
      "https://dev-null.sh/api/v1/users/dtinth-bot/commits?replies=1": { data: [] },
    },
  });

  const id = await resolveRef("0000009", {
    db: openDbAt(":memory:"),
    api: createApi(rt.fetch),
    users: ["dtinth", "dtinth-bot"],
  });

  assertEquals(id, uuid(9));
});

Deno.test("an unknown hash says to pass the URL", async () => {
  const rt = fakeRuntime();
  await assertRejects(
    () => resolveRef("abcdef0", { db: openDbAt(":memory:"), api: createApi(rt.fetch), users: [] }),
    Error,
    "pass its URL",
  );
});
