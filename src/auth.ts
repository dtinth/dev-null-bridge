/**
 * Who may use the server.
 *
 * - Machines (the CLI) send `Authorization: Bearer <token>`. A token is an opaque random string
 *   the CLI makes itself; the server only ever sees it on use and stores its SHA-256.
 * - People (the web UI) log in with GitHub. The session is a signed cookie naming the login, so
 *   the server keeps no session state and never holds the person's GitHub token after login.
 */

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The bearer token in a request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

// No vowels or look-alikes, so a code never spells anything and reads back easily.
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** A code for a person to compare between the terminal and the browser, like `HJKL-MNPQ`. */
export function newLoginCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}

/** How long a browser session lasts. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A cookie value naming `login` until `expiresAt`, signed with the server's secret. */
export async function signSession(login: string, expiresAt: Date, secret: string): Promise<string> {
  const payload = `${encodeURIComponent(login)}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/** The login a session cookie names, or null when it is forged, malformed or expired. */
export async function verifySession(
  cookie: string,
  secret: string,
  now: Date,
): Promise<string | null> {
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [login, expires, signature] = parts as [string, string, string];
  const expected = await hmac(secret, `${login}.${expires}`);
  if (!timingSafeEqual(signature, expected)) return null;
  if (Number(expires) * 1000 <= now.getTime()) return null;
  try {
    return decodeURIComponent(login);
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function randomState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function cookieHeader(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAge}${
    options.secure ? "; Secure" : ""
  }`;
}

export interface GitHubOAuth {
  clientId: string;
  clientSecret: string;
}

export function githubAuthorizeUrl(oauth: GitHubOAuth, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: redirectUri,
    state,
    allow_signup: "false",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

/** Trades the callback's code for the GitHub login of whoever signed in. */
export async function githubLogin(
  fetchFn: typeof fetch,
  oauth: GitHubOAuth,
  code: string,
  redirectUri: string,
): Promise<string> {
  const tokenResponse = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token: unknown = await tokenResponse.json();
  const accessToken = (token as Record<string, unknown> | null)?.["access_token"];
  if (!tokenResponse.ok || typeof accessToken !== "string") {
    throw new Error("GitHub did not accept the login.");
  }

  const userResponse = await fetchFn("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` },
  });
  const user: unknown = await userResponse.json();
  const login = (user as Record<string, unknown> | null)?.["login"];
  if (!userResponse.ok || typeof login !== "string") {
    throw new Error("GitHub did not say who logged in.");
  }
  return login;
}
