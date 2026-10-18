import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REPLAY_DIAL_GESTURES,
  REPLAY_DIAL_MODES,
  ReplayControlDialSettings,
  SPEED_STOP_TOKENS,
} from "./replay-control-dial-settings.js";

/**
 * The PI runs in a browser context and cannot import action code, so the dial
 * view of `replay-control.ejs` repeats the dial schema by hand (#1316): the
 * rotation modes, the 31 speed tokens with their order and their defaults, and
 * the gesture slots with theirs. A stale copy fails quietly — a box that
 * stores a token the schema ignores, a speed nobody can tick, a dropdown that
 * shows one default while the dial runs another — so these hold it.
 */
const template = readFileSync(fileURLToPath(new URL("./replay-control.ejs", import.meta.url)), "utf-8");

/** The schema's own defaults, read by parsing a dial that has stored nothing. */
const defaults = ReplayControlDialSettings.parse(undefined);

/** The template source of the element with this id, up to the `</div>` at its own indent. */
function section(id: string): string {
  const open = template.match(new RegExp(`^([ \\t]*)<div id="${id}"[^>]*>`, "m"));

  if (!open || open.index === undefined) throw new Error(`#${id} not found in replay-control.ejs`);

  const close = template.indexOf(`\n${open[1]}</div>`, open.index);

  if (close === -1) throw new Error(`#${id} is not closed at its own indent`);

  return template.slice(open.index, close);
}

const dialView = section("dial-settings");

/** A dial `sdpi-select`: its default and the option values it offers, in order. */
function select(setting: string): { label: string; fallback: string; values: string[] } {
  const escaped = setting.replace(".", "\\.");
  const match = dialView.match(
    new RegExp(
      `<sdpi-item label="([^"]+)">\\s*<sdpi-select [^>]*setting="${escaped}" default="([^"]+)">([\\s\\S]*?)</sdpi-select>`,
    ),
  );

  if (!match) throw new Error(`no sdpi-select bound to ${setting} in the dial view`);

  return {
    label: match[1],
    fallback: match[2],
    values: [...match[3].matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]),
  };
}

describe("replay-control PI dial Mode", () => {
  const mode = select("dial.mode");

  it('is labelled exactly "Mode"', () => {
    expect(mode.label).toBe("Mode");
  });

  it("offers exactly the schema's rotation modes, in its order", () => {
    expect(mode.values).toEqual([...REPLAY_DIAL_MODES]);
  });

  it("defaults to the schema's mode", () => {
    expect(mode.fallback).toBe(defaults.mode);
  });
});

describe("replay-control PI Speeds grid", () => {
  const grid = section("dial-speed-stops-grid");
  const boxes = [...grid.matchAll(/<sdpi-checkbox ([^>]*)><\/sdpi-checkbox>/g)].map((m) => {
    const attribute = (name: string): string | undefined => m[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

    return { setting: attribute("setting"), label: attribute("label"), fallback: attribute("default") };
  });

  it("is the only place the dial view binds a speed", () => {
    expect(dialView.split('setting="dial.speedStops.').length - 1).toBe(boxes.length);
  });

  it("binds one box per speed token to its own key of the map, in the schema's order", () => {
    expect(boxes.map((box) => box.setting)).toEqual(SPEED_STOP_TOKENS.map((token) => `dial.speedStops.${token}`));
  });

  it("labels each box with the speed its token means", () => {
    // The keypad's own speed format: `s4` is 1/4x, `2` is 2x.
    const expected = SPEED_STOP_TOKENS.map((token) => (token.startsWith("s") ? `1/${token.slice(1)}x` : `${token}x`));

    expect(boxes.map((box) => box.label)).toEqual(expected);
  });

  it("ticks exactly the schema's default speeds", () => {
    const ticked = boxes.filter((box) => box.fallback !== undefined).map((box) => box.setting);

    expect(ticked).toEqual(
      SPEED_STOP_TOKENS.filter((token) => defaults.speedStops[token]).map((token) => `dial.speedStops.${token}`),
    );
    expect(ticked).toHaveLength(6);
  });

  it('never writes default="false", which sdpi-checkbox renders ticked', () => {
    for (const box of boxes) expect(box.fallback ?? "true", box.setting).toBe("true");
  });

  it("hands the grid it declares to the shared keep-one-ticked guard", () => {
    const lookup = template.match(/const (\w+) = document\.getElementById\("dial-speed-stops-grid"\);/);

    expect(lookup).not.toBeNull();
    expect(template).toContain(`window.irdKeepOneChecked(${lookup?.[1]})`);
  });

  it("sits in the section the script shows for Speed Control only", () => {
    expect(section("dial-speed-stops-section")).toContain('id="dial-speed-stops-grid"');
    expect(template).toMatch(
      /getElementById\("dial-speed-stops-section"\)\?\.classList\.toggle\("hidden", mode !== "speed"\)/,
    );
  });
});

describe("replay-control PI Frame Jog hint", () => {
  it("sits in a section the script shows for Frame Jog only", () => {
    expect(dialView).toContain('<div id="dial-frame-jog-section" class="hidden">');
    expect(template).toMatch(
      /getElementById\("dial-frame-jog-section"\)\?\.classList\.toggle\("hidden", mode !== "frame-jog"\)/,
    );
  });

  it("says a fast spin is the less exact one and what to do when it lands off", () => {
    const hint = section("dial-frame-jog-section").replace(/\s+/g, " ");

    expect(hint).toContain("Slow turns are exact.");
    expect(hint).toContain("If it lands off, stop, let it settle and step again.");
  });

  it("binds no setting: Frame Jog has none of its own", () => {
    expect(section("dial-frame-jog-section")).not.toContain("setting=");
  });
});

describe("replay-control PI dial gesture slots", () => {
  const SLOTS = ["pressAction", "longPressAction", "tapAction", "longTouchAction"] as const;

  it.each(SLOTS)("%s offers every gesture the schema accepts, each once", (slot) => {
    const { values } = select(`dial.${slot}`);

    expect([...values].sort()).toEqual([...REPLAY_DIAL_GESTURES].sort());
  });

  it.each(SLOTS)("%s defaults to the schema's gesture", (slot) => {
    expect(select(`dial.${slot}`).fallback).toBe(defaults[slot]);
  });

  it("offers on Press everything the gated slots offer, so a knob reaches all of it", () => {
    const press = new Set(select("dial.pressAction").values);

    for (const slot of SLOTS) for (const value of select(`dial.${slot}`).values) expect(press, value).toContain(value);
  });
});

describe("replay-control PI dial view", () => {
  it("shows the key-binding rows on a dial only in Car, the one dial mode that taps a binding (#801)", () => {
    // irdApplyDialView() hides #keypad-settings and #keypad-appearance only;
    // the key-bindings section sits outside both, so the dial view decides it.
    const dialBranch = template.match(/=== "Encoder"\) \{([\s\S]*?)\n\t\t\t\t\}/);

    expect(dialBranch?.[1]).toContain("window.irdApplyDialView()");
    expect(dialBranch?.[1]).toContain("isDialView = true;");
    expect(dialBranch?.[1]).toContain("updateDialVisibility(");
    expect(template).toMatch(
      /if \(isDialView\) \{\s*document\.getElementById\("key-bindings-section"\)\?\.classList\.toggle\("hidden", mode !== "track-order"\);/,
    );
    expect(dialView).not.toContain("key-bindings-section");
  });

  it("names the Mode options as the dial's modes are called", () => {
    const options = [...dialView.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);

    expect(options.slice(0, REPLAY_DIAL_MODES.length)).toEqual([
      ["speed", "Speed Control"],
      ["frame-jog", "Frame Jog"],
      ["lap", "Lap"],
      ["session", "Session"],
      ["incident", "Incident"],
      ["track-order", "Track Order"],
    ]);
  });

  it("draws the binding status line from the dial's own comms entry, keyed by dial.mode", () => {
    expect(template).toContain("var __dialComms = require('./data/action-comms.json')['replay-control-dial'];");
    expect(dialView).toContain(
      `<ird-binding-status mode-setting="<%= __dialComms._meta.modeSetting %>" comms='<%= JSON.stringify(__dialComms) %>'></ird-binding-status>`,
    );
  });
});
