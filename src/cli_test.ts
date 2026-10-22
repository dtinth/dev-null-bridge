import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { runCli, serverConfig } from "./cli.ts";
import { readTree, recordPost } from "./db.ts";
import { commitJson, FAKE_PUBLIC_KEY, fakeRuntime } from "./fake_runtime.ts";
import { uuid } from "./test_util.ts";

const API = "https://dev-null.sh/api/v1/commits";
const ROOT = uuid(1);
const SECRET = "x".repeat(32);

Deno.test("serve runs the poller and the server on PORT, on every address by default", async () => {
  const rt = fakeRuntime({ env: { PORT: "9123", BRIDGE_PUBLIC_URL: "https://bridge.example/" } });
  let rounds = 0;
  rt.sleep = () => {
    // Stop the poller after one round.
    if (++rounds > 1) throw new Error("stop");
    return Promise.resolve();
  };

  assertEquals(await runCli(["serve"], rt), 1);

  assertEquals(rt.served.map((s) => [s.port, s.hostname]), [[9123, "0.0.0.0"]]);
  assertStringIncludes(rt.err.join(""), "as https://bridge.example\n");
  assertStringIncludes(rt.err.join(""), "the web UI is closed");
  const health = await rt.served[0]!.handler(new Request("http://x/healthz"));
  assertEquals(await health.text(), "ok");
});

Deno.test("serve makes the bot's SSH key on first start, next to the database, and keeps it", async () => {
  const rt = fakeRuntime();
  rt.sleep = () => Promise.reject(new Error("stop"));

  await runCli(["serve"], rt);

  assertEquals(rt.commands[0]?.cmd, "ssh-keygen");
  assertEquals(rt.commands[0]?.args, [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "dtinth-bot@dev-null-bridge",
    "-f",
    "/data/bot/.ssh/id_ed25519",
  ]);
  assertStringIncludes(rt.err.join(""), `posting as @dtinth-bot with ${FAKE_PUBLIC_KEY}`);

  await runCli(["serve"], rt);
  assertEquals(rt.commands.filter((c) => c.cmd === "ssh-keygen").length, 1);

  const broken = fakeRuntime({ command: () => ({ code: 1, stdout: "", stderr: "no space" }) });
  assertEquals(await runCli(["serve"], broken), 1);
  assertStringIncludes(broken.err.join(""), "no space");
  assertEquals(broken.served, []);
});

Deno.test("a key put there without its .pub gets one derived, and the old env key is not read", async () => {
  const rt = fakeRuntime({
    env: { BRIDGE_SSH_PRIVATE_KEY: "old" },
    command: () => ({ code: 0, stdout: "ssh-ed25519 AAAAold bot\n", stderr: "" }),
  });
  rt.files.set("/data/bot/.ssh/id_ed25519", "PRIVATE KEY");
  rt.files.set("/data/bot/.ssh/id_ed25519.pub", "");
  rt.sleep = () => Promise.reject(new Error("stop"));

  await runCli(["serve"], rt);

  assertEquals(rt.commands[0]?.args, ["-y", "-f", "/data/bot/.ssh/id_ed25519"]);
  assertEquals(rt.files.get("/data/bot/.ssh/id_ed25519.pub"), "ssh-ed25519 AAAAold bot\n");
  assertStringIncludes(rt.err.join(""), "BRIDGE_SSH_PRIVATE_KEY is no longer read");

  const unreadable = fakeRuntime({
    command: () => ({ code: 1, stdout: "", stderr: "invalid format" }),
  });
  unreadable.files.set("/data/bot/.ssh/id_ed25519", "garbage");
  assertEquals(await runCli(["serve"], unreadable), 1);
  assertStringIncludes(unreadable.err.join(""), "invalid format");
});

Deno.test("export writes the data to a file, for the Data page to import", async () => {
  const rt = fakeRuntime();
  recordPost(rt.openDb(), { id: uuid(2), parentId: ROOT, subscriber: "x", createdAt: "t" });

  assertEquals(await runCli(["export", "bridge.db"], rt), 0);

  const file = rt.binaries.get("bridge.db")!;
  assertEquals(new TextDecoder().decode(file.subarray(0, 15)), "SQLite format 3");
  assertStringIncludes(rt.out.join(""), "wrote bridge.db: 0 messages, 1 subscriptions");
  assertEquals(await runCli(["export"], rt), 2);
});

Deno.test("the server's config needs both halves of the OAuth app and a long session secret", () => {
  assertEquals(serverConfig({}, 8787).publicUrl, "http://localhost:8787");
  assertEquals(serverConfig({}, 8787).oauth, null);
  assertThrows(() => serverConfig({ GITHUB_CLIENT_ID: "a" }, 1), Error, "or neither");
  assertThrows(
    () => serverConfig({ GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" }, 1),
    Error,
    "BRIDGE_SESSION_SECRET",
  );
  const config = serverConfig({
    GITHUB_CLIENT_ID: "a",
    GITHUB_CLIENT_SECRET: "b",
    BRIDGE_SESSION_SECRET: SECRET,
    BRIDGE_AUTHORS: "alice, bob",
  }, 1);
  assertEquals(config.oauth, { clientId: "a", clientSecret: "b" });
  assertEquals(config.authors, ["alice", "bob"]);
});

Deno.test("an unknown command or a stray argument is a usage error; help is not", async () => {
  assertEquals(await runCli(["nope"], fakeRuntime()), 2);
  assertEquals(await runCli(["serve", "now"], fakeRuntime()), 2);
  const rt = fakeRuntime();
  assertEquals(await runCli([], rt), 0);
  assertStringIncludes(rt.out.join(""), "Usage:");
});

Deno.test("backfill fills in the text of older agent posts it can find, and only the bot's", async () => {
  const rt = fakeRuntime({
    routes: {
      [`${API}/${uuid(2)}`]: {
        data: commitJson(uuid(2), ROOT, { body: "old reply", author: "dtinth-bot" }),
      },
      [`${API}/${uuid(3)}`]: { data: commitJson(uuid(3), ROOT, { body: "not ours" }) },
    },
  });
  const db = rt.openDb();
  for (const id of [uuid(2), uuid(3), uuid(4)]) {
    recordPost(db, { id, parentId: ROOT, subscriber: "x", createdAt: "t" });
  }

  assertEquals(await runCli(["backfill"], rt), 0);

  assertEquals(rt.out.join(""), "filled 1 post(s), 2 not found\n");
  assertEquals(
    readTree(db, "x", ROOT).filter((row) => row.kind === "post").map((row) => row.body),
    ["old reply", null, null],
  );
});

Deno.test("backfill waits and tries again when the site rate-limits it", async () => {
  const rt = fakeRuntime({
    routes: {
      [`${API}/${uuid(2)}`]: { data: commitJson(uuid(2), ROOT, { author: "dtinth-bot" }) },
    },
  });
  const fetchRoute = rt.fetch;
  let limited = 1;
  rt.fetch = (input, init) =>
    limited-- > 0
      ? Promise.resolve(new Response("slow down", { status: 429 }))
      : fetchRoute(input, init);
  recordPost(rt.openDb(), { id: uuid(2), parentId: ROOT, subscriber: "x", createdAt: "t" });
  const started = rt.now().getTime();

  assertEquals(await runCli(["backfill"], rt), 0);

  assertEquals(rt.out.join(""), "filled 1 post(s)\n");
  assertStringIncludes(rt.err.join(""), "rate limited");
  assertEquals(rt.now().getTime() - started >= 60_000, true);
});
