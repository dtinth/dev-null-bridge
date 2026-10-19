/**
 * The daemon half: reads the allowed authors' replies feed and stores what is new. Only the
 * replies feed is read, and only its first page (20 newest), so strangers can never get a message
 * in, and nothing older than the last 20 replies is ever missed unless 20 arrive between two polls.
 */
import type { Api } from "./api.ts";
import { type Db, ingest, setMeta } from "./db.ts";
import type { Runtime } from "./runtime.ts";

/** One round. Returns how many messages were new. */
export async function pollOnce(
  db: Db,
  api: Api,
  authors: string[],
  now: Date,
): Promise<number> {
  let added = 0;
  for (const author of authors) {
    const commits = await api.listCommits(author, { replies: true });
    // The feed is already per author; checking again keeps that true even if the API changes.
    added += ingest(db, commits.filter((commit) => commit.author === author));
  }
  setMeta(db, "poller_heartbeat", now.toISOString());
  return added;
}

export interface PollerOptions {
  authors: string[];
  intervalMs: number;
  /** Checked before each round; tests use it to stop after a few. */
  shouldStop?: () => boolean;
}

export async function runPoller(
  rt: Runtime,
  db: Db,
  api: Api,
  options: PollerOptions,
): Promise<void> {
  rt.stderr(
    `polling the replies of ${options.authors.join(", ")} every ${options.intervalMs / 1000}s\n`,
  );

  while (!options.shouldStop?.()) {
    try {
      const added = await pollOnce(db, api, options.authors, rt.now());
      if (added > 0) rt.stderr(`${rt.now().toISOString()} stored ${added} new message(s)\n`);
    } catch (error) {
      rt.stderr(
        `${rt.now().toISOString()} poll failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    await rt.sleep(options.intervalMs);
  }
}
