import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { actionTemplates, SETTINGS_WINDOW_PAGE } from "./action-templates.test-support.js";

/**
 * #1003 split `@iracedeck/pi-components`' head-common.ejs in two: the handlers
 * for the plugin-global settings controls moved to settings-window-scripts.ejs,
 * which only the settings window includes. Which partial owns which hook is
 * held beside them in `pi-components`' `head-common-split.test.ts`; which page
 * includes the window-only scripts is held here, beside the pages (#1375).
 */
const read = (file: string): string => readFileSync(file, "utf-8");

describe("head-common / settings-window-scripts split (#1003)", () => {
  it("settings-window-scripts.ejs is included by the settings window", () => {
    expect(read(SETTINGS_WINDOW_PAGE)).toContain("include('settings-window-scripts')");
  });

  it("no action Property Inspector includes the window-only scripts", () => {
    const offenders = actionTemplates()
      .filter(({ name }) => name !== "settings-window.ejs")
      .filter(({ file }) => read(file).includes("settings-window-scripts"))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
