/** The public, unauthenticated half of the dev-null.sh API: what the bridge needs to read. */
import type { Message } from "./types.ts";

export const DEFAULT_BASE_URL = "https://dev-null.sh";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Api {
  /** Page one of a user's commits, newest first: top-level ones, or their replies. */
  listCommits(username: string, options: { replies: boolean }): Promise<Message[]>;
  /** One commit by its full id, or null when there is none (or it is not public). */
  getCommit(id: string): Promise<Message | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCommit(raw: unknown): Message {
  if (!isRecord(raw)) throw new ApiError("Unexpected commit in the API response.");

  const { id, short_hash, parent_id, body, html_url, created_at, images, author } = raw;

  if (
    typeof id !== "string" || typeof short_hash !== "string" || typeof body !== "string" ||
    typeof html_url !== "string" || typeof created_at !== "string" || !isRecord(author) ||
    typeof author["username"] !== "string"
  ) {
    throw new ApiError("Unexpected commit in the API response.");
  }

  return {
    id,
    shortHash: short_hash,
    parentId: typeof parent_id === "string" ? parent_id : null,
    author: author["username"],
    body,
    images: Array.isArray(images)
      ? images.flatMap((image) =>
        isRecord(image) && typeof image["url"] === "string" ? [image["url"]] : []
      )
      : [],
    htmlUrl: html_url,
    createdAt: created_at,
  };
}

export function createApi(fetchFn: typeof fetch, baseUrl: string = DEFAULT_BASE_URL): Api {
  async function get(path: string): Promise<Response> {
    try {
      return await fetchFn(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new ApiError(
        `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    async listCommits(username, { replies }) {
      const path = `/api/v1/users/${encodeURIComponent(username)}/commits${
        replies ? "?replies=1" : ""
      }`;
      const response = await get(path);
      if (!response.ok) {
        throw new ApiError(`GET ${path} answered ${response.status}.`, response.status);
      }

      const json: unknown = await response.json();
      if (!isRecord(json) || !Array.isArray(json["data"])) {
        throw new ApiError(`GET ${path} answered something unexpected.`);
      }
      return json["data"].map(parseCommit);
    },

    async getCommit(id) {
      const path = `/api/v1/commits/${encodeURIComponent(id)}`;
      const response = await get(path);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        throw new ApiError(`GET ${path} answered ${response.status}.`, response.status);
      }

      const json: unknown = await response.json();
      if (!isRecord(json)) throw new ApiError(`GET ${path} answered something unexpected.`);
      return parseCommit(json["data"]);
    },
  };
}
