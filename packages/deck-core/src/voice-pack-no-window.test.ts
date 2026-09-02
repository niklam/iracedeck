import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard: no voice-pack module may open a window (issue #1034).
 *
 * The install path runs WHILE IRACING IS RUNNING — deferring it would leave a
 * driver who updates and immediately races with a mute engineer for exactly the
 * session they would notice it in. The corollary is that nothing in this
 * feature may put anything on screen, on any outcome INCLUDING failure: not a
 * browser tab through the host's `openUrl`, not the settings window through its
 * launcher, not an Explorer window, not a spawned process of any kind. Progress
 * and failure are passive only — the `_warnings` banner and the settings
 * window's own Race Engineer card, both surfaces the user chose to look at.
 *
 * Written as a source-text assertion, the technique the single-SimHub-fetch
 * guard already uses (`simhub-probe.test.ts`), because the thing being forbidden
 * is a REACHABLE call rather than an observable behaviour: a window opened only
 * on a rare failure branch would never be caught by a behavioural test that did
 * not already anticipate it.
 *
 * It is deliberately a glob rather than a fixed file list. Today the feature has
 * no installer, so this passes vacuously — which is exactly why it must exist
 * before stage 2 adds the catalog client and the downloader that CAN fail. A new
 * `voice-pack-*.ts` is covered the moment it is created, with nobody having to
 * remember to enrol it.
 *
 * A file named here legitimately needing one of these would mean the feature has
 * grown a UI surface, which is a design change to argue for in the spec — not a
 * line to add to the allow-list below.
 */

const SRC_DIR = join(process.cwd(), "packages/deck-core/src");

/** Names that put something on the user's screen, and the module each lives in. */
const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bopenUrl\b/, what: "the deck host's openUrl (opens a browser tab)" },
  { pattern: /settings-window/, what: "the settings window (its controller and launcher both open one)" },
  { pattern: /chromium-browser/, what: "the Chromium app-window launcher" },
  { pattern: /openFolderInExplorer|open-folder/, what: "openFolderInExplorer (opens an Explorer window)" },
  { pattern: /node:child_process|\bspawn\s*\(/, what: "a spawned child process" },
];

/**
 * Every module of this feature, found by name.
 *
 * Widened from `voice-pack*` to `voice*` in stage 2. The narrower prefix was a
 * hole rather than a smaller net: a catalog client named `voice-catalog-client.ts`
 * — which is what the spec calls that document, so it is the obvious name to
 * reach for — would have sat outside the glob and been checked by nothing,
 * while every assertion here went on passing. The guard would have reported
 * success about a file it had never read.
 *
 * The rule the widening buys, and the one a new module owes: **a module of this
 * feature must be named `voice-*`.** That is the whole enrolment mechanism. A
 * file named outside it is invisible here, and no assertion below can notice.
 */
function voicePackModules(): string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.startsWith("voice"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

describe("voice-pack modules open no window (#1034)", () => {
  const modules = voicePackModules();

  // Positive control for the glob itself: a renamed prefix or a bad directory
  // would make every assertion below pass while checking nothing at all.
  it("finds the voice-pack modules it is supposed to be guarding", () => {
    expect(modules.length).toBeGreaterThan(0);
    expect(modules).toContain("voice-pack-service.ts");
    expect(modules).toContain("voice-pack-scanner.ts");
    expect(modules).toContain("voice-packs-path.ts");
    // Named because they are the stage-2 modules that can FAIL — the ones with
    // a remote server, a disk full, and a hostile archive on the other side,
    // and therefore the ones a failure branch would most plausibly want to put
    // a window on. If a rename drops one out of the glob, this says so.
    expect(modules).toContain("voice-pack-catalog.ts");
    expect(modules).toContain("voice-pack-provenance.ts");
    expect(modules).toContain("voice-pack-status.ts");
  });

  it.each(voicePackModules())("%s reaches nothing that opens a window", (name) => {
    const source = readFileSync(join(SRC_DIR, name), "utf-8");

    for (const { pattern, what } of FORBIDDEN) {
      expect(pattern.test(source), `${name} references ${what}`).toBe(false);
    }
  });
});
