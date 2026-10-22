/**
 * The bot's SSH key is made by the server on its first start and never leaves it: the web UI shows
 * the public half to add to the bot's GitHub. It lives next to the sqlite file, in a home of its
 * own that the commit script runs with, so it survives redeploys and nothing else is in its ~/.ssh.
 */
import type { CommandResult, Runtime } from "./runtime.ts";

/** The HOME the commit script runs with; the key is its ~/.ssh/id_ed25519. */
export function botHome(rt: Runtime): string {
  return `${rt.dataDir()}/bot`;
}

export function botKeyPath(rt: Runtime): string {
  return `${botHome(rt)}/.ssh/id_ed25519`;
}

/** The public key, or null before the server has made one. */
export async function readBotKey(rt: Runtime): Promise<string | null> {
  return (await rt.readTextFile(`${botKeyPath(rt)}.pub`))?.trim() || null;
}

/**
 * The public key, made (once) if there is none. A private key put there without its .pub (or left
 * by an interrupted start) gets its .pub derived instead: ssh-keygen would not overwrite it.
 */
export async function ensureBotKey(rt: Runtime, bot: string): Promise<string> {
  const existing = await readBotKey(rt);
  if (existing !== null) return existing;

  const path = botKeyPath(rt);
  if (await rt.readTextFile(path) !== null) {
    const derived = await rt.runCommand("ssh-keygen", ["-y", "-f", path]);
    const publicKey = derived.stdout.trim();
    if (derived.code !== 0 || publicKey === "") {
      throw new Error(`Could not read the bot's SSH key at ${path}: ${output(derived)}`);
    }
    await rt.writeTextFile(`${path}.pub`, `${publicKey}\n`);
    return publicKey;
  }

  await rt.makePrivateDir(path.slice(0, path.lastIndexOf("/")));
  const made = await rt.runCommand("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    `${bot}@dev-null-bridge`,
    "-f",
    path,
  ]);
  const publicKey = await readBotKey(rt);
  if (made.code !== 0 || publicKey === null) {
    throw new Error(`Could not make the bot's SSH key: ${output(made)}`);
  }
  return publicKey;
}

function output(result: CommandResult): string {
  return (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
}

/** "ssh-ed25519 AAAA…" without the comment, the way GitHub publishes keys. */
function keyId(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(" ");
}

/**
 * Whether github.com/<bot>.keys (what dev-null.sh checks signatures against) lists the key; null
 * when GitHub could not be asked.
 */
export async function keyOnGitHub(
  rt: Runtime,
  bot: string,
  publicKey: string,
): Promise<boolean | null> {
  try {
    const response = await rt.fetch(`https://github.com/${encodeURIComponent(bot)}.keys`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const keys = (await response.text()).split("\n").map(keyId);
    return keys.includes(keyId(publicKey));
  } catch {
    return null;
  }
}
