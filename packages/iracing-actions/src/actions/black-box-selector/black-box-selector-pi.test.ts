// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ROTATIONS } from "./black-box-selector-dial-settings.js";
import {
  DialSettings,
  GESTURE_ACTIONS,
  resolveGestures,
  ROTATION_GESTURE_DEFAULTS,
} from "./black-box-selector-dial-surface.js";

/**
 * The PI runs in a browser context and cannot import action code, so the dial
 * view of `black-box-selector.ejs` repeats the dial schema by hand (#1585): the
 * rotations, the gestures each slot offers, and what a Press and a Long Press
 * nobody has chosen do in each Mode. A stale copy fails quietly — a dropdown
 * that shows one default while the dial runs another — so these hold it, and
 * they run the template's own script against a stub `sdpi-select`
 * (`class extends HTMLElement {}`), which proves only that the script never sets
 * `.value`. That a real `sdpi-select` treats `default` as render-only, so an unset
 * slot stays unset for the plugin to resolve, is pinned against the vendored
 * bundle in pi-components' `sdpi-select-default.test.ts`.
 */
// Read by path: under jsdom the global URL is the DOM's, which node:fs does not take.
const template = readFileSync(join(import.meta.dirname, "black-box-selector.ejs"), "utf-8");

/** The template source of the element with this id, up to the `</div>` at its own indent. */
function section(id: string): string {
  const open = template.match(new RegExp(`^([ \\t]*)<div id="${id}"[^>]*>`, "m"));

  if (!open || open.index === undefined) throw new Error(`#${id} not found in black-box-selector.ejs`);

  const close = template.indexOf(`\n${open[1]}</div>`, open.index);

  if (close === -1) throw new Error(`#${id} is not closed at its own indent`);

  return template.slice(open.index, close);
}

const dialView = section("dial-settings");

/** A dial `sdpi-select`: its label, its static default and the options it offers, in order. */
function select(setting: string): { label: string; fallback: string; values: string[]; labels: string[] } {
  const escaped = setting.replace(".", "\\.");
  const match = dialView.match(
    new RegExp(
      `<sdpi-item label="([^"]+)">\\s*<sdpi-select [^>]*setting="${escaped}" default="([^"]+)">([\\s\\S]*?)</sdpi-select>`,
    ),
  );

  if (!match) throw new Error(`no sdpi-select bound to ${setting} in the dial view`);

  const options = [...match[3].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)];

  return { label: match[1], fallback: match[2], values: options.map((m) => m[1]), labels: options.map((m) => m[2]) };
}

const SLOTS = ["pressAction", "longPressAction", "tapAction", "longTouchAction"] as const;

describe("black-box-selector PI dial Mode (#1585)", () => {
  const mode = select("dial.rotation");

  it('is labelled exactly "Mode"', () => {
    expect(mode.label).toBe("Mode");
  });

  it("offers exactly the schema's rotations, in its order, defaulting to the schema's", () => {
    expect(mode.values).toEqual([...ROTATIONS]);
    expect(mode.fallback).toBe(DialSettings.parse({}).rotation);
  });
});

describe("black-box-selector PI gesture slots (#1585)", () => {
  it.each(SLOTS)("%s offers exactly the schema's gestures, None first", (slot) => {
    const { values } = select(`dial.${slot}`);

    expect(values[0]).toBe("none");
    expect([...values].sort()).toEqual([...GESTURE_ACTIONS].sort());
  });

  it.each(SLOTS)("%s offers Switch Select / Adjust under that name", (slot) => {
    const { values, labels } = select(`dial.${slot}`);

    expect(labels[values.indexOf("switch-rotation")]).toBe("Switch Select / Adjust");
  });

  it.each(SLOTS)("%s starts on None, the default of a dial that cycles boxes", (slot) => {
    // The Mode a fresh or pre-#1585 dial has is boxes, whose defaults are all
    // None; the script retargets Press and Long Press when the Mode says otherwise.
    const boxes = resolveGestures(DialSettings.parse({}));
    const resolved = {
      pressAction: boxes.press,
      longPressAction: boxes.longPress,
      tapAction: boxes.tap,
      longTouchAction: boxes.longTouch,
    };

    expect(select(`dial.${slot}`).fallback).toBe(resolved[slot]);
  });

  it("explains Switch Select / Adjust and the two defaults", () => {
    expect(dialView).toMatch(
      /Switch Select \/ Adjust changes this dial's Mode between Select Control and\s+Adjust Control/,
    );
    expect(dialView).toMatch(/does nothing while the Mode is Cycle\s+Black Boxes/);
    expect(dialView).toMatch(/a Press Action you have not\s+chosen is Toggle Selected Control/);
    expect(dialView).toMatch(/Choose None to turn either off/);
  });
});

/**
 * The template's script, run in jsdom over the dial view's own markup: what it
 * shows for an unset slot on load, on a change or input event, and on the poll.
 */
describe("black-box-selector PI shows an unset slot's default without storing it (#1585)", () => {
  /** The template's one inline script. */
  const script = template.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

  interface PiScript {
    DIAL_GESTURE_DEFAULTS: Record<string, Record<string, string>>;
  }

  /** The one shape of a jsdom element these tests touch. */
  interface DomElement {
    value?: string;
    getAttribute(name: string): string | null;
    remove(): void;
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

  function control(setting: string): DomElement {
    const element = dom.document.querySelector(`sdpi-select[setting="${setting}"]`);

    if (!element) throw new Error(`no sdpi-select bound to ${setting}`);

    return element;
  }

  /** Renders the dial view and runs the script over it, as a dial's PI opens. */
  async function mount(options: { rotation?: string; knob?: boolean } = {}): Promise<PiScript> {
    dom.document.body.innerHTML = `${dialView}</div>`;

    // A stored Mode is on the control before the script reads it.
    if (options.rotation) control("dial.rotation").value = options.rotation;

    // A knob's PI renders no Long Press, Tap Display or Long Touch control.
    if (options.knob) for (const slot of SLOTS.slice(1)) control(`dial.${slot}`).remove();

    polls = [];
    applyDialView.mockClear();
    Object.assign(dom.window, {
      irdPoll: (callback: () => void) => polls.push(callback),
      irdResolveController: vi.fn(async () => "Encoder"),
      irdApplyDialView: applyDialView,
    });

    const api = new Function(`${script}\nreturn { DIAL_GESTURE_DEFAULTS };`)() as PiScript;

    // initialize() wires the defaults before it resolves the controller, so the
    // dial view being applied means the wiring is done.
    await vi.waitFor(() => expect(applyDialView).toHaveBeenCalled());

    return api;
  }

  /** Sets the Mode as the component holds it, optionally announcing it. */
  function pickRotation(value: string, event?: "change" | "input"): void {
    const element = control("dial.rotation");

    element.value = value;

    if (event) element.dispatchEvent(new dom.Event(event));
  }

  function shownDefaults(): Record<string, string | null> {
    return Object.fromEntries(
      SLOTS.map((slot) => [
        slot,
        dom.document.querySelector(`sdpi-select[setting="dial.${slot}"]`)?.getAttribute("default") ?? null,
      ]),
    );
  }

  function expected(rotation: (typeof ROTATIONS)[number]): Record<string, string> {
    return { ...ROTATION_GESTURE_DEFAULTS[rotation], tapAction: "none", longTouchAction: "none" };
  }

  it("carries the surface's defaults table, entry for entry", async () => {
    const api = await mount();

    expect(api.DIAL_GESTURE_DEFAULTS).toEqual(ROTATION_GESTURE_DEFAULTS);
  });

  it("shows None in every slot while the Mode is unset, as on every dial from before the choice", async () => {
    await mount();

    expect(shownDefaults()).toEqual(expected("boxes"));
  });

  it.each(ROTATIONS)("shows the %s defaults for a Mode stored before the PI opened", async (rotation) => {
    await mount({ rotation });

    expect(shownDefaults()).toEqual(expected(rotation));
  });

  it.each(["change", "input"] as const)("follows the Mode on a %s event", async (event) => {
    await mount();

    pickRotation("adjust-control", event);

    expect(shownDefaults()).toEqual(expected("adjust-control"));

    pickRotation("boxes", event);

    expect(shownDefaults()).toEqual(expected("boxes"));
  });

  it("follows a Mode that changed with no event, on the poll (the dial's own switch, or a silent sdpi-select)", async () => {
    await mount();

    pickRotation("select-control");

    expect(shownDefaults()).toEqual(expected("boxes"));

    for (const poll of polls) poll();

    expect(shownDefaults()).toEqual(expected("select-control"));
  });

  it("never gives a slot a value: the default is drawn, and the slot stays unset for the plugin to resolve", async () => {
    await mount({ rotation: "select-control" });
    pickRotation("adjust-control", "change");
    pickRotation("boxes", "change");

    for (const poll of polls) poll();

    for (const slot of SLOTS) expect(control(`dial.${slot}`).value, slot).toBeUndefined();
  });

  it("retargets the Press Action alone on a knob, whose PI has no other slot", async () => {
    await mount({ rotation: "adjust-control", knob: true });

    expect(shownDefaults()).toEqual({
      pressAction: "toggle-control",
      longPressAction: null,
      tapAction: null,
      longTouchAction: null,
    });
  });
});
