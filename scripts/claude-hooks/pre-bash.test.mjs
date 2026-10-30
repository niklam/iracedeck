import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The rule modules are tested directly; this proves the wiring around them —
// stdin payload, context, verdict JSON — by running the entry point the
// harness runs (`.claude/rules/hooks.md` rule 6, #1307 review). Only commands whose
// verdict needs no network are used, so it runs anywhere.
const HOOK = path.join(import.meta.dirname, "pre-bash.mjs");

function fire(command, { tool = "Bash", cwd = import.meta.dirname, env } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }),
    encoding: "utf8",
    timeout: 60_000,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

describe("pre-bash.mjs, fired as the harness fires it", () => {
  it("denies a trapped shape with the rule's reason", () => {
    const v = fire("pnpm exec vitest run");
    expect(v.hookEventName).toBe("PreToolUse");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/vitest/);
  });

  // Judged against the manifests of the checkout the command runs in — this
  // one — so it holds in a worktree whose scripts differ from master's (#1021).
  it("lets a package's own test script run, and refuses one the package lacks", () => {
    expect(fire("pnpm --filter @iracedeck/logger test")).toBeNull();
    const v = fire("pnpm --filter @iracedeck/iracing-plugin-mirabox test");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/no "test" script/);
  });

  it("refuses two merges in one command before asking GitHub anything", () => {
    const v = fire("gh pr merge 7 --squash & gh pr merge 8 --squash");
    expect(v.permissionDecision).toBe("deny");
    expect(v.permissionDecisionReason).toMatch(/One `gh pr merge` per command/);
  });

  it("prints nothing for a command no rule names", () => expect(fire("git status")).toBeNull());
});

// #1520: the PowerShell tool's commands go through the same hook, with the
// rules that are not bash syntax.
describe("pre-bash.mjs, fired for the PowerShell tool", () => {
  // A deck link of our own: APPDATA points at a temp folder whose Stream Deck
  // plugin link is a junction into a temp "tree", so the ask does not hinge on
  // where this machine's real hosts are linked. Neither folder is a git repo,
  // so the tree is the directory itself.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pre-bash-ps-"));
  const linkedTree = path.join(tmp, "linked");
  const otherTree = path.join(tmp, "other");
  const appdata = path.join(tmp, "appdata");
  const plugins = path.join(appdata, "Elgato", "StreamDeck", "Plugins");
  for (const d of [path.join(linkedTree, "plugin"), otherTree, plugins]) mkdirSync(d, { recursive: true });
  symlinkSync(path.join(linkedTree, "plugin"), path.join(plugins, "com.iracedeck.sd.core.sdPlugin"), "junction");
  const env = {
    APPDATA: appdata,
    MIRABOX_PLUGINS_DIR: path.join(tmp, "none"),
    ULANZI_PLUGINS_DIR: path.join(tmp, "none"),
  };
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // The bypass itself: the harness only runs this hook for the tools its matcher names.
  it("is wired for both tools in .claude/settings.json", () => {
    const settings = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "..", "..", ".claude", "settings.json"), "utf8"),
    );
    const entries = settings.hooks.PreToolUse.filter((e) => e.hooks.some((h) => h.command.includes("pre-bash.mjs")));
    expect(entries).toHaveLength(1);
    const matcher = new RegExp(`^(?:${entries[0].matcher})$`);
    for (const tool of ["Bash", "PowerShell"]) expect(matcher.test(tool), tool).toBe(true);
    expect(matcher.test("Edit")).toBe(false);
  });

  // `dev:voices` relinks the hosts linked to its tree, so it asks there and
  // nowhere else; a build needs no go even there (#1526).
  it("asks for dev:voices in the linked tree, as for the Bash tool, and passes a build there", () => {
    const v = fire("pnpm dev:voices on", { tool: "PowerShell", cwd: linkedTree, env });
    expect(v.permissionDecision).toBe("ask");
    expect(v.permissionDecisionReason).toMatch(/Stream Deck plugin link points into/);
    // Positive control: the same payload from the Bash tool asks too, and an unlinked tree passes.
    expect(fire("pnpm dev:voices on", { cwd: linkedTree, env }).permissionDecision).toBe("ask");
    expect(fire("pnpm dev:voices on", { tool: "PowerShell", cwd: otherTree, env })).toBeNull();
    for (const tool of ["Bash", "PowerShell"])
      for (const c of ["pnpm build", "pnpm install"]) expect(fire(c, { tool, cwd: linkedTree, env }), c).toBeNull();
  });

  it("follows a Set-Location into the linked tree", () =>
    expect(
      fire(`Set-Location '${linkedTree}'; pnpm dev:voices on`, { tool: "PowerShell", cwd: otherTree, env })
        .permissionDecision,
    ).toBe("ask"));

  it("asks for a restart wherever it runs", () => {
    for (const cwd of [linkedTree, otherTree])
      expect(fire("pnpm restart:stream-deck", { tool: "PowerShell", cwd, env }).permissionDecisionReason).toMatch(
        /No deck host restarts, stops, starts or relinks without Niklas's go/,
      );
  });

  it("denies an integration push", () =>
    expect(fire("git push origin integration", { tool: "PowerShell" }).permissionDecisionReason).toMatch(
      /never pushed/,
    ));

  // #1520 second read: a script is judged by the command line its package.json gives it.
  it("reads a script's command line from the package.json it runs from", () => {
    // `watch` is the Stream Deck plugin's real shape: the restart sits in a
    // quoted rollup option, escaped once more by the JSON it is read from.
    const scripts = {
      hop: "pnpm relink:anything",
      voices: "pnpm dev:voices on",
      watch: 'rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"',
      wipe: "rimraf plugin/bin",
      quiet: "vitest run",
    };
    for (const d of [linkedTree, otherTree])
      writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "fixture", scripts }));
    for (const tool of ["Bash", "PowerShell"]) {
      expect(fire("pnpm hop", { tool, cwd: otherTree, env }).permissionDecisionReason).toMatch(
        /`pnpm hop` → `pnpm relink:anything`/,
      );
      expect(fire("pnpm voices", { tool, cwd: linkedTree, env }).permissionDecisionReason).toMatch(
        /`pnpm voices` → .*`pnpm dev:voices` there relinks/,
      );
      expect(fire("pnpm voices", { tool, cwd: otherTree, env })).toBeNull();
      for (const cwd of [linkedTree, otherTree])
        expect(fire("pnpm watch", { tool, cwd, env }).permissionDecisionReason).toMatch(
          /`pnpm watch` → `rollup --watch\.onEnd` → `streamdeck restart/,
        );
      expect(fire("pnpm wipe", { tool, cwd: linkedTree, env })).toBeNull();
      expect(fire("pnpm quiet", { tool, cwd: linkedTree, env })).toBeNull();
    }
  });

  // #1526 review: the false accepts the review found, fired through the hook
  // with real package.json files. `sd` carries the Stream Deck plugin's `watch`.
  it("reads every package an unresolved selector may pick, a wrapper's string and node behind a runner", () => {
    const sd = path.join(otherTree, "packages", "sd");
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      path.join(sd, "package.json"),
      JSON.stringify({
        name: "@fixture/sd",
        scripts: { build: "rollup -c", watch: 'rollup -c -w --watch.onEnd="streamdeck restart com.iracedeck.sd.core"' },
      }),
    );
    const asked = (c, tool = "Bash") => fire(c, { tool, cwd: otherTree, env })?.permissionDecision;
    for (const tool of ["Bash", "PowerShell"]) {
      for (const c of [
        "pnpm -r watch",
        "pnpm --filter sd watch",
        "pnpm --filter ./packages/sd watch",
        "npm run watch -w packages/sd",
        `bash -c "pnpm restart:stream-deck"`,
        `cmd /c "pnpm restart:stream-deck"`,
        `pwsh -c "pnpm restart:stream-deck"`,
        "npx node scripts/host-app.mjs stop mirabox",
        "node scripts/integration-build.mjs $(echo --restart) fix/1-a",
      ])
        expect(asked(c, tool), `${tool}: ${c}`).toBe("ask");
      // Positive control: the same shapes over what restarts nothing.
      for (const c of ["pnpm -r build", "pnpm --filter sd build", `bash -c "pnpm build"`, "npx node scripts/build.mjs"])
        expect(asked(c, tool), `${tool}: ${c}`).toBeUndefined();
    }
  });

  it("does not judge a heredoc-shaped string, which only bash would read as one", () => {
    const heredoc = "Write-Output 'x' <<EOF C:\\\\Users";
    expect(fire(heredoc, { tool: "PowerShell" })).toBeNull();
    expect(fire(heredoc).permissionDecision).toBe("deny");
  });
});
