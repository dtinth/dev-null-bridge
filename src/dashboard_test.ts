import { assertEquals, assertStringIncludes } from "@std/assert";
import { signSession } from "./auth.ts";
import {
  collectDashboard,
  collectThread,
  renderDashboard,
  renderThread,
  threadPath,
} from "./dashboard.ts";
import { addTree, type Db, ingest, openDbAt, recordPost, saveRoot, setMeta } from "./db.ts";
import { FAKE_PUBLIC_KEY, type FakeOptions, fakeRuntime } from "./fake_runtime.ts";
import { createServer } from "./server.ts";
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

const SECRET = "a session secret that is long enough";

/** The server's web UI over a database, as the signed-in dtinth sees it. */
async function signedIn(db: Db, options: FakeOptions = {}, files: Record<string, string> = {}) {
  const rt = fakeRuntime(options);
  for (const [path, content] of Object.entries(files)) rt.files.set(path, content);
  rt.clock.time = NOW.getTime();
  rt.openDb = () => db;
  const handler = createServer(rt, db, {
    authors: ["dtinth"],
    botUser: "dtinth-bot",
    devnullUrl: "https://dev-null.sh",
    publicUrl: "https://bridge.example",
    oauth: { clientId: "c", clientSecret: "s" },
    sessionSecret: SECRET,
  });
  const cookie = `bridge_session=${await signSession(
    "dtinth",
    new Date(NOW.getTime() + 60_000),
    SECRET,
  )}`;
  return (path: string) =>
    handler(new Request(`https://bridge.example${path}`, { headers: { cookie } }));
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

  const html = renderDashboard(collectDashboard(db, NOW), "dtinth");

  assertStringIncludes(html, "alpha");
  assertStringIncludes(html, "3<span> commit ids followed</span>");
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("evil<b>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
  assertEquals(html.includes('href="javascript:'), false);
});

Deno.test("an empty bridge says how to start", () => {
  assertStringIncludes(
    renderDashboard(collectDashboard(openDbAt(":memory:"), NOW), "dtinth"),
    "No subscriptions yet",
  );
});

Deno.test("the server serves the page and the state as JSON, with the signed-in nav", async () => {
  const get = await signedIn(populated());

  const page = await get("/");
  assertStringIncludes(page.headers.get("content-type")!, "text/html");
  const html = await page.text();
  assertStringIncludes(html, "alpha");
  assertStringIncludes(html, '<a href="/tokens">Tokens</a>');
  assertStringIncludes(html, "@dtinth");

  const state = await (await get("/state.json")).json();
  assertEquals(state.subscribers.length, 2);

  assertEquals((await get("/other")).status, 404);
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

  const html = renderThread(thread, "dtinth");
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

  const html = renderThread(collectThread(db, "alpha", R)!, "dtinth");

  assertEquals(html.includes("<img"), false);
  assertStringIncludes(html, "&lt;img src=x");
  assertEquals(html.includes('href="javascript:'), false);
});

Deno.test("the subscriptions page links each thread to its page, which the server serves", async () => {
  const get = await signedIn(populated());

  const list = await (await get("/")).text();
  assertStringIncludes(list, `href="${threadPath("alpha", R)}"`);

  const page = await get(threadPath("alpha", R));
  assertEquals(page.status, 200);
  assertStringIncludes(await page.text(), "On it");

  assertEquals((await get(threadPath("beta", R))).status, 404);
  assertEquals((await get("/threads/alpha")).status, 404);
});

Deno.test("the Bot key page shows the public key and whether the bot's GitHub lists it", async () => {
  const KEYS = "https://github.com/dtinth-bot.keys";
  const key = {
    "/data/bot/.ssh/id_ed25519.pub": `${FAKE_PUBLIC_KEY} dtinth-bot@dev-null-bridge\n`,
  };

  const missing = await (await (await signedIn(populated(), {
    texts: { [KEYS]: "ssh-ed25519 AAAAother\n" },
  }, key))("/bot-key")).text();
  assertStringIncludes(missing, `${FAKE_PUBLIC_KEY} dtinth-bot@dev-null-bridge`);
  assertStringIncludes(missing, "Not on");
  assertStringIncludes(missing, "https://github.com/settings/ssh/new");
  assertStringIncludes(missing, '<a href="/bot-key">Bot key</a>');

  const listed = await (await (await signedIn(populated(), {
    texts: { [KEYS]: `ssh-ed25519 AAAAother\n${FAKE_PUBLIC_KEY}\n` },
  }, key))("/bot-key")).text();
  assertStringIncludes(listed, "Listed on");

  const unknown = await (await (await signedIn(populated(), {}, key))("/bot-key")).text();
  assertStringIncludes(unknown, "Could not ask GitHub");

  const none = await (await (await signedIn(populated()))("/bot-key")).text();
  assertStringIncludes(none, "No key yet");
});
