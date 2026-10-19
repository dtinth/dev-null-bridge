/** A commit on dev-null.sh, as the bridge stores and prints it. */
export interface Message {
  id: string;
  shortHash: string;
  parentId: string | null;
  author: string;
  body: string;
  /** Public URLs of the attached images, in order. */
  images: string[];
  htmlUrl: string;
  createdAt: string;
}

/** One JSON line per message, the shape `read`, `watch` and `long-poll` print. */
export function formatMessage(message: Message): string {
  return JSON.stringify({
    id: message.id,
    short_hash: message.shortHash,
    parent_id: message.parentId,
    author: message.author,
    body: message.body,
    images: message.images,
    html_url: message.htmlUrl,
    created_at: message.createdAt,
  });
}
