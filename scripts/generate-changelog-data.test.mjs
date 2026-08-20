import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildChangelogData,
  CHANGELOG_DATA_PATH,
  CHANGELOG_GENERATE_COMMAND,
  CHANGELOG_SOURCE_PATH,
  serializeChangelogData,
} from "./lib/changelog-data.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

describe("changelog.json", () => {
  it("matches the changelog it is generated from", () => {
    const source = readFileSync(path.join(repoRoot, CHANGELOG_SOURCE_PATH), "utf-8");
    const committed = readFileSync(path.join(repoRoot, CHANGELOG_DATA_PATH), "utf-8");
    const expected = serializeChangelogData(buildChangelogData(source));

    expect(
      committed,
      `${CHANGELOG_DATA_PATH} is out of date with ${CHANGELOG_SOURCE_PATH}. Run \`${CHANGELOG_GENERATE_COMMAND}\` and commit the result.`,
    ).toBe(expected);
  });

  it("ships every release the changelog documents", () => {
    const committed = JSON.parse(readFileSync(path.join(repoRoot, CHANGELOG_DATA_PATH), "utf-8"));
    const source = readFileSync(path.join(repoRoot, CHANGELOG_SOURCE_PATH), "utf-8");

    expect(committed.releases).toHaveLength((source.match(/^## /gm) ?? []).length);
  });
});
