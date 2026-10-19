/**
 * Posting goes through dev-null.sh's own commit script, which signs with an SSH key from the
 * agent or ~/.ssh and never touches the private key. The bridge never reimplements the signing.
 */
import { baseUrl, type Runtime } from "./runtime.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The commit script to run: $BRIDGE_COMMIT_SCRIPT, or the one the site serves at /commit,
 * downloaded once into the cache (never piped into a shell) after checking it looks right.
 * Delete the cached file to fetch it again.
 */
export async function ensureCommitScript(rt: Runtime): Promise<string> {
  const override = rt.env["BRIDGE_COMMIT_SCRIPT"];
  if (override) return override;

  const path = `${rt.cacheDir()}/commit.sh`;
  if (await rt.readTextFile(path) !== null) return path;

  const url = `${baseUrl(rt.env)}/commit`;
  const response = await rt.fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the commit script from ${url} (${response.status}).`);
  }

  const script = await response.text();
  if (
    !script.startsWith("#!/usr/bin/env bash") || !script.includes("ssh-keygen -Y sign") ||
    script.includes("__DEVNULL_URL__")
  ) {
    throw new Error(`${url} did not serve the commit script. Set BRIDGE_COMMIT_SCRIPT to a copy.`);
  }

  await rt.writeTextFile(path, script);
  return path;
}

export interface PostOptions {
  /** Short hash (or link) of the commit to reply to. */
  replyTo?: string;
  images: string[];
  text: string;
}

export interface PostResult {
  id: string;
  url: string;
}

export async function postCommit(rt: Runtime, options: PostOptions): Promise<PostResult> {
  const script = await ensureCommitScript(rt);
  const args = [
    script,
    ...(options.replyTo === undefined ? [] : ["--reply", options.replyTo]),
    ...options.images.flatMap((path) => ["--image", path]),
    "--",
    options.text,
  ];

  const result = await rt.runCommand("bash", args, { DEVNULL_URL: baseUrl(rt.env) });
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() || `The commit script failed (${result.code}).`,
    );
  }

  const url = result.stdout.match(/Committed: (\S+)/)?.[1];
  const id = url?.match(UUID)?.[0];
  if (url === undefined || id === undefined) {
    throw new Error(`The commit script said something unexpected: ${result.stdout.trim()}`);
  }
  return { id: id.toLowerCase(), url };
}
