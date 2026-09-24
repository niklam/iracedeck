import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/claude-rules-frontmatter.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rulesDir = join(repoRoot, ".claude", "rules");

// Claude Code warns once the always-loaded instruction files exceed this many
// characters in total. The budget is shared with the user's own global rules
// and memory, so the repo keeps a margin below it.
const ALWAYS_LOADED_LIMIT = 150_000;
const REPO_BUDGET = 130_000;

const rules = readdirSync(rulesDir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ name, text: readFileSync(join(rulesDir, name), "utf-8").replace(/\r\n/g, "\n") }));

/**
 * The frontmatter as Claude Code's loader reads it: from a leading `---` line to
 * the next `---` ANYWHERE — including inside a markdown table row. Returns null
 * when the file has no frontmatter.
 */
function frontmatterOf(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("---", 4);
  return { body: text.slice(4, end), closesCleanly: text[end - 1] === "\n" && text.slice(end, end + 4) === "---\n" };
}

describe(".claude/rules frontmatter", () => {
  it.each(rules.map((r) => [r.name, r.text]))("%s closes its frontmatter on its own line", (_name, text) => {
    // A lone leading `---` used to swallow everything up to the first table row,
    // so whole sections of seven rules never reached Claude.
    const fm = frontmatterOf(text);
    if (fm === null) return;
    expect(fm.closesCleanly).toBe(true);
    expect(fm.body.trim()).not.toBe("");
    expect(fm.body).not.toMatch(/^#/m);
  });

  it(`keeps the always-loaded instructions under ${REPO_BUDGET} chars (Claude Code warns at ${ALWAYS_LOADED_LIMIT})`, () => {
    const always = rules.filter((r) => !frontmatterOf(r.text)?.body.includes("paths:"));
    const claudeMd = readFileSync(join(repoRoot, ".claude", "CLAUDE.md"), "utf-8");
    const total = always.reduce((sum, r) => sum + r.text.length, claudeMd.length);
    const listing = always.map((r) => `${r.name} (${r.text.length})`).join(", ");
    expect(total, `always loaded: CLAUDE.md (${claudeMd.length}), ${listing}`).toBeLessThanOrEqual(REPO_BUDGET);
  });
});
