import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildGettingStartedData,
  GETTING_STARTED_DATA_PATH,
  GETTING_STARTED_GENERATE_COMMAND,
  GETTING_STARTED_SOURCE_PATH,
  serializeGettingStartedData,
} from "./lib/getting-started-data.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

describe("getting-started.json", () => {
  it("matches the page it is generated from", () => {
    const source = readFileSync(path.join(repoRoot, GETTING_STARTED_SOURCE_PATH), "utf-8");
    const committed = readFileSync(path.join(repoRoot, GETTING_STARTED_DATA_PATH), "utf-8");
    const expected = serializeGettingStartedData(buildGettingStartedData(source));

    expect(
      committed,
      `${GETTING_STARTED_DATA_PATH} is out of date with ${GETTING_STARTED_SOURCE_PATH}. Run \`${GETTING_STARTED_GENERATE_COMMAND}\` and commit the result.`,
    ).toBe(expected);
  });

  it("ships every section the page documents", () => {
    const committed = JSON.parse(readFileSync(path.join(repoRoot, GETTING_STARTED_DATA_PATH), "utf-8"));
    const source = readFileSync(path.join(repoRoot, GETTING_STARTED_SOURCE_PATH), "utf-8");

    expect(committed.sections).toHaveLength((source.match(/^## /gm) ?? []).length);
  });
});
