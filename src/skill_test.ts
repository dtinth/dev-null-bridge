import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml";

const SKILL = new URL("../skills/dev-null-bridge/SKILL.md", import.meta.url);

/** GitHub and Claude Code both read the front matter as YAML, so it has to parse as YAML. */
Deno.test("the skill's front matter is valid YAML with a name and a description", async () => {
  const text = await Deno.readTextFile(SKILL);
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (match === null) throw new Error("SKILL.md has no front matter.");

  const front = parse(match[1]!) as Record<string, unknown>;

  assertEquals(front["name"], "dev-null-bridge");
  assertEquals(typeof front["description"], "string");
  assertStringIncludes(front["description"] as string, "dev-null.sh");
});

/** The bridge is meant for anyone: the skill reads names from `devnull-bridge status` instead. */
Deno.test("the skill names no particular person or bot account", async () => {
  const text = await Deno.readTextFile(SKILL);
  assertEquals(/dtinth/i.test(text), false);
});
