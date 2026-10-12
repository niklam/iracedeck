import { DEFAULT_REPLAY_JUMP_PLAYBACK, REPLAY_JUMP_PLAYBACK_MODES } from "@iracedeck/app-constants";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The three replay jump playback modes (#1276) are declared once in
 * `@iracedeck/app-constants` (`replay-jump-playback.ts`), which the settings
 * schema and the jump sequence both import. The Replay card's `<sdpi-select>`
 * writes them out by hand, because it is markup in an `.ejs` file that cannot
 * import. It drifts silently: an option value the schema does not accept is
 * stored, read back as `remember`, and shown as whatever the select happens
 * to render — a setting that appears to save and does not. Nothing else
 * connects the markup to the constants, so it is pinned here.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const partial = readFileSync(path.join(partialsDir, "global-common-replay.ejs"), "utf-8");
const select = /<sdpi-select[^>]*setting="replayJumpPlayback"[\s\S]*?<\/sdpi-select>/.exec(partial)?.[0] ?? "";

describe("global-common-replay.ejs (#1276)", () => {
  it("binds a global select to the replay jump playback setting", () => {
    // Guards every assertion below: a renamed setting would otherwise leave
    // them all reading an empty string and passing vacuously.
    expect(select).not.toBe("");
    expect(select).toMatch(/<sdpi-select[^>]*\sglobal[\s>]/);
  });

  it("offers exactly the modes the schema accepts, in their declared order", () => {
    const offered = [...select.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);

    expect(offered).toEqual([...REPLAY_JUMP_PLAYBACK_MODES]);
  });

  it("pre-selects the mode the schema defaults to", () => {
    expect(select).toContain(`default="${DEFAULT_REPLAY_JUMP_PLAYBACK}"`);
  });

  it("labels the three modes as the issue names them", () => {
    expect(select).toContain('<option value="remember">Remember state</option>');
    expect(select).toContain('<option value="play">Play</option>');
    expect(select).toContain('<option value="stopped">Stopped</option>');
  });

  it("sits above Fastest Lap Search Delay", () => {
    expect(partial.indexOf('setting="replayJumpPlayback"')).toBeLessThan(
      partial.indexOf('setting="fastestLapSearchDelayMs"'),
    );
  });
});
