// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REPLAY_DIAL_GESTURES,
  REPLAY_DIAL_MODES,
  ReplayControlDialSettings,
  SPEED_STOP_TOKENS,
} from "./replay-control-dial-settings.js";
import { resolveDialGesture } from "./replay-control-dial-surface.js";

/**
 * The PI runs in a browser context and cannot import action code, so the dial
 * view of `replay-control.ejs` repeats the dial schema by hand (#1316): the
 * rotation modes, the 31 speed tokens with their order and their defaults, and
 * the gesture slots with theirs. A stale copy fails quietly — a box that
 * stores a token the schema ignores, a speed nobody can tick, a dropdown that
 * shows one default while the dial runs another — so these hold it.
 */
// Read by path: under jsdom the global URL is the DOM's, which node:fs does not take.
const template = readFileSync(join(import.meta.dirname, "replay-control.ejs"), "utf-8");

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

  it("puts None first and the Mode default second on Long Press, which defaults to it (#801, #1448)", () => {
    const longPress = select("dial.longPressAction");

    expect(longPress.fallback).toBe("mode-default");
    expect(longPress.values.slice(0, 2)).toEqual(["none", "mode-default"]);
  });

  it.each(SLOTS)("%s names the Mode default and Jump to My Car as the PI calls them", (slot) => {
    const escaped = `dial.${slot}`.replace(".", "\\.");
    const body = dialView.match(new RegExp(`setting="${escaped}"[^>]*>([\\s\\S]*?)</sdpi-select>`))?.[1] ?? "";

    expect(body).toContain('<option value="mode-default">Mode default</option>');
    expect(body).toContain('<option value="jump-to-my-car">Jump to My Car</option>');
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
      ["car-number", "Cars by Number"],
      ["race-position", "Cars by Position"],
    ]);
  });

  it("draws the binding status line from the dial's own comms entry, keyed by dial.mode", () => {
    expect(template).toContain("var __dialComms = require('./data/action-comms.json')['replay-control-dial'];");
    expect(dialView).toContain(
      `<ird-binding-status mode-setting="<%= __dialComms._meta.modeSetting %>" comms='<%= JSON.stringify(__dialComms) %>'></ird-binding-status>`,
    );
  });
});

/**
 * The line under each gesture dropdown that says what its "Mode default" runs
 * in the dial's current Mode (#801). The template's script is run in jsdom
 * over the dial view's own markup, so these cover its behaviour, not only its
 * text: what it shows on load, on a change or input event, and on the poll.
 */
describe("replay-control PI Mode default lines (#801)", () => {
  const HINTS = {
    pressAction: "dial-press-action-mode-default",
    longPressAction: "dial-long-press-action-mode-default",
    tapAction: "dial-tap-action-mode-default",
    longTouchAction: "dial-long-touch-action-mode-default",
  } as const;
  const SLOTS = Object.keys(HINTS) as (keyof typeof HINTS)[];

  /** The template's one inline script. */
  const script = template.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

  interface PiScript {
    modeDefaultLabel(dialMode: string): string;
  }

  /** The one shape of a jsdom element these tests touch. */
  interface DomElement {
    value?: string;
    textContent: string | null;
    classList: { contains(token: string): boolean };
    dispatchEvent(event: unknown): boolean;
  }

  /**
   * The jsdom globals these tests use, typed here: the package compiles
   * without the DOM lib, which would otherwise reach every file in it.
   */
  const dom = globalThis as unknown as {
    window: object;
    document: {
      body: { innerHTML: string };
      getElementById(id: string): DomElement | null;
      querySelector(selector: string): DomElement | null;
    };
    customElements: { get(name: string): unknown; define(name: string, constructor: unknown): void };
    HTMLElement: new () => object;
    Event: new (type: string) => unknown;
  };

  let polls: (() => void)[] = [];
  const applyDialView = vi.fn();

  beforeAll(() => {
    // The script waits for sdpi-select before it wires anything.
    if (!dom.customElements.get("sdpi-select")) {
      dom.customElements.define("sdpi-select", class extends dom.HTMLElement {});
    }
  });

  beforeEach(() => {
    dom.document.body.innerHTML = "";
  });

  /** Renders the dial view and runs the script over it, as a dial's PI opens. */
  async function mount(): Promise<PiScript> {
    dom.document.body.innerHTML = `${dialView}</div>`;
    polls = [];
    applyDialView.mockClear();
    Object.assign(dom.window, {
      irdPoll: (callback: () => void) => polls.push(callback),
      irdKeepOneChecked: vi.fn(),
      irdResolveController: vi.fn(async () => "Encoder"),
      irdApplyDialView: applyDialView,
    });

    const api = new Function(`${script}\nreturn { modeDefaultLabel };`)() as PiScript;

    // initialize() wires the lines before it resolves the controller, so the
    // dial view being applied means the wiring is done.
    await vi.waitFor(() => expect(applyDialView).toHaveBeenCalled());

    return api;
  }

  /** Sets an sdpi-select's value as the component holds it ("" until something is picked). */
  function pick(setting: string, value: string, event?: "change" | "input"): void {
    const element = dom.document.querySelector(`sdpi-select[setting="${setting}"]`);

    if (!element) throw new Error(`no sdpi-select bound to ${setting}`);

    element.value = value;

    if (event) element.dispatchEvent(new dom.Event(event));
  }

  function hint(slot: keyof typeof HINTS): { text: string; shown: boolean } {
    const element = dom.document.getElementById(HINTS[slot]);

    if (!element) throw new Error(`#${HINTS[slot]} not rendered`);

    return { text: element.textContent ?? "", shown: !element.classList.contains("hidden") };
  }

  /** The label a gesture dropdown gives one of its options. */
  function optionLabel(slot: keyof typeof HINTS, value: string): string | undefined {
    const escaped = `dial.${slot}`.replace(".", "\\.");
    const body = dialView.match(new RegExp(`setting="${escaped}"[^>]*>([\\s\\S]*?)</sdpi-select>`))?.[1] ?? "";

    return body.match(new RegExp(`<option value="${value}">([^<]+)</option>`))?.[1];
  }

  it.each(SLOTS)("sits right under the %s dropdown, in the supporting-text style, hidden by default", (slot) => {
    const start = dialView.indexOf(`setting="dial.${slot}"`);
    const end = dialView.indexOf("</sdpi-item>", start);
    const next = dialView.slice(end).search(/<sdpi-item |<%[-=]? *(include|\})/);
    const between = dialView.slice(end, end + next);

    expect(start).toBeGreaterThan(-1);
    expect(between).toContain(
      `<div id="${HINTS[slot]}" class="ird-supporting-text hidden" data-mode-default-for="dial.${slot}">`,
    );
  });

  it("is one line per gesture slot and no more", () => {
    expect(dialView.split("data-mode-default-for=").length - 1).toBe(SLOTS.length);
  });

  it.each(REPLAY_DIAL_MODES)(
    "names in %s the gesture resolveDialGesture runs, as the dropdowns call it",
    async (mode) => {
      const api = await mount();
      const resolved = resolveDialGesture("mode-default", mode);

      expect(resolved).not.toBeNull();

      for (const slot of SLOTS) {
        expect(optionLabel(slot, resolved as string), slot).toBeDefined();
        expect(api.modeDefaultLabel(mode), slot).toBe(optionLabel(slot, resolved as string));
      }
    },
  );

  it("shows only the untouched Long Press, the one slot whose default is the Mode default", async () => {
    await mount();

    expect(hint("longPressAction")).toEqual({ text: "Mode default: Set 1x and Play", shown: true });
    expect(hint("pressAction").shown).toBe(false);
    expect(hint("tapAction").shown).toBe(false);
    expect(hint("longTouchAction").shown).toBe(false);
  });

  it("says Jump to My Car once the dial's Mode is Track Order, and Set 1x and Play again after", async () => {
    await mount();

    pick("dial.mode", "track-order", "change");

    for (const slot of SLOTS) expect(hint(slot).text, slot).toBe("Mode default: Jump to My Car");

    // Car # and Position move the camera from car to car too (#1448).
    for (const mode of ["car-number", "race-position"]) {
      pick("dial.mode", "lap", "input");
      pick("dial.mode", mode, "change");

      for (const slot of SLOTS) expect(hint(slot).text, `${mode} ${slot}`).toBe("Mode default: Jump to My Car");
    }

    pick("dial.mode", "lap", "input");

    for (const slot of SLOTS) expect(hint(slot).text, slot).toBe("Mode default: Set 1x and Play");
  });

  it("shows a line when its dropdown picks the Mode default and hides it on a specific action", async () => {
    await mount();

    pick("dial.pressAction", "mode-default", "change");
    pick("dial.tapAction", "mode-default", "input");
    pick("dial.longPressAction", "play-pause", "change");

    expect(hint("pressAction").shown).toBe(true);
    expect(hint("tapAction").shown).toBe(true);
    expect(hint("longPressAction").shown).toBe(false);
    expect(hint("longTouchAction").shown).toBe(false);
  });

  it("catches up on the poll when a value changes without an event, as settings arriving late do", async () => {
    await mount();

    pick("dial.mode", "track-order");
    pick("dial.longTouchAction", "mode-default");

    expect(hint("longTouchAction").shown).toBe(false);
    expect(hint("longPressAction").text).toBe("Mode default: Set 1x and Play");

    for (const poll of polls) poll();

    expect(hint("longTouchAction")).toEqual({ text: "Mode default: Jump to My Car", shown: true });
    expect(hint("longPressAction").text).toBe("Mode default: Jump to My Car");
  });
});
