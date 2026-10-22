import { assertEquals } from "@std/assert";

/**
 * The CLI runs on every machine and must never be able to reach the server's code (which runs the
 * commit script with the bot's SSH key), so nothing in agent/ imports from outside it.
 */
Deno.test("the CLI imports nothing from outside agent/", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
    if (!entry.name.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, import.meta.url));
    for (const match of text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith("../") || specifier.startsWith("/")) {
        offenders.push(`${entry.name}: ${specifier}`);
      }
    }
  }
  assertEquals(offenders, []);
});
