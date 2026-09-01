import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { DEFAULT_CHANGELOG_NOTIFICATION_POLICY, CHANGELOG_NOTIFICATION_POLICIES } from "@iracedeck/deck-core";
import { describe, expect, it } from "vitest";

/**
 * The What's New frequency picker's rendered `default` has to agree with the
 * schema default, and nothing but this test connects the two: one lives in
 * `version-check.ts`, the other is a hand-written attribute in an `.ejs` file
 * that neither prettier nor eslint covers. A disagreement is silent — the
 * select simply pre-selects a value the plugin does not actually use.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const partial = readFileSync(path.join(partialsDir, "global-common-updates.ejs"), "utf-8");

describe("global-common-updates.ejs", () => {
  it("pre-selects the policy the schema actually defaults to", () => {
    expect(partial).toContain(`default="${DEFAULT_CHANGELOG_NOTIFICATION_POLICY}"`);
  });

  it("offers every policy the schema accepts, and no others", () => {
    const offered = [...partial.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);

    expect(offered.sort()).toEqual([...CHANGELOG_NOTIFICATION_POLICIES].sort());
  });
});
