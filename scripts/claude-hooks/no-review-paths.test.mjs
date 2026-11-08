import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  frontmatterBlock,
  frontmatterChanged,
  hasConfigFrontmatter,
  isNoReviewPath,
  NO_REVIEW_PATHS,
} from "./no-review-paths.mjs";

// #1648 third round: a skill's or agent's frontmatter is configuration.
describe("the frontmatter of a skill or agent", () => {
  const SKILL = "---\nname: x\nallowed-tools: Read\n---\n\n# X\n\nBody.\n";

  it("is checked under .claude/skills/ and .claude/agents/ only", () => {
    for (const file of [".claude/skills/x/SKILL.md", ".claude/skills/x/ref.md", ".claude/agents/qa.md"])
      expect(hasConfigFrontmatter(file), file).toBe(true);
    for (const file of [".claude/rules/hooks.md", ".claude/CLAUDE.md", "scripts/CLAUDE.md", ".claude/skillsx/a.md"])
      expect(hasConfigFrontmatter(file), file).toBe(false);
  });

  it("is the block from the first byte through the closing line", () => {
    expect(frontmatterBlock(SKILL)).toBe("---\nname: x\nallowed-tools: Read\n---\n");
    expect(frontmatterBlock("---\r\nname: x\r\n---\r\nbody\r\n")).toBe("---\r\nname: x\r\n---\r\n");
    expect(frontmatterBlock("---\nname: x\n---")).toBe("---\nname: x\n---");
    // Read wider than a loader: a BOM or leading whitespace still opens one, and is part of it.
    expect(frontmatterBlock("\xEF\xBB\xBF---\na: 1\n---\nbody")).toBe("\xEF\xBB\xBF---\na: 1\n---\n");
    expect(frontmatterBlock("\n  ---\na: 1\n---\nbody")).toBe("\n  ---\na: 1\n---\n");
    // Unterminated: all of it.
    expect(frontmatterBlock("---\na: 1\nbody\n")).toBe("---\na: 1\nbody\n");
    expect(frontmatterBlock("---")).toBe("---");
    // None at all is an empty block, and a later `---` is body.
    expect(frontmatterBlock("# X\n\n---\na: 1\n---\n")).toBe("");
    expect(frontmatterBlock("")).toBe("");
  });

  it("counts a body-only edit as unchanged, and anything in the block as a change", () => {
    expect(frontmatterChanged(SKILL, SKILL.replace("Body.", "New body.\n\n---\n\nMore."))).toBe(false);
    expect(frontmatterChanged("# none\n", "# still none\n")).toBe(false);
    for (const head of [
      SKILL.replace("allowed-tools: Read", "allowed-tools: Bash"),
      SKILL.replace("name: x\n", "name: x\nhooks: {}\n"),
      SKILL.replace("---\n\n# X", "--- \n\n# X"),
      `---\npermissionMode: bypassPermissions\n---\n${SKILL}`,
      SKILL.replace(/^---\n/, ""),
    ])
      expect(frontmatterChanged(SKILL, head), JSON.stringify(head)).toBe(true);
    // Added from nothing, or to a file that had none.
    expect(frontmatterChanged("# X\n", `---\ntools: Bash\n---\n# X\n`)).toBe(true);
  });

  it("counts a missing side — an added or deleted file, or an unread one — as a change", () => {
    for (const [base, head] of [
      [null, SKILL],
      [SKILL, null],
      [undefined, SKILL],
      [SKILL, undefined],
      [null, null],
    ])
      expect(frontmatterChanged(base, head)).toBe(true);
  });
});

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
