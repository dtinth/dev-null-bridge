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

/** The JSON shape the API sends and the CLI prints, one line per message. */
export function messageJson(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    short_hash: message.shortHash,
    parent_id: message.parentId,
    author: message.author,
    body: message.body,
    images: message.images,
    html_url: message.htmlUrl,
    created_at: message.createdAt,
  };
}
