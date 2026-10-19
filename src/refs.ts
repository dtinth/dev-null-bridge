/**
 * Commits are named by a full id, by their URL, or by the 7-character short hash the site shows.
 * The API only takes full ids, so a short hash has to be found first.
 */
import type { Api } from "./api.ts";
import { type Db, findIdsByShortHash } from "./db.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHORT = /^[0-9a-f]{7}$/i;

export type CommitRef = { kind: "id"; id: string } | { kind: "short"; short: string };

export function parseCommitRef(input: string): CommitRef | null {
  const text = input.trim();
  const uuid = text.match(UUID);
  if (uuid) return { kind: "id", id: uuid[0].toLowerCase() };
  if (SHORT.test(text)) return { kind: "short", short: text.toLowerCase() };
  return null;
}

/** The short hash the site shows: the last 7 hex digits of the id. */
export function shortHashOf(id: string): string {
  return id.replaceAll("-", "").slice(-7);
}

export interface ResolveDeps {
  db: Db;
  api: Api;
  /** Whose feeds to look through when the database does not know the hash. */
  users: string[];
}

export async function resolveRef(input: string, deps: ResolveDeps): Promise<string> {
  const ref = parseCommitRef(input);
  if (ref === null) {
    throw new Error(`"${input}" is not a commit: pass its URL, its id, or its 7-character hash.`);
  }
  if (ref.kind === "id") return ref.id;

  const known = findIdsByShortHash(deps.db, ref.short);
  if (known.length === 1) return known[0]!;
  if (known.length > 1) {
    throw new Error(`The hash ${ref.short} matches more than one commit: pass its URL.`);
  }

  const found = new Set<string>();
  for (const user of deps.users) {
    for (const replies of [false, true]) {
      for (const commit of await deps.api.listCommits(user, { replies })) {
        if (commit.shortHash === ref.short) found.add(commit.id);
      }
    }
  }
  if (found.size === 1) return [...found][0]!;
  if (found.size > 1) {
    throw new Error(`The hash ${ref.short} matches more than one commit: pass its URL.`);
  }
  throw new Error(`Could not find a commit with the hash ${ref.short}: pass its URL.`);
}
