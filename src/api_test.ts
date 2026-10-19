import { assertEquals, assertRejects } from "@std/assert";
import { ApiError, createApi, parseCommit } from "./api.ts";
import { commitJson, fakeRuntime } from "./fake_runtime.ts";
import { uuid } from "./test_util.ts";

Deno.test("parseCommit reads the fields the bridge uses, with image urls", () => {
  const message = parseCommit(commitJson(uuid(3), uuid(2), { images: ["https://x/1.webp"] }));

  assertEquals(message, {
    id: uuid(3),
    shortHash: "0000003",
    parentId: uuid(2),
    author: "dtinth",
    body: `body of ${uuid(3)}`,
    images: ["https://x/1.webp"],
    htmlUrl: `https://dev-null.sh/@dtinth/commits/${uuid(3)}`,
    createdAt: "2026-10-19T12:00:00Z",
  });
});

Deno.test("parseCommit refuses a commit without an author", () => {
  const raw = { ...commitJson(uuid(3), null), author: null };
  assertEquals(
    (() => {
      try {
        parseCommit(raw);
      } catch (error) {
        return error instanceof ApiError;
      }
    })(),
    true,
  );
});

Deno.test("listCommits asks for the replies feed", async () => {
  const rt = fakeRuntime({
    routes: {
      "https://dev-null.sh/api/v1/users/dtinth/commits?replies=1": {
        data: [commitJson(uuid(3), uuid(2))],
      },
    },
  });

  const commits = await createApi(rt.fetch).listCommits("dtinth", { replies: true });

  assertEquals(commits.map((c) => c.id), [uuid(3)]);
});

Deno.test("getCommit answers null for a 404 and throws for other failures", async () => {
  const rt = fakeRuntime({
    routes: {
      [`https://dev-null.sh/api/v1/commits/${uuid(3)}`]: { data: commitJson(uuid(3), null) },
    },
  });
  const api = createApi(rt.fetch);

  assertEquals((await api.getCommit(uuid(3)))?.id, uuid(3));
  assertEquals(await api.getCommit(uuid(4)), null);
  await assertRejects(
    () => createApi(() => Promise.resolve(new Response("", { status: 500 }))).getCommit(uuid(3)),
    ApiError,
  );
});
