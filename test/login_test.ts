/** Logging a machine in, and the web UI that approves it and revokes it. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "../agent/cli.ts";
import { configPath } from "../agent/config.ts";
import { sha256Hex, signSession } from "../src/auth.ts";
import { listTokens } from "../src/db.ts";
import { createServer } from "../src/server.ts";
import { agentRuntime, harness, SERVER, serverConfig, serverRuntime } from "./harness.ts";

async function sessionCookie(login: string, now: Date): Promise<string> {
  const config = serverConfig();
  const expires = new Date(now.getTime() + 3600_000);
  return `bridge_session=${await signSession(login, expires, config.sessionSecret)}`;
}

function setup() {
  const server = serverRuntime();
  const handler = createServer(server, server.openDb(), serverConfig());
  const agent = agentRuntime(handler, { HOME: "/home/me" });
  return { server, handler, agent };
}

Deno.test("login: the CLI prints a link, a person approves it, and the CLI saves its token", async () => {
  const { server, handler, agent } = setup();
  const cookie = await sessionCookie("dtinth", server.now());
  let approvePage = "";
  let sleeps = 0;
  agent.sleep = async () => {
    // The person opens the link after the CLI has asked twice.
    if (++sleeps !== 2) return;
    const url = agent.out.join("").match(/https:\/\/bridge\.example\/approve\?code=(\S+)/)!;
    approvePage = await (await handler(new Request(url[0], { headers: { cookie } }))).text();
    const approved = await handler(
      new Request(`${SERVER}/approve`, {
        method: "POST",
        body: new URLSearchParams({ code: decodeURIComponent(url[1]!) }),
        headers: { cookie, origin: SERVER },
      }),
    );
    assertEquals(approved.status, 200);
  };

  assertEquals(await runCli(["login", "bridge.example", "--label", "laptop"], agent), 0);

  const out = agent.out.join("");
  const code = out.match(/the code ([A-Z]{4}-[A-Z]{4})/)![1]!;
  assertStringIncludes(approvePage, "laptop");
  assertStringIncludes(approvePage, code);
  assertStringIncludes(out, 'Logged in to https://bridge.example as "laptop".');

  const saved = JSON.parse(agent.files.get(configPath(agent.env))!);
  assertEquals(saved.server, SERVER);
  assert(saved.token.startsWith("dnb_"));
  const [token] = listTokens(server.openDb());
  assertEquals([token!.label, token!.approvedBy], ["laptop", "dtinth"]);

  // The server never stored the token itself, only its hash.
  const hash = await sha256Hex(saved.token);
  const row = server.openDb().prepare("SELECT hash FROM tokens").get()!;
  assertEquals(row["hash"], hash);
  const everything = JSON.stringify(server.openDb().prepare("SELECT * FROM tokens").all());
  assertEquals(everything.includes(saved.token), false);

  // And the saved token works.
  agent.out.length = 0;
  assertEquals(await runCli(["list"], agent), 0);
});

Deno.test("login: the label defaults to the hostname", async () => {
  const { server, handler, agent } = setup();
  const cookie = await sessionCookie("dtinth", server.now());
  agent.sleep = async () => {
    const code = agent.out.join("").match(/the code ([A-Z]{4}-[A-Z]{4})/)![1]!;
    await handler(
      new Request(`${SERVER}/approve`, {
        method: "POST",
        body: new URLSearchParams({ code }),
        headers: { cookie },
      }),
    );
  };

  assertEquals(await runCli(["login", SERVER], agent), 0);
  assertEquals(listTokens(server.openDb())[0]!.label, "box-1");
});

Deno.test("login: gives up after ten minutes without approval and saves nothing", async () => {
  const { agent } = setup();
  assertEquals(await runCli(["login", SERVER], agent), 1);
  assertStringIncludes(agent.err.join(""), "Nobody approved the login in 10 minutes");
  assertEquals(agent.files.size, 0);
});

Deno.test("login: a waiting request expires after ten minutes", async () => {
  const { server, handler } = setup();
  const started = await handler(
    new Request(`${SERVER}/api/logins`, {
      method: "POST",
      body: JSON.stringify({ label: "x", token_hash: "a".repeat(64) }),
    }),
  );
  const { code } = await started.json();
  server.clock.time += 11 * 60_000;
  const cookie = await sessionCookie("dtinth", server.now());

  const page = await handler(
    new Request(`${SERVER}/approve?code=${code}`, { headers: { cookie } }),
  );
  assertEquals(page.status, 404);
  const post = await handler(
    new Request(`${SERVER}/approve`, {
      method: "POST",
      body: new URLSearchParams({ code }),
      headers: { cookie },
    }),
  );
  assertEquals(post.status, 404);
  assertEquals(listTokens(server.openDb()), []);
});

Deno.test("login: asking again with the same token replaces the earlier request", async () => {
  const { handler } = setup();
  const start = () =>
    handler(
      new Request(`${SERVER}/api/logins`, {
        method: "POST",
        body: JSON.stringify({ label: "x", token_hash: "b".repeat(64) }),
      }),
    );
  assertEquals((await start()).status, 200);
  assertEquals((await start()).status, 200);
});

Deno.test("logout forgets the token here; revoking it on the server locks the machine out", async () => {
  const h = await harness();
  h.agent.env = { HOME: "/home/me" };
  h.agent.files.set(
    configPath(h.agent.env),
    JSON.stringify({ server: SERVER, token: "dnb_test-token" }),
  );
  assertEquals(await h.run("list"), 0);

  const cookie = await sessionCookie("dtinth", h.server.now());
  const tokens = await (await h.handler(new Request(`${SERVER}/tokens`, { headers: { cookie } })))
    .text();
  assertStringIncludes(tokens, "box-1");
  const id = listTokens(h.server.openDb())[0]!.id;
  const revoked = await h.handler(
    new Request(`${SERVER}/tokens/${id}/revoke`, { method: "POST", headers: { cookie } }),
  );
  assertEquals(revoked.status, 303);

  assertEquals(await h.run("list"), 1);
  assertStringIncludes(h.agent.err.join(""), "revoked");

  assertEquals(await h.run("logout"), 0);
  assertEquals(h.agent.files.size, 0);
});

Deno.test("the API refuses requests without a known token", async () => {
  const { handler } = setup();
  for (const authorization of [undefined, "Bearer nope", "Basic abc"]) {
    const response = await handler(
      new Request(`${SERVER}/api/messages?name=x`, {
        headers: authorization === undefined ? {} : { authorization },
      }),
    );
    assertEquals(response.status, 401);
  }
});

Deno.test("the web UI sends strangers to GitHub and back to where they were going", async () => {
  const { handler } = setup();

  const page = await handler(new Request(`${SERVER}/tokens`));
  assertEquals(page.status, 303);
  assertEquals(page.headers.get("location"), "/auth/login?next=%2Ftokens");

  const login = await handler(new Request(`${SERVER}/auth/login?next=%2Ftokens`));
  const location = new URL(login.headers.get("location")!);
  assertEquals(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
  assertEquals(location.searchParams.get("client_id"), "client");
  assertEquals(location.searchParams.get("redirect_uri"), `${SERVER}/auth/callback`);
  const cookie = login.headers.get("set-cookie")!;
  assertStringIncludes(cookie, "HttpOnly");
  assertStringIncludes(cookie, "Secure");
  assertStringIncludes(cookie, "SameSite=Lax");
});

function githubAnswering(login: string) {
  return serverRuntime({
    handle(request) {
      if (request.url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "gho_x" });
      }
      if (request.url === "https://api.github.com/user") {
        return request.headers.get("authorization") === "Bearer gho_x"
          ? Response.json({ login })
          : new Response("no", { status: 401 });
      }
      return undefined;
    },
  });
}

async function callback(handler: (r: Request) => Promise<Response>, next = "/tokens") {
  const login = await handler(new Request(`${SERVER}/auth/login?next=${encodeURIComponent(next)}`));
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return await handler(
    new Request(`${SERVER}/auth/callback?code=c&state=${state}`, {
      headers: { cookie: stateCookie },
    }),
  );
}

Deno.test("an allowed GitHub login gets a session and lands where it was going", async () => {
  const server = githubAnswering("dtinth");
  const handler = createServer(server, server.openDb(), serverConfig());

  const response = await callback(handler, "/threads/a.b/c");

  assertEquals(response.status, 303);
  assertEquals(response.headers.get("location"), "/threads/a.b/c");
  const session = response.headers.getSetCookie().find((c) => c.startsWith("bridge_session="))!;
  const tokens = await handler(
    new Request(`${SERVER}/tokens`, { headers: { cookie: session.split(";")[0]! } }),
  );
  assertEquals(tokens.status, 200);
  assertStringIncludes(await tokens.text(), "@dtinth");
});

Deno.test("a GitHub login not in BRIDGE_AUTHORS is turned away", async () => {
  const server = githubAnswering("mallory");
  const handler = createServer(server, server.openDb(), serverConfig());

  const response = await callback(handler);

  assertEquals(response.status, 403);
  assertEquals(response.headers.get("set-cookie"), null);
});

Deno.test("a callback without the matching state is refused", async () => {
  const server = githubAnswering("dtinth");
  const handler = createServer(server, server.openDb(), serverConfig());
  const response = await handler(
    new Request(`${SERVER}/auth/callback?code=c&state=forged`, {
      headers: { cookie: "bridge_oauth_state=real.%2F" },
    }),
  );
  assertEquals(response.status, 400);
});

Deno.test("a login never redirects off the server", async () => {
  const server = githubAnswering("dtinth");
  const handler = createServer(server, server.openDb(), serverConfig());
  for (const next of ["//evil.example", "https://evil.example", "evil"]) {
    assertEquals((await callback(handler, next)).headers.get("location"), "/");
  }
});

Deno.test("forged, expired or other people's session cookies do not open the web UI", async () => {
  const { server, handler } = setup();
  const good = await sessionCookie("dtinth", server.now());
  const cookies = [
    good.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
    await sessionCookie("mallory", server.now()),
    `bridge_session=${await signSession(
      "dtinth",
      new Date(server.now().getTime() - 1),
      serverConfig().sessionSecret,
    )}`,
  ];
  for (const cookie of cookies) {
    const response = await handler(new Request(`${SERVER}/tokens`, { headers: { cookie } }));
    assertEquals(response.status, 303);
  }
});

Deno.test("a form posted from another site is refused", async () => {
  const h = await harness();
  const cookie = await sessionCookie("dtinth", h.server.now());
  const id = listTokens(h.server.openDb())[0]!.id;
  const response = await h.handler(
    new Request(`${SERVER}/tokens/${id}/revoke`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
    }),
  );
  assertEquals(response.status, 403);
  assertEquals(listTokens(h.server.openDb()).length, 1);
});

Deno.test("logging out clears the session", async () => {
  const { server, handler } = setup();
  const cookie = await sessionCookie("dtinth", server.now());
  const response = await handler(
    new Request(`${SERVER}/auth/logout`, { method: "POST", headers: { cookie } }),
  );
  assertEquals(response.status, 303);
  assertStringIncludes(response.headers.get("set-cookie")!, "bridge_session=;");
  assertStringIncludes(response.headers.get("set-cookie")!, "Max-Age=0");
});

Deno.test("without a GitHub OAuth app the web UI is closed but the API works", async () => {
  const h = await harness({ config: { oauth: null } });
  assertEquals((await h.handler(new Request(`${SERVER}/`))).status, 503);
  assertEquals(await h.run("list"), 0);
});
