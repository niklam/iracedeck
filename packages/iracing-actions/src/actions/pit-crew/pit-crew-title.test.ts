/**
 * Pit Crew's title defaults (#1479): the three toggle keys hide their title by
 * default and the two Radar Volume keys show theirs, both with `showTitle`
 * locked so the global Show title setting no longer applies; a per-key Title
 * Override still wins.
 *
 * Runs over the REAL deck-core title resolution and graphic-area sizing and the
 * REAL icon templates. The canonical action-test mock of deck-core in
 * `pit-crew.test.ts` stubs `resolveTitleSettings` (always shown) and
 * `computeGraphicArea`, and mocks the template, so none of this can be seen
 * there. Only the global settings store and the audio layer are mocked.
 */
import { dataUriToSvg } from "@iracedeck/icon-composer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pitCrewRadarVolumeTemplate from "../../../icons/pit-crew-radar-volume.svg";
import pitCrewTemplate from "../../../icons/pit-crew.svg";
import { generatePitCrewSvg, Settings, templateFor } from "./pit-crew.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalSettings: mockGetGlobalSettings,
  getGlobalColors: () => ({}),
  isCalloutEnabled: () => true,
  onGlobalSettingsChange: vi.fn(() => () => {}),
}));

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  driverNameClipPath: vi.fn(() => "voice/x/names/x.mp3"),
  isBackgroundTestInFlight: vi.fn(() => false),
  playBackgroundTest: vi.fn(),
  playRadarTest: vi.fn(),
  setRadarEnabled: vi.fn(),
  stopRaceEngineerScenarios: vi.fn(),
}));

vi.mock("../../audio/audio-volume.js", () => ({
  applyRaceEngineerAudio: vi.fn(),
  applyRadarVolume: vi.fn(),
  isRaceEngineerEnabled: () => true,
  isRadarEnabled: () => true,
  readRadarVolume: () => 50,
  setRaceEngineerTestInFlight: vi.fn(),
  setRaceEngineerToggleInFlight: vi.fn(),
  stepRadarVolume: vi.fn(() => 50),
}));

vi.mock("../../audio/audio-toggles.js", () => ({
  isCornerNamesEnabled: () => true,
  playVoiceSequence: vi.fn(),
  readJsonStringArray: () => [],
  toggleCornerNamesFeature: vi.fn(),
}));

vi.mock("../../audio/feature-gates.js", () => ({
  toggleRaceEngineerFeature: vi.fn(),
  toggleRadarFeature: vi.fn(),
}));

/** Every line of each mode's default title, as the rendered `<text>` content. */
const TOGGLES = [
  { settings: { mode: "race-engineer" }, lines: ["RACE", "ENGINEER"] },
  { settings: { mode: "radar" }, lines: ["RADAR"] },
  { settings: { mode: "corner-names" }, lines: ["CORNER", "NAMES"] },
] as const;

const VOLUMES = [
  { settings: { mode: "radar-volume", direction: "up" }, lines: ["VOL +", "50%"] },
  { settings: { mode: "radar-volume", direction: "down" }, lines: ["VOL −", "50%"] },
] as const;

/** The global Show title setting: on, off, and never written. */
const GLOBAL_SHOW_TITLE = [
  ["on", { titleShowTitle: true }],
  ["off", { titleShowTitle: false }],
  ["unset", {}],
] as const;

function render(settings: Record<string, unknown>): string {
  return dataUriToSvg(generatePitCrewSvg(Settings.parse(settings)));
}

/** Every `<text>` element's content in the rendered key, the status bar's `ON` / `OFF` included. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
}

/** The scale the artwork is drawn at: larger means a larger artwork area. */
function artworkScale(svg: string): number {
  const match = svg.match(/<g transform="translate\([^)]*\) scale\(([\d.]+)\)">/);

  if (!match) throw new Error("no scaled artwork in the rendered key");

  return Number(match[1]);
}

const desc = (svg: string) => JSON.parse(svg.match(/<desc>([\s\S]*?)<\/desc>/)![1]!);

describe("Pit Crew title defaults (#1479)", () => {
  beforeEach(() => {
    mockGetGlobalSettings.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("toggle keys hide the title by default", () => {
    for (const { settings, lines } of TOGGLES) {
      describe(settings.mode, () => {
        it.each(GLOBAL_SHOW_TITLE)("hides the title with the global Show title %s", (_label, global) => {
          mockGetGlobalSettings.mockReturnValue({ ...global });

          const drawn = texts(render(settings));

          for (const line of lines) expect(drawn).not.toContain(line);

          // The status bar still reads the state.
          expect(drawn).toContain("ON");
        });

        it("shows the title with a per-key Show Title override, even with the global setting off", () => {
          mockGetGlobalSettings.mockReturnValue({ titleShowTitle: false });

          const drawn = texts(render({ ...settings, titleOverrides: { showTitle: true } }));

          for (const line of lines) expect(drawn).toContain(line);
        });

        it("draws larger artwork with no title than with one above the status bar", () => {
          // A top title takes room from the artwork above the status bar. At the
          // default bottom position the title sits on the status bar's band,
          // which already caps the artwork, so the area barely changes there.
          mockGetGlobalSettings.mockReturnValue({ titleShowTitle: true, titlePosition: "top" });

          const hidden = artworkScale(render(settings));
          const shown = artworkScale(render({ ...settings, titleOverrides: { showTitle: true } }));

          expect(hidden).toBeGreaterThan(shown);
        });
      });
    }
  });

  describe("Radar Volume keys show the title by default", () => {
    for (const { settings, lines } of VOLUMES) {
      describe(`${settings.mode} ${settings.direction}`, () => {
        it.each(GLOBAL_SHOW_TITLE)("shows the volume readout with the global Show title %s", (_label, global) => {
          mockGetGlobalSettings.mockReturnValue({ ...global });

          const drawn = texts(render(settings));

          for (const line of lines) expect(drawn).toContain(line);
        });

        it("hides the readout with a per-key Show Title override off, even with the global setting on", () => {
          mockGetGlobalSettings.mockReturnValue({ titleShowTitle: true });

          const drawn = texts(render({ ...settings, titleOverrides: { showTitle: false } }));

          for (const line of lines) expect(drawn).not.toContain(line);
        });
      });
    }
  });

  describe("templateFor", () => {
    it.each(["race-engineer", "radar", "corner-names"] as const)("gives %s the Pit Crew template", (mode) => {
      expect(templateFor(mode)).toBe(pitCrewTemplate);
    });

    it("gives radar-volume its own template", () => {
      expect(templateFor("radar-volume")).toBe(pitCrewRadarVolumeTemplate);
    });
  });

  describe("templates", () => {
    it("hides the toggle title by default and locks showTitle", () => {
      expect(desc(pitCrewTemplate).title.showTitle).toBe(false);
      expect(desc(pitCrewTemplate).title.locked).toEqual(["showTitle"]);
    });

    it("shows the Radar Volume title by default and locks showTitle", () => {
      expect(desc(pitCrewRadarVolumeTemplate).title.showTitle).toBe(true);
      expect(desc(pitCrewRadarVolumeTemplate).title.locked).toEqual(["showTitle"]);
    });

    it("gives both templates the same colours and border", () => {
      expect(desc(pitCrewRadarVolumeTemplate).colors).toEqual(desc(pitCrewTemplate).colors);
      expect(desc(pitCrewRadarVolumeTemplate).border).toEqual(desc(pitCrewTemplate).border);
    });

    it("keeps the rest of the two templates identical", () => {
      const strip = (svg: string) => svg.replace(/<desc>[\s\S]*?<\/desc>/, "");

      expect(strip(pitCrewRadarVolumeTemplate)).toBe(strip(pitCrewTemplate));
    });
  });
});
