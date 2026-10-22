import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { runCli, serverConfig } from "./cli.ts";
import { readTree, recordPost } from "./db.ts";
import { commitJson, fakeRuntime } from "./fake_runtime.ts";
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

Deno.test("serve writes an SSH key from the environment, and its public half, where the commit script looks", async () => {
  const rt = fakeRuntime({
    env: {
      HOME: "/home/deno",
      BRIDGE_SSH_PRIVATE_KEY:
        "-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----",
    },
    command: (cmd) =>
      cmd === "ssh-keygen"
        ? { code: 0, stdout: "ssh-ed25519 AAAA bot\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
  });
  rt.sleep = () => Promise.reject(new Error("stop"));

  await runCli(["serve"], rt);

  assertEquals(
    rt.files.get("/home/deno/.ssh/devnull-bridge"),
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
  );
  assertEquals(rt.commands[0]?.cmd, "ssh-keygen");
  assertEquals(rt.commands[0]?.args, ["-y", "-f", "/home/deno/.ssh/devnull-bridge"]);
  assertEquals(rt.files.get("/home/deno/.ssh/devnull-bridge.pub"), "ssh-ed25519 AAAA bot\n");

  const bad = fakeRuntime({
    env: { BRIDGE_SSH_PRIVATE_KEY: "not a key" },
    command: () => ({ code: 255, stdout: "", stderr: "invalid format" }),
  });
  assertEquals(await runCli(["serve"], bad), 2);
  assertStringIncludes(bad.err.join(""), "invalid format");
  assertEquals(bad.served, []);
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
