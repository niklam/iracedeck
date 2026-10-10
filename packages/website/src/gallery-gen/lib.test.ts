import { describe, expect, it } from "vitest";

import {
  DYNAMIC_SAMPLE_DATA,
  extractColorSlots,
  extractRawViewBox,
  extractValuePlaceholders,
  findLeftoverPlaceholders,
  parseIconImports,
  parseTitlesMaps,
  renderDynamicTemplate,
  resolveTemplateSample,
  sampleTitle,
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

  it("extracts maps with typed keys and Partial<Record<...>>", () => {
    const src = `
const SPOTTER_TITLES: Record<SpotterControl, string> = {
  "toggle-spotter": "SPOTTER",
};
export const CHAT_TITLES: Partial<Record<ChatMode, string>> = {
  "respond-pm": "REPLY\\nPM",
};
`;
    expect(parseTitlesMaps(src)).toEqual({
      "toggle-spotter": "SPOTTER",
      "respond-pm": "REPLY\nPM",
    });
  });

  it("ignores nested Record maps whose values are not strings", () => {
    const src = `
const NESTED_TITLES: Record<string, Record<string, string>> = {
  outer: { inner: "NOPE" },
};
`;
    expect(parseTitlesMaps(src)).toEqual({});
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

describe("extractValuePlaceholders", () => {
  it("returns the non-color placeholders once each, in source order", () => {
    const svg = `<svg><text y="{{valueY}}" fill="{{graphic1Color}}" font-size="{{valueFontSize}}">{{value}}</text><text y="{{valueY}}"/></svg>`;
    expect(extractValuePlaceholders(svg)).toEqual(["valueY", "valueFontSize", "value"]);
  });

  it("returns nothing for an icon with color slots only", () => {
    const svg = `<svg><rect fill="{{backgroundColor}}" stroke="{{graphic2Color}}"/><text fill="{{textColor}}"/></svg>`;
    expect(extractValuePlaceholders(svg)).toEqual([]);
  });

  it("reports a name no template key could have, so a typo is not skipped", () => {
    expect(extractValuePlaceholders(`<svg><text y="{{value-y}}">{{ value }}</text></svg>`)).toEqual([
      "value-y",
      " value ",
    ]);
  });
});

describe("resolveTemplateSample", () => {
  const valueSvg = `<svg><text y="{{valueY}}" fill="{{graphic1Color}}">{{value}}</text></svg>`;

  it("returns the icon's sample when it covers every value placeholder", () => {
    const sample = { value: "42", valueY: "33" };
    expect(
      resolveTemplateSample("camera-focus/switch-by-car-number", valueSvg, {
        "camera-focus/switch-by-car-number": sample,
      }),
    ).toBe(sample);
  });

  it("returns undefined for an icon with color slots only, whatever the table holds", () => {
    const svg = `<svg><rect fill="{{backgroundColor}}"/></svg>`;
    expect(resolveTemplateSample("fuel-service/add-fuel", svg, {})).toBeUndefined();
    expect(
      resolveTemplateSample("fuel-service/add-fuel", svg, { "fuel-service/add-fuel": { value: "1" } }),
    ).toBeUndefined();
  });

  it("throws naming the icon and every token when the icon has no sample", () => {
    expect(() => resolveTemplateSample("replay-control/speed-display", valueSvg, {})).toThrow(
      /Template icon replay-control\/speed-display has no gallery sample value for \{\{valueY\}\}, \{\{value\}\}\./,
    );
  });

  it("throws naming only the uncovered tokens when the sample is partial", () => {
    expect(() => resolveTemplateSample("a/b", valueSvg, { "a/b": { value: "42" } })).toThrow(
      /Template icon a\/b has no gallery sample value for \{\{valueY\}\}\./,
    );
  });

  it("treats an undefined entry as a missing sample", () => {
    expect(() => resolveTemplateSample("a/b", valueSvg, { "a/b": undefined })).toThrow(/Template icon a\/b/);
  });

  it("does not take another icon's sample", () => {
    expect(() => resolveTemplateSample("a/b", valueSvg, { "a/c": { value: "42", valueY: "33" } })).toThrow(
      /Template icon a\/b/,
    );
  });

  it("throws naming the sample values no placeholder of the icon uses", () => {
    expect(() =>
      resolveTemplateSample("a/b", valueSvg, { "a/b": { value: "42", valueY: "33", baselineY: "33" } }),
    ).toThrow(/Template icon a\/b's gallery sample has values no placeholder of the icon uses: baselineY\./);
    // A colour slot is not a value placeholder: the colours win over it anyway.
    expect(() =>
      resolveTemplateSample("a/b", valueSvg, { "a/b": { value: "42", valueY: "33", graphic1Color: "#f00" } }),
    ).toThrow(/no placeholder of the icon uses: graphic1Color\./);
  });

  it("accepts an empty string as a value", () => {
    const sample = { value: "", valueY: "33" };
    expect(resolveTemplateSample("a/b", valueSvg, { "a/b": sample })).toBe(sample);
  });
});

describe("findLeftoverPlaceholders", () => {
  it("finds nothing in a finished asset", () => {
    expect(findLeftoverPlaceholders(`<svg><style>a{fill:red}</style><text y="33">42</text></svg>`)).toEqual([]);
  });

  it("lists each leftover token once", () => {
    const asset = `<svg><text y="{{valueY}}">{{speedText}}</text><g transform="rotate({{needleAngle}}, 38, 38)"/><text y="{{valueY}}"/></svg>`;
    expect(findLeftoverPlaceholders(asset)).toEqual(["{{valueY}}", "{{speedText}}", "{{needleAngle}}"]);
  });

  it("reports a bare {{ for a placeholder that never closes or has an odd name", () => {
    expect(findLeftoverPlaceholders(`<svg><text>{{ value }}</text><text>{{unclosed</text></svg>`)).toEqual(["{{"]);
  });

  it("finds a color slot nobody resolved too", () => {
    expect(findLeftoverPlaceholders(`<svg><rect fill="{{graphic2Color}}"/></svg>`)).toEqual(["{{graphic2Color}}"]);
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

describe("sampleTitle", () => {
  it("places a single line at the specified bottomY", () => {
    const svg = sampleTitle("SINGLE", 100);
    expect(svg).toContain('y="100"');
    expect(svg).toContain(">SINGLE<");
  });

  it("uses default bottomY of 118 when not specified", () => {
    const svg = sampleTitle("DEFAULT");
    expect(svg).toContain('y="118"');
  });

  it("positions multi-line text with each line 20px above the previous", () => {
    const svg = sampleTitle("A\nB", 92);
    // First line should be at 92 - (2-1)*20 = 72
    // Second line should be at 92 - (2-2)*20 = 92
    expect(svg).toContain('y="72"');
    expect(svg).toContain('y="92"');
    expect(svg).toContain(">A<");
    expect(svg).toContain(">B<");
  });

  it("renders multi-line text with default bottomY of 118", () => {
    const svg = sampleTitle("X\nY");
    // First line at 118 - 20 = 98
    // Second line at 118
    expect(svg).toContain('y="98"');
    expect(svg).toContain('y="118"');
  });
});

describe("DYNAMIC_SAMPLE_DATA", () => {
  it("has an entry for every known dynamic template EXCEPT pit-crew", () => {
    // pit-crew.svg is special-cased directly in the generator (PIT_CREW_SAMPLES):
    // it renders one gallery sample per toggle mode off the same physical file
    // (race-engineer, radar, and corner-names, item 2 of the gallery
    // restructure wave), which this simple one-sample-per-file map can't
    // express — so it's intentionally absent here.
    expect(Object.keys(DYNAMIC_SAMPLE_DATA).sort()).toEqual([
      "adjust-style",
      "car-control-drs",
      "car-control-pit-limiter",
      "car-control-push-to-pass",
      "fuel-service",
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
