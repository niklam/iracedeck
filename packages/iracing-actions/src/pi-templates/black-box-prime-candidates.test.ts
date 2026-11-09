import { partialsDir, piTemplatePlugin } from "@iracedeck/pi-components/build";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BLACK_BOX_CONTROL_KEYS, BLACK_BOX_GLOBAL_KEYS } from "../shared/black-box.js";
import { ACTIONS_DIR, readActionsData } from "./action-templates.test-support.js";

/**
 * The "Show black box" caveat (`ird-black-box-caveat`) says whether a press can
 * show its box, which takes a binding for the target and for one OTHER box to
 * prime with (#818). Its `candidates` must be exactly the boxes the runtime
 * prime resolver scans — `BLACK_BOX_GLOBAL_KEYS` — or the PI says "ready" while
 * `showBlackBox()` skips. The Black Box key-binding group also holds rows that
 * are not boxes (Cycle Next / Previous, Toggle Black Box Size #1238, and more
 * to come), so a template that filtered that group by row id would let each new
 * one in as a candidate.
 *
 * The templates are compiled through `piTemplatePlugin`, the way each plugin's
 * rollup build does, so the assertion reads the attribute a host would load.
 */

type AnyFunction = (...args: any[]) => any;

/** The pages known to carry the caveat today; the scan below finds any other. */
const CAVEAT_PAGES = ["fuel-service", "setup-chassis"];

const CAVEAT_TAG = /<ird-black-box-caveat\b[^>]*>/g;

/** The `candidates='…'` attribute, as `<%= %>` escaped it. */
function candidatesOf(tag: string): string[] {
  const match = /\bcandidates='([^']*)'/.exec(tag);

  expect(match, `no candidates attribute on ${tag}`).not.toBeNull();

  const json = match![1]
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

  return JSON.parse(json) as string[];
}

describe("black-box prime candidates in the Property Inspectors (#1238)", () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "iracedeck-prime-candidates-"));
  let pages: Map<string, string>;

  beforeAll(async () => {
    const plugin = piTemplatePlugin({
      templatesDir: ACTIONS_DIR,
      outputDir,
      partialsDir,
      version: "0.0.0-test",
    });
    const context = {
      addWatchFile: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: (message: string) => {
        throw new Error(message);
      },
    };

    await (plugin.generateBundle as AnyFunction).call(context);

    pages = new Map(
      readdirSync(outputDir)
        .filter((file) => file.endsWith(".html"))
        .map((file) => [path.basename(file, ".html"), readFileSync(path.join(outputDir, file), "utf-8")]),
    );
  }, 60_000);

  afterAll(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  const expected = Object.values(BLACK_BOX_GLOBAL_KEYS);

  it("finds the caveat on every page known to carry it", () => {
    const withCaveat = [...pages].filter(([, html]) => html.includes("<ird-black-box-caveat")).map(([name]) => name);

    expect(withCaveat.sort()).toEqual(expect.arrayContaining(CAVEAT_PAGES));
  });

  it("offers every box the runtime may prime with, and nothing else, on every caveat", () => {
    let checked = 0;

    for (const [name, html] of pages) {
      for (const [tag] of html.matchAll(CAVEAT_TAG)) {
        checked++;

        expect([...candidatesOf(tag)].sort(), name).toEqual([...expected].sort());
      }
    }

    expect(checked).toBeGreaterThanOrEqual(CAVEAT_PAGES.length);
  });

  it("keeps the runtime's scan order, Lap Timing first", () => {
    for (const page of CAVEAT_PAGES) {
      const [tag] = pages.get(page)!.match(CAVEAT_TAG)!;

      expect(candidatesOf(tag), page).toEqual(expected);
    }
  });

  it("leaves out every non-box row of the Black Box key-binding group", () => {
    const rows = readActionsData<{ blackBox: Array<{ setting: string }> }>("key-bindings.json").blackBox;
    const nonBox = rows.map((row) => row.setting).filter((setting) => !expected.includes(setting));

    // Vacuity guard: the group does hold non-box rows, Toggle Black Box Size
    // (#1238) among them. Every one is checked below, whichever rows are added.
    expect(nonBox).toEqual(expect.arrayContaining(Object.values(BLACK_BOX_CONTROL_KEYS)));

    for (const page of CAVEAT_PAGES) {
      const [tag] = pages.get(page)!.match(CAVEAT_TAG)!;

      for (const setting of nonBox) {
        expect(candidatesOf(tag), `${page} offers ${setting}`).not.toContain(setting);
      }
    }
  });
});
