import { CAMERA_CATALOG_KEY } from "@iracedeck/app-constants";
import { describe, expect, it } from "vitest";

import { renderPartial } from "./testing.js";

/**
 * Renders the REAL `partials/camera-groups.ejs` (#1653), the settings window's
 * Camera Groups card. Like the voice-packs card it is settings-window ONLY: its
 * Remove sends a command the settings-window command handler routes, and from a
 * Property Inspector the same frame would go to that PI's action. That the page
 * passes the flag to this include is held beside the page, in iracing-actions'
 * `settings-window/settings-window-camera-groups.test.ts`.
 */
describe("camera-groups partial (#1653)", () => {
  it("renders the catalog list bound to the published catalog in the settings window", () => {
    const html = renderPartial("camera-groups", { settingsWindow: true });

    expect(html).toContain(`<ird-camera-catalog-list catalog="${CAMERA_CATALOG_KEY}"></ird-camera-catalog-list>`);
  });

  it("says what removing a name does and does not do", () => {
    const html = renderPartial("camera-groups", { settingsWindow: true });

    expect(html).toContain("comes back the next time");
    expect(html).toContain("never changes a key");
  });

  it("renders nothing without the settings-window flag", () => {
    expect(renderPartial("camera-groups").trim()).toBe("");
  });
});
