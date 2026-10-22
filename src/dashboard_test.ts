import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./cli.ts";
import {
  collectDashboard,
  collectThread,
  dashboardHandler,
  renderDashboard,
  renderThread,
  threadPath,
} from "./dashboard.ts";
import { addTree, ingest, openDbAt, recordPost, saveRoot, setMeta } from "./db.ts";
import { commitJson, fakeRuntime } from "./fake_runtime.ts";
import { message, uuid } from "./test_util.ts";

const NOW = new Date("2026-10-19T12:00:30Z");
const R = uuid(1);

function populated() {
  const db = openDbAt(":memory:");
  setMeta(db, "poller_heartbeat", "2026-10-19T12:00:00.000Z");
  saveRoot(
    db,
    message(R, null, {
      body: "Build the bridge\nand more",
      htmlUrl: "https://dev-null.sh/@dtinth/commits/r",
    }),
  );
  addTree(db, "alpha", R);
  recordPost(db, {
    id: uuid(2),
    parentId: R,
    subscriber: "alpha",
    createdAt: "t",
    body: "On it",
    htmlUrl: "https://dev-null.sh/@dtinth-bot/commits/2",
  });
  ingest(db, [message(uuid(3), uuid(2), { createdAt: "2026-10-19T12:00:10Z" })]);
  addTree(db, "beta", uuid(50));
  return db;
}

Deno.test("each subscriber lists how many commit ids it follows and its threads", () => {
  const data = collectDashboard(populated(), NOW);

  assertEquals(data.poller, {
    heartbeat: "2026-10-19T12:00:00.000Z",
    ageSeconds: 30,
    running: true,
  });
  assertEquals(data.messages, 1);
  assertEquals(data.subscribers.map((s) => [s.name, s.commits, s.threads.length, s.delivered]), [
    ["alpha", 3, 1, 1],
    ["beta", 1, 1, 0],
  ]);
  assertEquals(data.subscribers[0]!.threads[0], {
    rootId: R,
    shortHash: "0000001",
    author: "dtinth",
    excerpt: "Build the bridge",
    url: "https://dev-null.sh/@dtinth/commits/r",
    commits: 3,
  });
  assertEquals(data.subscribers[1]!.threads[0]!.excerpt, null);
  assertEquals(data.subscribers[0]!.lastMessageAt, "2026-10-19T12:00:10Z");
});

Deno.test("the poller counts as down after two quiet minutes", () => {
  const db = populated();
  assertEquals(collectDashboard(db, new Date("2026-10-19T12:05:00Z")).poller.running, false);
  assertEquals(collectDashboard(openDbAt(":memory:"), NOW).poller.running, false);
});

Deno.test("the page shows the numbers and escapes everything it prints", () => {
  const db = populated();
  saveRoot(
    db,
    message(uuid(60), null, {
      body: '<script>alert("x")</script>',
      htmlUrl: "javascript:alert(1)",
    }),
  );
  addTree(db, "evil<b>", uuid(60));

  const html = renderDashboard(collectDashboard(db, NOW));

  assertStringIncludes(html, "alpha");
  assertStringIncludes(html, "3<span> commit ids followed</span>");
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("evil<b>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
  assertEquals(html.includes('href="javascript:'), false);
});

Deno.test("an empty bridge says how to start", () => {
  assertStringIncludes(
    renderDashboard(collectDashboard(openDbAt(":memory:"), NOW)),
    "No subscriptions yet",
  );
});

Deno.test("the handler serves the page and the state as JSON, and nothing else", async () => {
  const handle = dashboardHandler(populated(), () => NOW);

  const page = handle(new Request("http://127.0.0.1/"));
  assertStringIncludes(page.headers.get("content-type")!, "text/html");
  assertStringIncludes(await page.text(), "alpha");

  const state = await handle(new Request("http://127.0.0.1/state.json")).json();
  assertEquals(state.subscribers.length, 2);

  assertEquals(handle(new Request("http://127.0.0.1/other")).status, 404);
  assertEquals(handle(new Request("http://127.0.0.1/", { method: "POST" })).status, 405);
});

Deno.test("the dashboard command serves on the given port", async () => {
  const rt = fakeRuntime({
    routes: {
      [`https://dev-null.sh/api/v1/commits/${R}`]: {
        data: commitJson(R, null, { body: "Build X" }),
      },
    },
  });
  await runCli(["watch", "alpha", R], rt);

  assertEquals(await runCli(["dashboard", "--port", "9123"], rt), 0);

  assertEquals(rt.served.map((s) => s.port), [9123]);
  const served = await rt.served[0]!.handler(new Request("http://127.0.0.1:9123/"));
  assertStringIncludes(await served.text(), "Build X");
  assertEquals(await runCli(["dashboard", "--port", "70000"], rt), 2);
});

Deno.test("a thread page lists what was said in it, in order, as the subscriber sees it", () => {
  const db = populated();
  // A second answer to the root branches off; beta's thread is not alpha's.
  ingest(db, [message(uuid(4), R, { body: "also this", images: ["https://x/1.png"] })]);
  recordPost(db, { id: uuid(5), parentId: uuid(4), subscriber: "old", createdAt: "t" });

  const thread = collectThread(db, "alpha", R)!;

  assertEquals(
    thread.entries.map((e) => [e.shortHash, e.author, e.body, e.parentId, e.postedBy]),
    [
      ["0000001", "dtinth", "Build the bridge\nand more", null, null],
      ["0000002", "dtinth-bot", "On it", R, "alpha"],
      ["0000003", "dtinth", `body of ${uuid(3)}`, uuid(2), null],
      ["0000004", "dtinth", "also this", R, null],
      ["0000005", "dtinth-bot", null, uuid(4), "old"],
    ],
  );
  assertEquals(thread.entries.map((e) => e.followed), [true, true, true, true, true]);
  assertEquals(thread.entries[4]!.url, `https://dev-null.sh/@dtinth-bot/commits/${uuid(5)}`);
  assertEquals(collectThread(db, "beta", R), null);
  assertEquals(collectThread(db, "nobody", R), null);

  const html = renderThread(thread);
  assertStringIncludes(html, "Build the bridge\nand more");
  assertStringIncludes(html, "via alpha");
  assertStringIncludes(html, "↳ 0000001");
  assertStringIncludes(html, "Posted before the bridge kept agents' text.");
  assertStringIncludes(html, 'href="https://x/1.png"');
});

Deno.test("a thread page escapes what it prints and links only http(s) images", () => {
  const db = populated();
  ingest(db, [
    message(uuid(6), uuid(3), { body: "<img src=x onerror=alert(1)>", images: ["javascript:x"] }),
  ]);

  const html = renderThread(collectThread(db, "alpha", R)!);

  assertEquals(html.includes("<img"), false);
  assertStringIncludes(html, "&lt;img src=x");
  assertEquals(html.includes('href="javascript:'), false);
});

Deno.test("the subscriptions page links each thread to its page, which the handler serves", async () => {
  const handle = dashboardHandler(populated(), () => NOW);

  const list = await handle(new Request("http://127.0.0.1/")).text();
  assertStringIncludes(list, `href="${threadPath("alpha", R)}"`);

  const page = handle(new Request(`http://127.0.0.1${threadPath("alpha", R)}`));
  assertEquals(page.status, 200);
  assertStringIncludes(await page.text(), "On it");

  assertEquals(handle(new Request(`http://127.0.0.1${threadPath("beta", R)}`)).status, 404);
  assertEquals(handle(new Request("http://127.0.0.1/threads/alpha")).status, 404);
});
