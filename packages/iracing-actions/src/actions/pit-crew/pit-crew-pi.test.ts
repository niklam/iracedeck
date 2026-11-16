// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Pit Crew PI shows Direction only for Mode = Radar Volume and, since
 * #1699, the Corner Names tap / long-press dropdowns and their note only for
 * Mode = Corner Names. The template's script is run in jsdom over its own
 * markup, so these cover the behaviour and the bindings, not only the text.
 */
// Read by path: under jsdom the global URL is the DOM's, which node:fs does not take.
const template = readFileSync(join(import.meta.dirname, "pit-crew.ejs"), "utf-8");

/** The settings markup: from the Mode item to the end of the corner-names note, EJS comments stripped. */
const markup = (
  template.match(/<sdpi-item label="Mode">[\s\S]*?id="corner-names-note">[\s\S]*?<\/div>/)?.[0] ?? ""
).replace(/<%#[\s\S]*?%>/g, "");

/** The template's one inline script. */
const script = template.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

/** The one shape of a jsdom element these tests touch. */
interface DomElement {
  value?: string;
  classList: { contains(token: string): boolean };
  dispatchEvent(event: unknown): boolean;
}

/** The jsdom globals these tests use, typed here: the package compiles without the DOM lib. */
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

const CORNER_NAMES_IDS = ["corner-names-tap-item", "corner-names-long-item", "corner-names-note"];

/** The options of the sdpi-select bound to a setting, as value and label. */
function optionsOf(setting: string): [string, string][] {
  const body =
    markup.match(new RegExp(`<sdpi-select[^>]*setting="${setting}"[^>]*>([\\s\\S]*?)</sdpi-select>`))?.[1] ?? "";

  return [...body.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
}

describe("pit-crew PI Corner Names dropdowns (#1699)", () => {
  it("binds Tap toggles to cornerNamesTap, defaulting to Corners", () => {
    expect(markup).toMatch(/<sdpi-item id="corner-names-tap-item"[^>]*label="Tap toggles">/);
    expect(markup).toContain('<sdpi-select setting="cornerNamesTap" default="corners">');
    expect(optionsOf("cornerNamesTap")).toEqual([
      ["both", "Both"],
      ["corners", "Corners"],
      ["sectors", "Sectors"],
    ]);
  });

  it("binds Long press toggles to cornerNamesLongPress, defaulting to Sectors", () => {
    expect(markup).toMatch(/<sdpi-item id="corner-names-long-item"[^>]*label="Long press toggles">/);
    expect(markup).toContain('<sdpi-select setting="cornerNamesLongPress" default="sectors">');
    expect(optionsOf("cornerNamesLongPress")).toEqual([
      ["none", "Nothing"],
      ["both", "Both"],
      ["corners", "Corners"],
      ["sectors", "Sectors"],
    ]);
  });
});

describe("pit-crew PI per-mode visibility (#1699)", () => {
  let polls: (() => void)[] = [];

  beforeAll(() => {
    // The script waits for sdpi-select before it wires anything.
    if (!dom.customElements.get("sdpi-select")) {
      dom.customElements.define("sdpi-select", class extends dom.HTMLElement {});
    }
  });

  beforeEach(() => {
    dom.document.body.innerHTML = "";
  });

  function pick(mode: string, event?: "change" | "input"): void {
    const element = dom.document.getElementById("mode-select");

    if (!element) throw new Error("#mode-select not rendered");

    element.value = mode;

    if (event) element.dispatchEvent(new dom.Event(event));
  }

  /** Renders the settings markup and runs the script over it, as the PI opens. */
  async function mount(mode?: string): Promise<void> {
    dom.document.body.innerHTML = markup;
    polls = [];
    Object.assign(dom.window, { irdPoll: (callback: () => void) => polls.push(callback) });

    if (mode) pick(mode);

    new Function(script)();

    // The script awaits whenDefined before wiring, so the poll being registered means it is done.
    await vi.waitFor(() => expect(polls).toHaveLength(1));
  }

  function shown(id: string): boolean {
    const element = dom.document.getElementById(id);

    if (!element) throw new Error(`#${id} not rendered`);

    return !element.classList.contains("hidden");
  }

  it.each(["race-engineer", "radar", "radar-volume"])("hides the Corner Names elements for %s", async (mode) => {
    await mount(mode);

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(false);
  });

  it("hides them when nothing is picked yet", async () => {
    await mount();

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(false);
  });

  it("shows all three for corner-names, and not Direction", async () => {
    await mount("corner-names");

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(true);

    expect(shown("direction-item")).toBe(false);
  });

  it.each(["change", "input"] as const)("follows a %s event on the Mode dropdown", async (event) => {
    await mount("race-engineer");
    pick("corner-names", event);

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(true);

    pick("radar", event);

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(false);
  });

  it("follows the poll when no event fires", async () => {
    await mount("race-engineer");
    pick("corner-names");

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(false);

    polls[0]();

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(true);

    pick("radar");
    polls[0]();

    for (const id of CORNER_NAMES_IDS) expect(shown(id), id).toBe(false);
  });

  it("keeps Direction for Radar Volume only", async () => {
    await mount("race-engineer");

    expect(shown("direction-item")).toBe(false);

    pick("radar-volume", "change");
    expect(shown("direction-item")).toBe(true);

    pick("corner-names", "change");
    expect(shown("direction-item")).toBe(false);

    pick("radar", "input");
    expect(shown("direction-item")).toBe(false);
  });
});
