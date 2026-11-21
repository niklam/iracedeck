// @vitest-environment jsdom
import { CAMERA_CATALOG_KEY, type CameraCatalogView, STANDARD_CAMERA_GROUP_OPTIONS } from "@iracedeck/app-constants";
import { CAMERA_GROUP_NAME_MAX_LENGTH as RECORDED_NAME_MAX_LENGTH } from "@iracedeck/deck-iracing";
import {
  CAMERA_GROUP_HELPERS,
  CAMERA_GROUP_NAME_MAX_LENGTH,
  LEGACY_CAMERA_GROUP_NAMES,
} from "@iracedeck/pi-components/testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHANGE_CAMERA_GROUPS,
  DEFAULT_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  normalizeGroupName,
} from "../camera-controls/camera-groups.js";

/**
 * The PI runs in a browser context and cannot import action code, so it keeps
 * hand copies of the camera-group lists (#958). A stale copy fails as a missing
 * checkbox or a dead dropdown entry rather than as a red test — these hold it.
 *
 * Since #1653 the Change Camera picker is `ird-camera-group-select`, which takes
 * its standard groups from `STANDARD_CAMERA_GROUP_OPTIONS` in app-constants —
 * the copy held here to `CHANGE_CAMERA_GROUPS` — and the Cycle Camera grids
 * gain a Remembered groups section drawn from `window.irdCameraGroups`.
 */
// Read by path: under jsdom the global URL is the DOM's, which node:fs does not take.
const template = readFileSync(join(import.meta.dirname, "camera-focus.ejs"), "utf-8");

/** The quoted strings of a `var NAME = [ … ];` array literal, comments stripped. */
function readStringArray(name: string): string[] {
  const match = template.match(new RegExp(`var ${name} = \\[([\\s\\S]*?)\\];`));

  if (!match) throw new Error(`var ${name} not found in camera-focus.ejs`);

  const body = match[1].replace(/\/\/[^\n]*/g, "");

  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function readGroupSections(): { heading: string; start: number; end: number }[] {
  const match = template.match(/var GROUP_SECTIONS = \[([\s\S]*?)\];/);

  if (!match) throw new Error("var GROUP_SECTIONS not found in camera-focus.ejs");

  return [...match[1].matchAll(/heading: "([^"]+)", start: (\d+), end: (\d+)/g)].map((m) => ({
    heading: m[1],
    start: Number(m[2]),
    end: Number(m[3]),
  }));
}

describe("camera-focus PI camera-group lists", () => {
  const allGroups = readStringArray("ALL_GROUPS");

  it("lists exactly the action's camera groups, each once", () => {
    expect(allGroups).toHaveLength(DEFAULT_CAMERA_GROUPS.length);
    expect(new Set(allGroups)).toEqual(new Set(DEFAULT_CAMERA_GROUPS));
  });

  it("enables the same groups by default as the action", () => {
    expect(readStringArray("DEFAULT_ENABLED")).toEqual(DEFAULT_ENABLED_GROUPS);
  });

  it("covers every listed group with exactly one contiguous section", () => {
    const sections = readGroupSections();

    expect(sections.map((s) => s.heading)).toEqual(["Car", "Chase", "Track", "Aerial"]);
    expect(sections[0].start).toBe(0);

    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].start).toBe(sections[i - 1].end);
    }

    expect(sections[sections.length - 1].end).toBe(allGroups.length);
  });

  it("puts the five groups added in #958 in the Track section", () => {
    const track = readGroupSections().find((s) => s.heading === "Track");
    const trackGroups = allGroups.slice(track?.start, track?.end);

    for (const name of ["TV Static", "TV Mixed", "TV4", "Spotter", "Spectator"]) {
      expect(trackGroups).toContain(name);
    }
  });

  it("folds the same legacy group spellings as the action", () => {
    const match = template.match(/var LEGACY_NAMES = (\{[^}]*\});/);

    expect(match).not.toBeNull();

    const legacy = JSON.parse(match?.[1] ?? "{}") as Record<string, string>;

    expect(Object.keys(legacy).length).toBeGreaterThan(0);

    for (const [variant, canonical] of Object.entries(legacy)) {
      expect(normalizeGroupName(variant)).toBe(canonical);
    }
  });

  it("offers Icon Shows for Cycle Camera keys, defaulting to the next camera", () => {
    const section = template.match(/<div id="camera-groups-section"[\s\S]*?<\/div>/);

    expect(section?.[0]).toContain('<sdpi-select setting="cycleIconMode" default="next">');
    expect(section?.[0]).toContain('<option value="current">');
  });
});

describe("the picker's standard groups (STANDARD_CAMERA_GROUP_OPTIONS, #1653)", () => {
  // The picker's suspension labels spell the group out; every other label is the group name.
  const CHANGE_CAMERA_LABELS: Record<string, string> = {
    "Suspension - Left Front": "LF Susp",
    "Suspension - Right Front": "RF Susp",
    "Suspension - Left Rear": "LR Susp",
    "Suspension - Right Rear": "RR Susp",
  };

  it("offers every Change Camera value from 1 to the number of groups, each once", () => {
    const values = STANDARD_CAMERA_GROUP_OPTIONS.map((o) => o.value);

    expect([...values].sort((a, b) => a - b)).toEqual(
      Array.from({ length: DEFAULT_CAMERA_GROUPS.length }, (_, i) => i + 1),
    );
    expect(Object.keys(CHANGE_CAMERA_GROUPS)).toHaveLength(STANDARD_CAMERA_GROUP_OPTIONS.length);
  });

  it("names every value with the group the action switches to", () => {
    for (const { value, name } of STANDARD_CAMERA_GROUP_OPTIONS) {
      expect(name, `option ${value}`).toBe(CHANGE_CAMERA_GROUPS[value]);
    }
  });

  it("labels every value with its group", () => {
    for (const { value, label, name } of STANDARD_CAMERA_GROUP_OPTIONS) {
      expect(CHANGE_CAMERA_LABELS[label] ?? label, `option ${value}`).toBe(name);
    }
  });

  it("uses the grid's section headings, in its order, each holding the same groups", () => {
    const allGroups = readStringArray("ALL_GROUPS");
    const sections = readGroupSections();
    const pickerHeadings = [...new Set(STANDARD_CAMERA_GROUP_OPTIONS.map((o) => o.section))];

    expect(pickerHeadings).toEqual(sections.map((s) => s.heading));

    for (const section of sections) {
      const picker = STANDARD_CAMERA_GROUP_OPTIONS.filter((o) => o.section === section.heading).map((o) => o.name);

      expect(new Set(picker), section.heading).toEqual(new Set(allGroups.slice(section.start, section.end)));
    }
  });

  it("keeps each section contiguous, so the picker's optgroups follow the list's order", () => {
    const order = STANDARD_CAMERA_GROUP_OPTIONS.map((o) => o.section);

    for (let i = 1; i < order.length; i++) {
      if (order[i] !== order[i - 1]) expect(order.slice(0, i), order[i]).not.toContain(order[i]);
    }
  });

  it("folds the same legacy spellings as the action, in the components bundle too", () => {
    expect(LEGACY_CAMERA_GROUP_NAMES.size).toBeGreaterThan(0);

    for (const [variant, canonical] of LEGACY_CAMERA_GROUP_NAMES) {
      expect(normalizeGroupName(variant)).toBe(canonical);
    }
  });

  it("accepts names as long as the ones the plugin records, and no longer", () => {
    expect(CAMERA_GROUP_NAME_MAX_LENGTH).toBe(RECORDED_NAME_MAX_LENGTH);
  });
});

describe("the Change Camera picker in the template (#1653)", () => {
  const item = template.match(/<sdpi-item label="Camera Group" id="camera-group-item"[^>]*>([\s\S]*?)<\/sdpi-item>/);

  it("keeps the item's label and id, which the visibility toggle finds it by", () => {
    expect(item).not.toBeNull();
    expect(template).toContain('document.getElementById("camera-group-item")');
  });

  it("is the ird-camera-group-select, bound to the name, the number and the catalog", () => {
    const element = item?.[1].match(/<ird-camera-group-select ([^>]*)><\/ird-camera-group-select>/)?.[1] ?? "";

    expect(element).toContain('setting="cameraGroupName"');
    expect(element).toContain('number-setting="cameraGroup"');
    expect(element).toContain(`catalog="${CAMERA_CATALOG_KEY}"`);
  });

  it("falls back to the action's default group, Cockpit", () => {
    const fallback = item?.[1].match(/default="(\d+)"/)?.[1];

    expect(CHANGE_CAMERA_GROUPS[Number(fallback)]).toBe("Cockpit");
  });

  it("no longer binds cameraGroup through an sdpi-select", () => {
    expect(template).not.toMatch(/<sdpi-select[^>]*setting="cameraGroup"/);
  });
});

describe("camera-focus PI Car Number field (#1353)", () => {
  const field = template.match(/<sdpi-textfield[^>]*setting="carNumber"[^>]*>/)?.[0];

  it("hands the field it declares to the shared digits-only filter", () => {
    const id = field?.match(/id="([^"]+)"/)?.[1];

    expect(id).toBeDefined();

    const lookup = template.match(new RegExp(`var (\\w+) = document\\.getElementById\\("${id}"\\);`));

    expect(lookup).not.toBeNull();
    expect(template).toContain(`window.irdDigitsOnly(${lookup?.[1]})`);
  });

  it("limits the field to the four characters a raw number can have", () => {
    expect(field).toContain('maxlength="4"');
  });

  it("filters nothing inline: the inner input is the shared filter's to rewrite", () => {
    expect(template).not.toContain(".replace(/[^0-9]/g");
  });
});

/** The one shape of a jsdom element these tests touch. */
interface DomElement {
  id: string;
  className: string;
  textContent: string | null;
  title: string;
  checked: boolean;
  dataset: Record<string, string | undefined>;
  children: ArrayLike<DomElement>;
  querySelector(selector: string): DomElement | null;
  dispatchEvent(event: unknown): boolean;
  click(): void;
}

/** The jsdom globals these tests use, typed here: the package compiles without the DOM lib. */
const dom = globalThis as unknown as {
  window: Record<string, unknown>;
  document: { body: { innerHTML: string }; getElementById(id: string): DomElement | null };
  customElements: { get(name: string): unknown; define(name: string, constructor: unknown): void };
  HTMLElement: new () => object;
  Event: new (type: string) => unknown;
};

/** The template's one inline script. */
const script = template.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

/** What the grid script needs on the page: the two grids and their buttons, and the two Mode selects. */
const SKELETON = `
  <div id="camera-groups-grid"></div>
  <button id="btn-select-all"></button><button id="btn-clear"></button>
  <div id="dial-camera-groups-grid"></div>
  <button id="dial-btn-select-all"></button><button id="dial-btn-clear"></button>
`;

const STANDARD = STANDARD_CAMERA_GROUP_OPTIONS.map((o) => o.name);

const CATALOG: CameraCatalogView = {
  version: 1,
  tracks: [
    { id: 1, name: "Spa", config: "" },
    { id: 2, name: "Monza", config: "" },
  ],
  groups: [
    { name: "TV1", tracks: [0, 1], lastSeen: "" },
    { name: "Zulu", tracks: [0], lastSeen: "" },
    { name: "Alpha", tracks: [], lastSeen: "" },
    { name: "SpeedCam", tracks: [1], lastSeen: "" },
    { name: "DynamicTV", tracks: [1], lastSeen: "" },
  ],
  // The sim's order puts SpeedCam before DynamicTV.
  current: { trackId: 2, groups: ["TV1", "SpeedCam", "Nose", "DynamicTV"] },
};

describe("camera-focus PI Cycle Camera grids: the Remembered groups section (#1653)", () => {
  let perKey: Map<string, (value: unknown) => void>;
  let global: Map<string, ((value: unknown) => void)[]>;
  let keypadSave: ReturnType<typeof vi.fn>;
  let dialSave: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    // The script waits for sdpi-select before it wires anything.
    if (!dom.customElements.get("sdpi-select")) {
      dom.customElements.define("sdpi-select", class extends dom.HTMLElement {});
    }
  });

  beforeEach(async () => {
    dom.document.body.innerHTML = SKELETON;
    perKey = new Map();
    global = new Map();
    keypadSave = vi.fn();
    dialSave = vi.fn();

    Object.assign(dom.window, {
      SDPIComponents: {
        useSettings: (key: string, callback: (value: unknown) => void) => {
          perKey.set(key, callback);

          return [async () => "", keypadSave];
        },
        useGlobalSettings: (key: string, callback: (value: unknown) => void) => {
          global.set(key, [...(global.get(key) ?? []), callback]);

          return [async () => "", dialSave];
        },
      },
      irdCameraGroups: CAMERA_GROUP_HELPERS,
      irdPoll: () => {},
      irdDigitsOnly: () => {},
      irdResolveController: async () => "Keypad",
      irdApplyDialView: () => {},
    });

    new Function(script)();

    // initializePI awaits whenDefined("sdpi-select"); let it run to its end.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

  /** One global push, delivered the way sdpi delivers: to every subscription of the key. */
  function pushGlobal(key: string, value: unknown): void {
    for (const callback of global.get(key) ?? []) callback(value);
  }

  const pushCatalog = (view: unknown): void => pushGlobal(CAMERA_CATALOG_KEY, JSON.stringify(view));
  const pushKeypadSubset = (groups: Record<string, boolean>): void =>
    perKey.get("cameraGroupSubset")?.(JSON.stringify({ groups }));

  function grid(id: string): DomElement {
    const element = dom.document.getElementById(id);

    if (!element) throw new Error(`#${id} missing`);

    return element;
  }

  /** The grid's headings and entries, in order. */
  function read(id: string): { headings: string[]; entries: { name: string; checked: boolean; dimmed: boolean }[] } {
    const children = Array.from(grid(id).children);

    return {
      headings: children.filter((c) => c.className === "group-heading").map((c) => c.textContent ?? ""),
      entries: children
        .filter((c) => c.className !== "group-heading")
        .map((c) => {
          const box = c.querySelector("input") as DomElement;

          return { name: box.dataset.group ?? "", checked: box.checked, dimmed: c.className === "dimmed" };
        }),
    };
  }

  function remembered(id: string): { name: string; checked: boolean; dimmed: boolean }[] {
    return read(id).entries.filter((e) => !STANDARD.includes(e.name));
  }

  function toggle(id: string, name: string): void {
    const box = Array.from(grid(id).children)
      .map((c) => c.querySelector("input"))
      .find((b) => b?.dataset.group === name);

    if (!box) throw new Error(`${name} not in #${id}`);

    box.click();
  }

  function lastSaved(save: ReturnType<typeof vi.fn>): Record<string, boolean> {
    return (JSON.parse(save.mock.calls.at(-1)?.[0] as string) as { groups: Record<string, boolean> }).groups;
  }

  it("draws no Remembered section while the catalog holds no custom group", () => {
    pushKeypadSubset({});

    expect(read("camera-groups-grid").headings).toEqual(["Car", "Chase", "Track", "Aerial"]);
  });

  it("adds it after Aerial: this track's custom groups in the sim's order, then the rest alphabetically and dimmed", () => {
    pushKeypadSubset({});
    pushCatalog(CATALOG);

    expect(read("camera-groups-grid").headings).toEqual(["Car", "Chase", "Track", "Aerial", "Remembered groups"]);
    expect(remembered("camera-groups-grid")).toEqual([
      { name: "SpeedCam", checked: false, dimmed: false },
      { name: "DynamicTV", checked: false, dimmed: false },
      { name: "Alpha", checked: false, dimmed: true },
      { name: "Zulu", checked: false, dimmed: true },
    ]);
  });

  it("shows a custom name the stored subset ticks, even when the catalog no longer has it", () => {
    pushKeypadSubset({ Nose: true, Removed: true });
    pushCatalog(CATALOG);

    expect(remembered("camera-groups-grid")).toContainEqual({ name: "Removed", checked: true, dimmed: true });
  });

  it("draws the same section on the dial's grid, from the global subset", () => {
    pushGlobal("cameraGroupSubset", JSON.stringify({ groups: { Zulu: true } }));
    pushCatalog(CATALOG);

    expect(remembered("dial-camera-groups-grid").map((e) => [e.name, e.checked])).toEqual([
      ["SpeedCam", false],
      ["DynamicTV", false],
      ["Alpha", false],
      ["Zulu", true],
    ]);
  });

  it("stores a custom group only once it is ticked, beside the standard fill-in", () => {
    pushKeypadSubset({});
    pushCatalog(CATALOG);
    toggle("camera-groups-grid", "Gearbox");

    // The fill-in writes the standard 25 and nothing else.
    expect(Object.keys(lastSaved(keypadSave)).sort()).toEqual([...STANDARD].sort());

    toggle("camera-groups-grid", "SpeedCam");

    expect(lastSaved(keypadSave)).toEqual(expect.objectContaining({ SpeedCam: true, Gearbox: true }));
    expect(Object.keys(lastSaved(keypadSave))).toHaveLength(STANDARD.length + 1);
  });

  it("drops a custom group from the map when it is unticked", () => {
    pushKeypadSubset({ SpeedCam: true });
    pushCatalog(CATALOG);
    toggle("camera-groups-grid", "SpeedCam");

    expect(lastSaved(keypadSave)).not.toHaveProperty("SpeedCam");
  });

  it("Select All ticks the standard groups and this track's custom ones, leaving the others alone", () => {
    pushKeypadSubset({ Zulu: false });
    pushCatalog(CATALOG);
    grid("btn-select-all").click();

    const saved = lastSaved(keypadSave);

    for (const name of STANDARD) expect(saved[name], name).toBe(true);

    expect(saved.SpeedCam).toBe(true);
    expect(saved.DynamicTV).toBe(true);
    expect(saved).not.toHaveProperty("Alpha");
    expect(saved.Zulu).toBe(false);
  });

  it("Clear unticks every group and drops the custom ones from the map", () => {
    pushKeypadSubset({ Nose: true, SpeedCam: true, Removed: true });
    pushCatalog(CATALOG);
    grid("btn-clear").click();

    const saved = lastSaved(keypadSave);

    expect(Object.keys(saved).sort()).toEqual([...STANDARD].sort());
    expect(Object.values(saved).every((v) => v === false)).toBe(true);
  });

  it("writes nothing when the catalog arrives or changes", () => {
    pushKeypadSubset({});
    pushCatalog(CATALOG);
    pushCatalog({ ...CATALOG, current: null });

    expect(keypadSave).not.toHaveBeenCalled();
    expect(dialSave).not.toHaveBeenCalled();
  });

  it("keeps groups named like Object.prototype members, and saves them as plain JSON", () => {
    // JSON.parse makes `__proto__` an own key; a plain-object copy would drop it.
    perKey.get("cameraGroupSubset")?.('{"groups":{"__proto__":true,"constructor":true,"Nose":true}}');
    pushCatalog({
      ...CATALOG,
      groups: [...CATALOG.groups, { name: "toString", tracks: [0], lastSeen: "" }],
    });

    expect(remembered("camera-groups-grid")).toEqual(
      expect.arrayContaining([
        { name: "__proto__", checked: true, dimmed: true },
        { name: "constructor", checked: true, dimmed: true },
        { name: "toString", checked: false, dimmed: true },
      ]),
    );

    toggle("camera-groups-grid", "Gearbox");

    const raw = keypadSave.mock.calls.at(-1)?.[0] as string;

    expect(raw).toContain('"__proto__":true');
    expect(raw).toContain('"constructor":true');
    expect(raw).not.toContain('"toString"');

    toggle("camera-groups-grid", "toString");
    expect(keypadSave.mock.calls.at(-1)?.[0]).toContain('"toString":true');

    toggle("camera-groups-grid", "__proto__");
    expect(keypadSave.mock.calls.at(-1)?.[0]).not.toContain("__proto__");
  });

  it("Select All and Clear keep and drop them as own keys", () => {
    perKey.get("cameraGroupSubset")?.('{"groups":{}}');
    pushCatalog({ ...CATALOG, current: { trackId: 2, groups: ["TV1", "__proto__", "constructor"] } });
    grid("btn-select-all").click();

    const selected = keypadSave.mock.calls.at(-1)?.[0] as string;

    expect(selected).toContain('"__proto__":true');
    expect(selected).toContain('"constructor":true');

    grid("btn-clear").click();
    expect(keypadSave.mock.calls.at(-1)?.[0]).not.toMatch(/__proto__|constructor/);
  });

  it("subscribes to the catalog under the key the plugin publishes", () => {
    expect(global.has(CAMERA_CATALOG_KEY)).toBe(true);
  });
});
