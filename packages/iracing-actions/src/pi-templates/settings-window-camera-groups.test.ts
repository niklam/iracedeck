import { CAMERA_CATALOG_KEY } from "@iracedeck/app-constants";
import { renderPartial } from "@iracedeck/pi-components/testing";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SETTINGS_WINDOW_PAGE } from "./action-templates.test-support.js";

/**
 * Where the settings window shows the camera catalog (#1653): a Camera Groups
 * card on the General tab, full width below the behaviour cards, since a
 * broadcaster's catalog runs to hundreds of names. The partial renders only
 * when the flag reaches ITS include, which the page evaluates in its own scope,
 * so the flag must be passed there (`camera-groups-partial.test.ts` in
 * pi-components holds the partial itself).
 */
const source = readFileSync(SETTINGS_WINDOW_PAGE, "utf-8");

const CARD =
  "<%- include('accordion', { title: 'Camera Groups', content: include('camera-groups', { settingsWindow: true }), settingsWindow: true }) %>";

describe("the Camera Groups card (#1653)", () => {
  const generalStart = source.indexOf('id="pane-general"');
  const general = source.slice(generalStart, source.indexOf("</section>", generalStart));

  it("is on the General tab, passing settingsWindow into THIS include", () => {
    expect(general).toContain(CARD);
  });

  it("appears exactly once on the page", () => {
    expect(source.split("include('camera-groups'").length - 1).toBe(1);
  });

  it("sits in a full-width grid of its own, after the behaviour cards", () => {
    const pressSounds = general.indexOf("include('global-common-press-sounds')");
    const card = general.indexOf(CARD);

    expect(card).toBeGreaterThan(pressSounds);
    expect(general.slice(pressSounds, card)).toMatch(/<\/div>\s*(<%#[\s\S]*?%>\s*)?<div class="sw-grid single">\s*$/);
  });

  it("renders the catalog list when included as the page includes it", () => {
    expect(renderPartial("camera-groups", { settingsWindow: true })).toContain(
      `<ird-camera-catalog-list catalog="${CAMERA_CATALOG_KEY}">`,
    );
  });
});
