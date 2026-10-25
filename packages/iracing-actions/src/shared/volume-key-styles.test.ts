import { dataUriToSvg } from "@iracedeck/deck-core";
import { describe, expect, it, vi } from "vitest";

import {
  renderVolumeKeyIconOrNull,
  resolveVolumeKeyStyle,
  type VolumeKeyDescription,
  volumeKeyRepeats,
  volumeLevelText,
} from "./volume-key-styles.js";

vi.mock("@iracedeck/deck-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/deck-core")>();

  return {
    ...actual,
    getGlobalTitleSettings: () => ({}),
    getGlobalBorderSettings: () => ({}),
  };
});

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalColors: () => ({}),
}));

const COLOR_SOURCE = `<svg><desc>{"colors":{"backgroundColor":"#123456","textColor":"#ffffff"}}</desc></svg>`;

const MASTER_UP: VolumeKeyDescription = { label: "MASTER", direction: "increase" };

function engineerDown(level: number, enabled = true): VolumeKeyDescription {
  return { label: "ENGINEER", direction: "decrease", readLevel: () => ({ level, enabled }) };
}

function render(description: VolumeKeyDescription, keyStyle: Parameters<typeof resolveVolumeKeyStyle>[0], extra = {}) {
  const uri = renderVolumeKeyIconOrNull({
    description,
    keyStyle,
    pairPosition: "auto",
    colorSourceSvg: COLOR_SOURCE,
    ...extra,
  });

  return uri === null ? null : dataUriToSvg(uri);
}

describe("resolveVolumeKeyStyle", () => {
  it("draws each value style in its no-value form on a key without a level", () => {
    expect(resolveVolumeKeyStyle("split", false)).toBe("big-glyph");
    expect(resolveVolumeKeyStyle("edge-chevrons", false)).toBe("big-chevron");
    expect(resolveVolumeKeyStyle("joined-pill", false)).toBe("pill-end");
  });

  it("keeps a value style on a key with a level", () => {
    expect(resolveVolumeKeyStyle("split", true)).toBe("split");
    expect(resolveVolumeKeyStyle("edge-chevrons", true)).toBe("edge-chevrons");
    expect(resolveVolumeKeyStyle("joined-pill", true)).toBe("joined-pill");
  });

  it("passes the no-value styles through on both kinds of key", () => {
    for (const style of ["big-glyph", "big-chevron", "pill-end"] as const) {
      expect(resolveVolumeKeyStyle(style, false)).toBe(style);
      expect(resolveVolumeKeyStyle(style, true)).toBe(style);
    }
  });

  it("returns null for Legacy, the View-key styles and a missing value", () => {
    expect(resolveVolumeKeyStyle("legacy", true)).toBeNull();
    expect(resolveVolumeKeyStyle("pill-middle-horizontal", true)).toBeNull();
    expect(resolveVolumeKeyStyle("pill-middle-vertical", false)).toBeNull();
    expect(resolveVolumeKeyStyle(undefined, true)).toBeNull();
  });
});

describe("volumeKeyRepeats", () => {
  it("repeats in every pair style and never in Legacy", () => {
    expect(volumeKeyRepeats("split")).toBe(true);
    expect(volumeKeyRepeats("pill-end")).toBe(true);
    expect(volumeKeyRepeats("legacy")).toBe(false);
    expect(volumeKeyRepeats(undefined)).toBe(false);
  });
});

describe("volumeLevelText", () => {
  it("is the integer level without a unit, or OFF while the feature is off", () => {
    expect(volumeLevelText({ level: 55, enabled: true })).toBe("55");
    expect(volumeLevelText({ level: 0, enabled: true })).toBe("0");
    expect(volumeLevelText({ level: 100, enabled: true })).toBe("100");
    expect(volumeLevelText({ level: 55, enabled: false })).toBe("OFF");
  });
});

describe("renderVolumeKeyIconOrNull", () => {
  it("returns null for Legacy, so the action falls back to its own icon", () => {
    expect(render(MASTER_UP, "legacy")).toBeNull();
    expect(render(engineerDown(55), "legacy")).toBeNull();
  });

  it("draws Split on an iRacing volume key as Big +/− with its label", () => {
    const svg = render(MASTER_UP, "split")!;
    expect(svg).toBe(render(MASTER_UP, "big-glyph"));
    expect(svg).toContain(">+</text>");
    expect(svg).toContain(">MASTER<");
  });

  it("shows the label by default on every no-value style of a key without a level", () => {
    for (const style of ["edge-chevrons", "joined-pill", "big-chevron", "pill-end"] as const) {
      expect(render(MASTER_UP, style)).toContain(">MASTER<");
    }
  });

  it("lets a title override hide or change the label", () => {
    expect(render(MASTER_UP, "split", { titleOverrides: { showTitle: false } })).not.toContain("MASTER");
    expect(render(MASTER_UP, "split", { titleOverrides: { titleText: "MAIN" } })).toContain(">MAIN<");
  });

  it("shows the level on a level-showing key", () => {
    expect(render(engineerDown(55), "split")).toContain(">55</text>");
    expect(render(engineerDown(0), "edge-chevrons")).toContain(">0</text>");
    expect(render(engineerDown(100), "joined-pill")).toContain(">100</text>");
  });

  it("shows OFF while the feature is switched off", () => {
    const svg = render(engineerDown(55, false), "split")!;
    expect(svg).toContain(">OFF</text>");
    expect(svg).not.toContain(">55</text>");
  });

  it("draws the decrease glyph on a decrease key", () => {
    expect(render(engineerDown(55), "split")).toContain(">−</text>");
  });

  it("carries the #612 missing-binding overlay", () => {
    const plain = render(MASTER_UP, "split")!;
    const missing = render(MASTER_UP, "split", { bindingMissing: true })!;
    expect(missing).not.toBe(plain);
  });
});
