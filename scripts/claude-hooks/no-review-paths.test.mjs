import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isNoReviewPath, NO_REVIEW_PATHS } from "./no-review-paths.mjs";

describe("isNoReviewPath", () => {
  it("takes Claude-facing prose: rules, skills, agents and the CLAUDE.md files where the repo keeps them", () => {
    for (const file of [
      ".claude/rules/hooks.md",
      ".claude/rules/nested/deeper/x.md",
      ".claude/skills/issue-lead/SKILL.md",
      ".claude/agents/implementer.md",
      ".claude/CLAUDE.md",
      "scripts/CLAUDE.md",
      "packages/deck-core/CLAUDE.md",
      "packages/foo/CLAUDE.md",
    ])
      expect(isNoReviewPath(file), file).toBe(true);
  });

  it("refuses everything else, the near misses included", () => {
    for (const file of [
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/rules",
      ".claude/rules/",
      ".claude/skills",
      ".claude/agentsx/a.md",
      ".claude/rulesx/a.md",
      "x/.claude/rules/a.md",
      "README.md",
      "changelog.d/1648-x.md",
      "packages/website/src/content/docs/docs/index.md",
      "scripts/claude-hooks/rules-bash.mjs",
      "scripts/claude-hooks/rules-bash.test.mjs",
      "CLAUDE.md.bak",
      ".claude/skills/issue-lead/helper.mjs",
      ".claude/rules/notes.txt",
      ".claude/agents/x.json",
      "NOTCLAUDE.md",
      "packages/x/claude.md",
      "packages/x/CLAUDE.mdx",
      // A CLAUDE.md anywhere else: the website publishes its content folder as pages.
      "CLAUDE.md",
      "packages/website/src/content/docs/CLAUDE.md",
      "packages/foo/src/CLAUDE.md",
      "packages/CLAUDE.md",
      "scripts/claude-hooks/CLAUDE.md",
      "docs/CLAUDE.md",
    ])
      expect(isNoReviewPath(file), file).toBe(false);
  });

  it("refuses a path git would never print, so none can pass for prose", () => {
    for (const file of [
      ".claude/rules/../../scripts/x.mjs",
      ".claude/rules/./x.md",
      ".claude/rules//x.md",
      "/.claude/rules/x.md",
      ".claude\\rules\\x.md",
      "packages/../CLAUDE.md",
      "",
      undefined,
      null,
      42,
    ])
      expect(isNoReviewPath(file), String(file)).toBe(false);
  });
});

// The rule states the list in prose; this holds the two together (#1648).
describe("code-review.md states the same list", () => {
  const HEADING = "## PRs that skip CodeRabbit (#1648)";
  const rule = readFileSync(path.join(import.meta.dirname, "../../.claude/rules/code-review.md"), "utf8");

  /**
   * The backticked items of the first bullet list under the heading, or
   * `undefined` when the heading or the list is missing. The section ends at
   * the next heading of level 2 or above.
   */
  const statedList = (markdown) => {
    const lines = markdown.split(/\r?\n/);
    const start = lines.indexOf(HEADING);
    if (start < 0) return undefined;
    const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
    const section = lines.slice(start + 1, end < 0 ? undefined : end);
    const first = section.findIndex((l) => /^- /.test(l));
    if (first < 0) return undefined;
    const items = [];
    for (const line of section.slice(first)) {
      if (!/^- /.test(line)) break;
      for (const m of line.matchAll(/`([^`]+)`/g)) items.push(m[1]);
    }
    return items;
  };
  const sorted = (list) => [...list].sort();
  const matches = (markdown) => {
    const stated = statedList(markdown);
    return stated !== undefined && JSON.stringify(sorted(stated)) === JSON.stringify(sorted(NO_REVIEW_PATHS));
  };

  it("lists exactly the module's globs", () => {
    expect(sorted(statedList(rule) ?? [])).toEqual(sorted(NO_REVIEW_PATHS));
    expect(matches(rule)).toBe(true);
  });

  // Positive controls: the comparison fails for each way the two can drift.
  it("fails for a section that drifted from the module", () => {
    const section = rule.slice(rule.indexOf(HEADING));
    expect(section.startsWith(HEADING)).toBe(true);
    const mutations = [
      rule.replace("- `.claude/agents/**/*.md`\n", ""),
      rule.replace("- `scripts/CLAUDE.md`\n", "- `scripts/CLAUDE.md`\n- `README.md`\n"),
      rule.replace("`packages/*/CLAUDE.md`", "`**/CLAUDE.md`"),
      rule.replace("`.claude/skills/**/*.md`", "`.claude/skills/**`"),
      rule.replace(HEADING, "## PRs that skip review"),
      rule.replace(/^- `/gm, "* `"),
    ];
    for (const mutated of mutations) {
      expect(mutated).not.toBe(rule);
      expect(matches(mutated)).toBe(false);
    }
  });
});
