import { describe, expect, it } from "vitest";

import {
  DYNAMIC_SAMPLE_DATA,
  extractColorSlots,
  extractRawViewBox,
  parseIconImports,
  parseTitlesMaps,
  renderDynamicTemplate,
} from "./lib.js";

describe("parseTitlesMaps", () => {
  it("extracts quoted keys and decodes \\n escapes", () => {
    const src = `
const AUDIO_CONTROLS_TITLES: Record<string, string> = {
  "push-to-talk": "TALK",
  "voice-chat-volume-up": "VOL UP\\nVOICE",
};
`;
    expect(parseTitlesMaps(src)).toEqual({
      "push-to-talk": "TALK",
      "voice-chat-volume-up": "VOL UP\nVOICE",
    });
  });

  it("extracts unquoted identifier keys and merges multiple maps", () => {
    const src = `
const A_TITLES: Record<string, string> = {
  direct: "DIRECT",
};
const B_TITLES: Record<string, string> = {
  "next-cam": "NEXT\\nCAM",
};
`;
    expect(parseTitlesMaps(src)).toEqual({ direct: "DIRECT", "next-cam": "NEXT\nCAM" });
  });

  it("returns an empty object when no titles map exists", () => {
    expect(parseTitlesMaps("const x = 1;")).toEqual({});
  });
});

describe("parseIconImports", () => {
  it("collects family/name paths from icon imports", () => {
    const src = `
import a from "@iracedeck/icons/audio-controls/push-to-talk.svg";
import b from "@iracedeck/icons/fuel-service/add-fuel.svg";
import { z } from "zod";
`;
    expect(parseIconImports(src)).toEqual(["audio-controls/push-to-talk", "fuel-service/add-fuel"]);
  });

  it("returns an empty array when no icon imports exist", () => {
    expect(parseIconImports(`import { z } from "zod";`)).toEqual([]);
  });
});

describe("extractColorSlots", () => {
  it("returns only the color slots present", () => {
    const svg = `<svg><rect fill="{{backgroundColor}}"/><path fill="{{graphic1Color}}"/><path fill="{{graphic1Color}}"/></svg>`;
    expect(extractColorSlots(svg)).toEqual(["backgroundColor", "graphic1Color"]);
  });

  it("ignores non-color placeholders", () => {
    expect(extractColorSlots(`<svg>{{iconContent}}</svg>`)).toEqual([]);
  });
});

describe("extractRawViewBox", () => {
  it("returns the literal attribute value", () => {
    expect(extractRawViewBox(`<svg viewBox="0 0 110 96"></svg>`)).toBe("0 0 110 96");
  });

  it("returns undefined when absent", () => {
    expect(extractRawViewBox(`<svg></svg>`)).toBeUndefined();
  });
});

describe("renderDynamicTemplate", () => {
  const svg = `<svg viewBox="0 0 144 144"><desc>{"colors":{"backgroundColor":"#101820","textColor":"#ffffff"}}</desc><rect fill="{{backgroundColor}}"/>{{borderDefs}}{{borderContent}}<text fill="{{textColor}}">{{value}}</text>{{iconContent}}</svg>`;

  it("fills desc colors, sample values, and blanks leftover tokens", () => {
    const out = renderDynamicTemplate(svg, { value: "P12" });
    expect(out).toContain(`fill="#101820"`);
    expect(out).toContain(`fill="#ffffff"`);
    expect(out).toContain(">P12<");
    expect(out).not.toContain("{{");
  });

  it("lets sample values win over desc colors", () => {
    const out = renderDynamicTemplate(svg, { backgroundColor: "#000000" });
    expect(out).toContain(`fill="#000000"`);
  });
});

describe("DYNAMIC_SAMPLE_DATA", () => {
  it("has an entry for every known dynamic template", () => {
    expect(Object.keys(DYNAMIC_SAMPLE_DATA).sort()).toEqual([
      "adjust-style",
      "car-control-drs",
      "car-control-pit-limiter",
      "car-control-push-to-pass",
      "fuel-service",
      "pit-crew",
      "pit-quick-actions",
      "pit-quick-actions-fast-repair",
      "pit-quick-actions-windshield",
      "race-admin-car-selector",
      "session-info",
      "setup-brakes-abs-toggle",
      "setup-traction-tc-toggle",
      "setup-view",
      "telemetry-display",
      "tire-service",
    ]);
  });
});
