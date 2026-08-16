import { SETTINGS_WINDOW_HTML as RUNTIME_HTML } from "@iracedeck/deck-core";
import { describe, expect, it } from "vitest";

import { SETTINGS_WINDOW_HTML as BUILD_HTML } from "./index.mjs";

/**
 * The plugin serves `ui/<SETTINGS_WINDOW_HTML>` at runtime (deck-core) and the
 * build injects the bridge into that same file (pi-components/build). They are
 * declared in two packages because build-time modules must not be imported
 * into the runtime bundle — so this test is the single thing keeping them equal.
 */
describe("settings-window file name (#992)", () => {
  it("is the same string at build time and at runtime", () => {
    expect(BUILD_HTML).toBe(RUNTIME_HTML);
  });
});
