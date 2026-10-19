import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./cli.ts";
import { ingest } from "./db.ts";
import { commitJson, fakeRuntime } from "./fake_runtime.ts";
import { message, uuid } from "./test_util.ts";

const API = "https://dev-null.sh/api/v1/commits";
const ROOT = uuid(1);

function lines(rt: { out: string[] }): string[] {
  return rt.out.join("").split("\n").filter(Boolean);
}

function jsonLines(rt: { out: string[] }): Record<string, unknown>[] {
  return lines(rt).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}

const COMMIT_SCRIPT = "#!/usr/bin/env bash\nssh-keygen -Y sign\n";

function rtWithRoot() {
  return fakeRuntime({
    routes: { [`${API}/${ROOT}`]: { data: commitJson(ROOT, null, { body: "Please build X" }) } },
    texts: { "https://dev-null.sh/commit": COMMIT_SCRIPT },
    command: (_cmd, args) => ({
      code: 0,
      stdout: `Committed: https://dev-null.sh/@dtinth-bot/commits/${
        args.includes("--reply") ? uuid(2) : uuid(9)
      } (pending review)\n`,
      stderr: "",
    }),
  });
}

Deno.test("watch prints the commit and what has been said so far, then how to keep listening", async () => {
  const rt = rtWithRoot();
  ingest(rt.openDb(), [message(uuid(3), ROOT, { body: "an earlier reply" })]);

  assertEquals(await runCli(["watch", "x", ROOT], rt), 0);

  assertEquals(jsonLines(rt).map((m) => m["body"]), ["Please build X", "an earlier reply"]);
  assertStringIncludes(lines(rt).at(-1)!, `devnull-bridge long-poll x --after ${uuid(3)}`);
});

Deno.test("watch accepts a commit URL", async () => {
  const rt = rtWithRoot();
  assertEquals(await runCli(["watch", "x", `https://dev-null.sh/@dtinth/commits/${ROOT}`], rt), 0);
});

Deno.test("watch says so when the commit is not public", async () => {
  const rt = fakeRuntime();
  assertEquals(await runCli(["watch", "x", uuid(8)], rt), 1);
  assertStringIncludes(rt.err.join(""), "no public commit");
});

Deno.test("watch with a bad subscriber name is a usage error", async () => {
  const rt = rtWithRoot();
  assertEquals(await runCli(["watch", "has space", ROOT], rt), 2);
});

Deno.test("long-poll returns what is already there after the cursor, with the restart line", async () => {
  const rt = rtWithRoot();
  await runCli(["watch", "x", ROOT], rt);
  rt.out.length = 0;
  ingest(rt.openDb(), [
    message(uuid(3), ROOT, { body: "first" }),
    message(uuid(4), ROOT, { body: "second" }),
  ]);

  assertEquals(await runCli(["long-poll", "x", "--after", uuid(3)], rt), 0);

  assertEquals(jsonLines(rt).map((m) => m["body"]), ["second"]);
  const all = lines(rt);
  assertStringIncludes(all[0]!, "NEW MESSAGES");
  assertEquals(
    all.at(-1),
    `>>> Start this now, in the background, before anything else: devnull-bridge long-poll x --after ${
      uuid(4)
    }`,
  );
});

Deno.test("long-poll keeps its flags in the restart line", async () => {
  const rt = rtWithRoot();
  await runCli(["watch", "x", ROOT], rt);
  rt.out.length = 0;
  ingest(rt.openDb(), [message(uuid(3), ROOT)]);

  await runCli(["long-poll", "x", "--after", "0", "--interval", "2", "--timeout", "60"], rt);

  assertStringIncludes(
    lines(rt).at(-1)!,
    `devnull-bridge long-poll x --interval 2 --timeout 60 --after ${uuid(3)}`,
  );
});

Deno.test("long-poll gives up at the timeout and prints the same cursor to restart with", async () => {
  const rt = rtWithRoot();
  await runCli(["watch", "x", ROOT], rt);
  rt.out.length = 0;

  assertEquals(await runCli(["long-poll", "x", "--after", uuid(3), "--timeout", "5"], rt), 0);

  assertEquals(jsonLines(rt), []);
  assertStringIncludes(rt.out.join(""), "No new messages after 5s");
  assertStringIncludes(rt.out.join(""), `--timeout 5 --after ${uuid(3)}`);
});

Deno.test("long-poll warns when the poller has never run", async () => {
  const rt = rtWithRoot();
  await runCli(["long-poll", "x", "--after", "0", "--timeout", "1"], rt);
  assertStringIncludes(rt.err.join(""), "the poller has never run");
});

Deno.test("long-poll needs --after", async () => {
  assertEquals(await runCli(["long-poll", "x"], rtWithRoot()), 2);
});

Deno.test("reply posts through the commit script, follows the new commit and gets answers to it", async () => {
  const rt = rtWithRoot();
  await runCli(["watch", "x", ROOT], rt);
  rt.out.length = 0;

  assertEquals(
    await runCli(["reply", "x", ROOT, "--image", "a.png", "Done,", "see", "image"], rt),
    0,
  );

  const posted = rt.commands.at(-1)!;
  assertEquals(posted.cmd, "bash");
  assertEquals(posted.args.slice(1), [
    "--reply",
    "0000001",
    "--image",
    "a.png",
    "--",
    "Done, see image",
  ]);
  assertEquals(rt.files.get("/cache/commit.sh"), COMMIT_SCRIPT);
  assertStringIncludes(rt.out.join(""), `x follows ${uuid(2)}`);

  // dtinth answers the commit the bridge posted.
  ingest(rt.openDb(), [message(uuid(5), uuid(2), { body: "thanks" })]);
  rt.out.length = 0;
  await runCli(["read", "x"], rt);
  assertEquals(jsonLines(rt).map((m) => m["body"]), ["thanks"]);
});

Deno.test("the commit script is downloaded once and only if it looks like the script", async () => {
  const rt = rtWithRoot();
  await runCli(["reply", "x", ROOT, "one"], rt);
  await runCli(["reply", "x", ROOT, "two"], rt);
  assertEquals(rt.fetched.filter((u) => u.endsWith("/commit")).length, 1);

  const bad = fakeRuntime({
    routes: { [`${API}/${ROOT}`]: { data: commitJson(ROOT, null) } },
    texts: { "https://dev-null.sh/commit": "<html>nope</html>" },
  });
  assertEquals(await runCli(["reply", "x", ROOT, "hi"], bad), 1);
  assertStringIncludes(bad.err.join(""), "did not serve the commit script");
  assertEquals(bad.commands, []);
});

Deno.test("a failing commit script surfaces its message and records nothing", async () => {
  const rt = fakeRuntime({
    routes: { [`${API}/${ROOT}`]: { data: commitJson(ROOT, null) } },
    texts: { "https://dev-null.sh/commit": COMMIT_SCRIPT },
    command: () => ({
      code: 1,
      stdout: "",
      stderr: "devnull: None of your SSH keys are on GitHub",
    }),
  });

  assertEquals(await runCli(["reply", "x", ROOT, "hi"], rt), 1);

  assertStringIncludes(rt.err.join(""), "None of your SSH keys");
  assertEquals(await runCli(["list"], rt), 0);
  assertStringIncludes(rt.err.join(""), "no subscriptions");
});

Deno.test("unwatch stops delivery to that subscriber only", async () => {
  const rt = rtWithRoot();
  await runCli(["watch", "x", ROOT], rt);
  await runCli(["watch", "y", ROOT], rt);
  await runCli(["unwatch", "x", ROOT], rt);
  rt.out.length = 0;
  ingest(rt.openDb(), [message(uuid(3), ROOT)]);

  await runCli(["read", "x"], rt);
  assertEquals(jsonLines(rt), []);
  await runCli(["read", "y"], rt);
  assertEquals(jsonLines(rt).length, 1);
});

Deno.test("status fails while the poller is down", async () => {
  const rt = rtWithRoot();
  assertEquals(await runCli(["status"], rt), 1);
  assertStringIncludes(rt.out.join(""), "DOWN");
});

Deno.test("an unknown command is a usage error; help is not", async () => {
  assertEquals(await runCli(["nope"], rtWithRoot()), 2);
  const rt = rtWithRoot();
  assertEquals(await runCli([], rt), 0);
  assertStringIncludes(rt.out.join(""), "Usage:");
});
