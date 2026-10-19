/**
 * `long-poll` blocks inside one command until something new arrives, then exits and prints the
 * exact command to run next, so an agent restarts the watch by copying a line, not by remembering
 * to bump `--after`. Stateless on purpose, like `claw long-poll`: the cursor is the only state.
 */
import { type Db, getMeta, readMessages } from "./db.ts";
import type { Runtime } from "./runtime.ts";
import type { Message } from "./types.ts";

export const CLI_NAME = "devnull-bridge";

/** How long without a heartbeat before the poller counts as down. */
const STALE_POLLER_MS = 120_000;

export interface LongPollCommand {
  name: string;
  after: string;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
}

/** The exact invocation to run next: same flags, `--after` moved on. */
export function formatLongPollCommand(command: LongPollCommand): string {
  const parts = [CLI_NAME, "long-poll", command.name];
  if (command.intervalSeconds !== undefined) {
    parts.push("--interval", String(command.intervalSeconds));
  }
  if (command.timeoutSeconds !== undefined) parts.push("--timeout", String(command.timeoutSeconds));
  parts.push("--after", command.after);
  return parts.join(" ");
}

export function lastId(messages: Message[], fallback: string): string {
  return messages.at(-1)?.id ?? fallback;
}

/** A sentence for stderr when the poller has not run lately, or null when it is fine. */
export function pollerWarning(db: Db, now: Date): string | null {
  const heartbeat = getMeta(db, "poller_heartbeat");
  if (heartbeat === null) {
    return "the poller has never run, so nothing new will arrive. Start it: pitchfork start dev-null-bridge";
  }
  const age = now.getTime() - Date.parse(heartbeat);
  if (age > STALE_POLLER_MS) {
    return `the poller has not run for ${
      Math.round(age / 1000)
    }s, so nothing new will arrive. Start it: pitchfork start dev-null-bridge`;
  }
  return null;
}

export interface LongPollParams {
  name: string;
  after: string;
  intervalMs: number;
  /** Give up after this long and report nothing; unset waits forever. */
  timeoutMs?: number | undefined;
}

export async function waitForMessages(
  rt: Runtime,
  db: Db,
  params: LongPollParams,
): Promise<Message[]> {
  const deadline = params.timeoutMs === undefined ? null : rt.now().getTime() + params.timeoutMs;

  while (true) {
    const messages = readMessages(db, params.name, params.after);
    if (messages.length > 0) return messages;
    if (deadline !== null && rt.now().getTime() >= deadline) return [];
    await rt.sleep(params.intervalMs);
  }
}
