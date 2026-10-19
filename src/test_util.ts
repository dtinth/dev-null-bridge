import type { Message } from "./types.ts";

/** A message with sensible defaults; ids only need to sort the way the test wants. */
export function message(
  id: string,
  parentId: string | null,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    shortHash: id.replaceAll("-", "").slice(-7),
    parentId,
    author: "dtinth",
    body: `body of ${id}`,
    images: [],
    htmlUrl: `https://dev-null.sh/@dtinth/commits/${id}`,
    createdAt: "2026-10-19T12:00:00Z",
    ...overrides,
  };
}

/** UUID-shaped ids that sort by their number, like UUIDv7 sorts by time. */
export function uuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}
