/** Calls the server's API with the machine's token. */
import type { Config } from "./config.ts";
import type { Runtime } from "./runtime.ts";

/** The server answered with an error; `status` is 0 when it could not be reached at all. */
export class ServerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ServerError";
  }
}

export type Json = Record<string, unknown>;

export interface Client {
  get(path: string, query?: Record<string, string | undefined>): Promise<Json>;
  post(path: string, body: Json | FormData): Promise<Json>;
}

export function createClient(rt: Runtime, config: Config): Client {
  async function call(path: string, init: RequestInit): Promise<Json> {
    let response: Response;
    try {
      response = await rt.fetch(`${config.server}${path}`, {
        ...init,
        headers: {
          ...init.headers as Record<string, string>,
          authorization: `Bearer ${config.token}`,
        },
      });
    } catch (error) {
      throw new ServerError(
        `Could not reach ${config.server}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        0,
      );
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // Answered below.
    }
    const body = typeof json === "object" && json !== null ? json as Json : {};
    if (!response.ok) {
      const message = typeof body["error"] === "string"
        ? body["error"]
        : `${config.server}${path} answered ${response.status}.`;
      throw new ServerError(message, response.status);
    }
    return body;
  }

  return {
    get(path, query = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, value);
      }
      const search = params.size === 0 ? "" : `?${params}`;
      return call(`${path}${search}`, { method: "GET" });
    },
    post(path, body) {
      return body instanceof FormData ? call(path, { method: "POST", body }) : call(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
    },
  };
}
