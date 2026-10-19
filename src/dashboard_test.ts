import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./cli.ts";
import { collectDashboard, dashboardHandler, renderDashboard } from "./dashboard.ts";
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
  recordPost(db, { id: uuid(2), parentId: R, subscriber: "alpha", createdAt: "t" });
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
