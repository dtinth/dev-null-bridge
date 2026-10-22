/**
 * Every external effect of the CLI goes through here, so it can be tested without a network, a
 * clock or a disk. The CLI never runs a subprocess and never touches an SSH key: posting happens on
 * the server.
 */
export interface Runtime {
  env: Record<string, string>;
  now(): Date;
  fetch: typeof fetch;
  stdout(text: string): void;
  stderr(text: string): void;
  sleep(ms: number): Promise<void>;
  /** Everything piped into the process, or null when stdin is a terminal. */
  readStdin(): Promise<string | null>;
  /** A file's bytes, or null when there is no such file. */
  readFile(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  readTextFile(path: string): Promise<string | null>;
  /** Writes a file only its owner can read, making its directory if needed. */
  writeTextFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  hostname(): string;
}
