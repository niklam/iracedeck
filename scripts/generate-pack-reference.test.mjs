// Freshness of the pack-author reference (issue #1066): the committed
// pack-reference.json is what the sources build today. Rebuilt through the
// same module as the generator, off the BUILT `@iracedeck/audio-scenarios`
// dist — CI runs `pnpm build` before `pnpm test`; locally, a missing dist
// fails with a message naming the command.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUNDLED_SCRIPT_PATH,
  buildPackReferenceData,
  PACK_REFERENCE_GENERATE_COMMAND,
  PACK_REFERENCE_PATH,
  serializePackReferenceData,
} from "./lib/pack-reference-data.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** Every bundled callout is a `pit-crew.*` id; the script keys are the whole set the reference must publish. */
const CALLOUT_ID_PREFIX = "pit-crew.";

describe("pack-reference.json", () => {
  it("matches what the catalog, the bundled script and the bundled voice build", async () => {
    expect(
      existsSync(path.join(repoRoot, "packages/audio-scenarios/dist/index.js")),
      "packages/audio-scenarios/dist is missing — this test reads the BUILT package. Run `pnpm build` first.",
    ).toBe(true);

    const committed = readFileSync(path.join(repoRoot, PACK_REFERENCE_PATH), "utf-8");
    const expected = await serializePackReferenceData(await buildPackReferenceData());

    expect(
      committed,
      `${PACK_REFERENCE_PATH} is out of date with the catalog, ${BUNDLED_SCRIPT_PATH} or the bundled voice. Run \`${PACK_REFERENCE_GENERATE_COMMAND}\` and commit the result.`,
    ).toBe(expected);
  });

  it("publishes exactly the callouts the bundled script scripts", () => {
    const committed = JSON.parse(readFileSync(path.join(repoRoot, PACK_REFERENCE_PATH), "utf-8"));
    const script = JSON.parse(readFileSync(path.join(repoRoot, BUNDLED_SCRIPT_PATH), "utf-8"));
    const scripted = Object.keys(script.scenarios).filter((id) => id.startsWith(CALLOUT_ID_PREFIX));

    expect(scripted.length).toBeGreaterThan(0);
    expect(committed.callouts).toHaveLength(scripted.length);
    expect(committed.callouts.map((c) => c.id).sort()).toEqual(scripted.sort());
  });

  it("gives every callout the one sentence on when it fires", () => {
    const committed = JSON.parse(readFileSync(path.join(repoRoot, PACK_REFERENCE_PATH), "utf-8"));
    const undescribed = committed.callouts.filter((c) => c.description.trim() === "").map((c) => c.id);

    expect(undescribed, "callouts with an empty description").toEqual([]);
  });
});
