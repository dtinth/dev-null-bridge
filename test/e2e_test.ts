/** The CLI against the server: what an agent sees, end to end. */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { ingest, listTokens, readTree, setMeta } from "../src/db.ts";
import { commitJson, fakeRuntime } from "../src/fake_runtime.ts";
import { message, uuid } from "../src/test_util.ts";
import { API, COMMIT_SCRIPT, harness, ROOT, serverRuntime } from "./harness.ts";

Deno.test("watch prints the commit and what has been said so far, then how to keep listening", async () => {
  const h = await harness();
  ingest(h.server.openDb(), [message(uuid(3), ROOT, { body: "an earlier reply" })]);

  assertEquals(await h.run("watch", "x", ROOT), 0);

  assertEquals(h.jsonLines().map((m) => m["body"]), ["Please build X", "an earlier reply"]);
  assertEquals(Object.keys(h.jsonLines()[0]!), [
    "id",
    "short_hash",
    "parent_id",
    "author",
    "body",
    "images",
    "html_url",
    "created_at",
  ]);
  assertStringIncludes(h.lines().at(-1)!, `devnull-bridge long-poll x --after ${uuid(3)}`);
});

Deno.test("watch accepts a commit URL", async () => {
  const h = await harness();
  assertEquals(await h.run("watch", "x", `https://dev-null.sh/@dtinth/commits/${ROOT}`), 0);
});

Deno.test("watch says so when the commit is not public", async () => {
  const h = await harness({ server: fakeRuntime() });
  assertEquals(await h.run("watch", "x", uuid(8)), 1);
  assertStringIncludes(h.agent.err.join(""), "no public commit");
});

Deno.test("a bad subscriber name is a usage error before anything is sent", async () => {
  const h = await harness();
  assertEquals(await h.run("watch", "has space", ROOT), 2);
  assertEquals(h.server.fetched, []);
});

Deno.test("long-poll returns what is already there after the cursor, with the restart line", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  h.agent.out.length = 0;
  ingest(h.server.openDb(), [
    message(uuid(3), ROOT, { body: "first" }),
    message(uuid(4), ROOT, { body: "second" }),
  ]);

  assertEquals(await h.run("long-poll", "x", "--after", uuid(3)), 0);

  assertEquals(h.jsonLines().map((m) => m["body"]), ["second"]);
  const all = h.lines();
  assertStringIncludes(all[0]!, "NEW MESSAGES");
  assertEquals(
    all.at(-1),
    `>>> Start this now, in the background, before anything else: devnull-bridge long-poll x --after ${
      uuid(4)
    }`,
  );
});

Deno.test("long-poll asks the server every 10 seconds until something arrives", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  const asked: number[] = [];
  const fetchRoute = h.agent.fetch;
  h.agent.fetch = (input, init) => {
    asked.push(h.agent.clock.time);
    if (asked.length === 3) ingest(h.server.openDb(), [message(uuid(3), ROOT)]);
    return fetchRoute(input, init);
  };

  assertEquals(await h.run("long-poll", "x", "--after", ROOT), 0);

  assertEquals(asked.map((t) => (t - asked[0]!) / 1000), [0, 10, 20]);
  assertEquals(h.jsonLines().at(-1)!["id"], uuid(3));
});

Deno.test("long-poll keeps its flags in the restart line", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  h.agent.out.length = 0;
  ingest(h.server.openDb(), [message(uuid(3), ROOT)]);

  await h.run("long-poll", "x", "--after", "0", "--interval", "2", "--timeout", "60");

  assertStringIncludes(
    h.lines().at(-1)!,
    `devnull-bridge long-poll x --interval 2 --timeout 60 --after ${uuid(3)}`,
  );
});

Deno.test("long-poll gives up at the timeout and prints the same cursor to restart with", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  h.agent.out.length = 0;

  assertEquals(await h.run("long-poll", "x", "--after", uuid(3), "--timeout", "5"), 0);

  assertEquals(h.jsonLines(), []);
  assertStringIncludes(h.agent.out.join(""), "No new messages after 5s");
  assertStringIncludes(h.agent.out.join(""), `--timeout 5 --after ${uuid(3)}`);
});

Deno.test("long-poll warns once when the server's poller has never run", async () => {
  const h = await harness();
  await h.run("long-poll", "x", "--after", "0", "--timeout", "30");
  assertEquals(
    h.agent.err.join("").match(/warning: the server's poller has never run/g)?.length,
    1,
  );
});

Deno.test("long-poll waits out a server that is down, but not a revoked token", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  const fetchRoute = h.agent.fetch;
  let down = 2;
  h.agent.fetch = (input, init) => {
    if (down-- > 0) return Promise.reject(new TypeError("connection refused"));
    ingest(h.server.openDb(), [message(uuid(3), ROOT)]);
    return fetchRoute(input, init);
  };

  assertEquals(await h.run("long-poll", "x", "--after", ROOT), 0);
  assertEquals(h.jsonLines().at(-1)!["id"], uuid(3));
  const err = h.agent.err.join("");
  assertEquals(err.match(/Could not reach/g)?.length, 1);
  assertStringIncludes(err, "answers again");

  h.agent.fetch = fetchRoute;
  h.agent.env["BRIDGE_TOKEN"] = "dnb_revoked";
  assertEquals(await h.run("long-poll", "x", "--after", ROOT), 1);
  assertStringIncludes(h.agent.err.join(""), "devnull-bridge login");
});

Deno.test("long-poll needs --after", async () => {
  assertEquals(await (await harness()).run("long-poll", "x"), 2);
});

Deno.test("reply posts through the server's commit script, follows the new commit and gets answers to it", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  h.agent.out.length = 0;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  h.agent.binaries.set("shots/a.png", png);
  let uploaded: Uint8Array | undefined;
  const runCommand = h.server.runCommand.bind(h.server);
  h.server.runCommand = (cmd, args, env) => {
    uploaded = h.server.binaries.get(args[4]!);
    return runCommand(cmd, args, env);
  };

  assertEquals(
    await h.run("reply", "x", ROOT, "--image", "shots/a.png", "Done,", "see", "image"),
    0,
  );

  const posted = h.server.commands.at(-1)!;
  assertEquals(posted.cmd, "bash");
  // The commit script signs with the key the server made, in the bot's own home.
  assertEquals(posted.env?.HOME, "/data/bot");
  assertEquals(posted.args.slice(1), [
    "--reply",
    ROOT,
    "--image",
    "/tmp/upload-1/image-1.png",
    "--",
    "Done, see image",
  ]);
  assertEquals(uploaded, png);
  assertEquals(h.server.binaries.size, 0, "the uploaded image is gone once posted");
  assertEquals(h.server.files.get("/cache/commit.sh"), COMMIT_SCRIPT);
  assertStringIncludes(h.agent.out.join(""), `x follows ${uuid(2)}`);
  const post = readTree(h.server.openDb(), "x", ROOT).find((row) => row.id === uuid(2))!;
  assertEquals([post.kind, post.body, post.htmlUrl, post.postedBy], [
    "post",
    "Done, see image",
    `https://dev-null.sh/@dtinth-bot/commits/${uuid(2)}`,
    "x",
  ]);

  // The human answers the commit the bridge posted.
  ingest(h.server.openDb(), [message(uuid(5), uuid(2), { body: "thanks" })]);
  h.agent.out.length = 0;
  await h.run("read", "x");
  assertEquals(h.jsonLines().map((m) => m["body"]), ["thanks"]);
});

Deno.test("reply reads the body from stdin when no text is given", async () => {
  const h = await harness();
  h.agent.stdin = 'It\'s "quoted" and costs $5,\nover `two` lines\n';

  assertEquals(await h.run("reply", "x", ROOT), 0);
  assertEquals(
    h.server.commands.at(-1)!.args.at(-1),
    'It\'s "quoted" and costs $5,\nover `two` lines',
  );

  // Text arguments win over stdin.
  assertEquals(await h.run("reply", "x", ROOT, "from", "args"), 0);
  assertEquals(h.server.commands.at(-1)!.args.at(-1), "from args");
});

Deno.test("reply with no text anywhere is a usage error", async () => {
  const h = await harness();
  assertEquals(await h.run("reply", "x", ROOT), 2);
  h.agent.stdin = "\n\n";
  assertEquals(await h.run("reply", "x", ROOT), 2);
  assertEquals(h.server.commands, []);
});

Deno.test("a reply always needs text, even with an image", async () => {
  const h = await harness();
  h.agent.binaries.set("a.png", new Uint8Array([1]));
  assertEquals(await h.run("reply", "x", ROOT, "--image", "a.png"), 2);
  assertEquals(h.server.commands, []);
});

Deno.test("a commit the server cannot make sense of is the caller's error, not the server's", async () => {
  const h = await harness();
  assertEquals(await h.run("watch", "x", "nope"), 1);
  assertStringIncludes(h.agent.err.join(""), "is not a commit");
  const response = await h.handler(
    new Request("https://bridge.example/api/watch", {
      method: "POST",
      body: JSON.stringify({ name: "x", commit: "nope" }),
      headers: { authorization: "Bearer dnb_test-token" },
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(h.server.err.join(""), "");
});

Deno.test("reply refuses files that are not images, before uploading", async () => {
  const h = await harness();
  assertEquals(await h.run("reply", "x", ROOT, "--image", "notes.txt", "hi"), 2);
  assertEquals(await h.run("reply", "x", ROOT, "--image", "missing.png", "hi"), 2);
  assertStringIncludes(h.agent.err.join(""), "There is no file missing.png");
  assertEquals(h.server.commands, []);
});

Deno.test("the server refuses more than three images or a wrong type", async () => {
  const h = await harness();
  const form = (types: string[]) => {
    const body = new FormData();
    body.set("name", "x");
    body.set("commit", ROOT);
    for (const type of types) body.append("image", new File([new Uint8Array(1)], "f", { type }));
    return body;
  };
  const post = (body: FormData) =>
    h.handler(
      new Request("https://bridge.example/api/reply", {
        method: "POST",
        body,
        headers: { authorization: "Bearer dnb_test-token" },
      }),
    );

  const tooMany = await post(form(["image/png", "image/png", "image/png", "image/png"]));
  assertEquals(tooMany.status, 400);
  const wrongType = await post(form(["text/html"]));
  assertEquals(wrongType.status, 400);
  assertStringIncludes((await wrongType.json()).error, "not a JPEG, PNG or WebP");
  assertEquals(h.server.commands, []);
});

Deno.test("the commit script is downloaded once and only if it looks like the script", async () => {
  const h = await harness();
  await h.run("reply", "x", ROOT, "one");
  await h.run("reply", "x", ROOT, "two");
  assertEquals(h.server.fetched.filter((u) => u.endsWith("/commit")).length, 1);

  const bad = await harness({
    server: fakeRuntime({
      routes: { [`${API}/${ROOT}`]: { data: commitJson(ROOT, null) } },
      texts: { "https://dev-null.sh/commit": "<html>nope</html>" },
    }),
  });
  assertEquals(await bad.run("reply", "x", ROOT, "hi"), 1);
  assertStringIncludes(bad.agent.err.join(""), "did not serve the commit script");
  assertEquals(bad.server.commands, []);
});

Deno.test("a failing commit script surfaces its message and records nothing", async () => {
  const h = await harness({
    server: serverRuntime({
      command: () => ({
        code: 1,
        stdout: "",
        stderr: "devnull: None of your SSH keys are on GitHub",
      }),
    }),
  });

  assertEquals(await h.run("reply", "x", ROOT, "hi"), 1);

  assertStringIncludes(h.agent.err.join(""), "None of your SSH keys");
  assertEquals(await h.run("list"), 0);
  assertStringIncludes(h.agent.err.join(""), "no subscriptions");
});

Deno.test("unwatch stops delivery to that subscriber only", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  await h.run("watch", "y", ROOT);
  await h.run("unwatch", "x", ROOT);
  assertStringIncludes(h.agent.out.join(""), `x no longer follows 1 commit(s) under ${ROOT}`);
  h.agent.out.length = 0;
  ingest(h.server.openDb(), [message(uuid(3), ROOT)]);

  await h.run("read", "x");
  assertEquals(h.jsonLines(), []);
  await h.run("read", "y");
  assertEquals(h.jsonLines().length, 1);
});

Deno.test("list shows each subscriber's threads", async () => {
  const h = await harness();
  await h.run("watch", "x", ROOT);
  h.agent.out.length = 0;
  assertEquals(await h.run("list"), 0);
  assertEquals(h.agent.out.join(""), `x\t${ROOT}\n`);
});

Deno.test("status fails while the server's poller is down", async () => {
  const h = await harness();
  assertEquals(await h.run("status"), 1);
  assertStringIncludes(h.agent.out.join(""), "DOWN");
});

Deno.test("status says whose replies the bridge takes, which account it posts as, and where", async () => {
  const h = await harness({ config: { authors: ["alice", "bob"], botUser: "alice-bot" } });
  setMeta(h.server.openDb(), "poller_heartbeat", h.server.now().toISOString());

  assertEquals(await h.run("status"), 0);

  assertStringIncludes(
    h.agent.out.join(""),
    "listening to: @alice, @bob\nposting as: @alice-bot\nserver: https://bridge.example (this machine: box-1)\n",
  );
});

Deno.test("every command but help needs a login", async () => {
  const h = await harness();
  h.agent.env = {};
  assertEquals(await h.run("read", "x"), 2);
  assertStringIncludes(h.agent.err.join(""), "Not logged in. Run: devnull-bridge login <server>");
  assertEquals(await h.run("help"), 0);
});

Deno.test("an unknown command is a usage error; help is not", async () => {
  const h = await harness();
  assertEquals(await h.run("nope"), 2);
  assertEquals(await h.run(), 0);
  assertStringIncludes(h.agent.out.join(""), "Usage:");
});

Deno.test("using a token marks it as used", async () => {
  const h = await harness();
  assertEquals(listTokens(h.server.openDb())[0]!.lastUsedAt, null);
  await h.run("list");
  assertEquals(listTokens(h.server.openDb())[0]!.lastUsedAt, h.server.now().toISOString());
});
