import { describe, expect, it } from "vitest";

import type { GalleryEntry } from "./lib.js";
import {
  buildGalleryToc,
  buildTemplateGroups,
  categoryRemainder,
  CLASS_SECTIONS,
  computePlacedCategoryActions,
  computePlacedKeyActions,
  defaultCategoryFor,
  defaultKeyFor,
  dialEntriesFor,
  dialRemainder,
  DYNAMIC_ONLY_ACTIONS,
  dynamicSectionEntries,
  familiesOf,
  familyAnchor,
  familyDisplayName,
  keyRemainder,
  titleCaseSlug,
} from "./sections.js";

function entry(overrides: Partial<GalleryEntry> & Pick<GalleryEntry, "class" | "family" | "name">): GalleryEntry {
  return {
    path: `packages/icons/${overrides.family}/${overrides.name}.svg`,
    slots: [],
    locked: [],
    actions: [],
    file: `/icon-gallery/${overrides.class}/${overrides.family}/${overrides.name}.svg`,
    ...overrides,
  };
}

const FIXTURE: GalleryEntry[] = [
  // template family "fuel-service" — single consumer, has a matching key entry,
  // AND is dial-capable (dial.svg + dash sample below).
  entry({
    class: "template",
    family: "fuel-service",
    name: "add-fuel",
    actions: ["fuel-service"],
    familyName: "Fuel Service",
  }),
  entry({
    class: "template",
    family: "fuel-service",
    name: "clear-fuel",
    actions: ["fuel-service"],
    familyName: "Fuel Service",
  }),
  // template family "camera-select" — single consumer, NO familyName set (fallback
  // path), and NO matching key entry (its consumer has no key.svg).
  entry({ class: "template", family: "camera-select", name: "blimp", actions: ["camera-controls"] }),
  // template family "force-feedback" — TIE-BREAK (item 16): two consuming actions, one
  // of which ("force-feedback") equals the family slug — mirrors the real
  // force-feedback/cockpit-misc split. The same-named consumer wins.
  entry({ class: "template", family: "force-feedback", name: "increase", actions: ["force-feedback", "cockpit-misc"] }),
  // template family "shared-graphics" — AMBIGUOUS with NO same-named consumer: two
  // distinct consuming actions, neither named "shared-graphics" — no placement.
  entry({ class: "template", family: "shared-graphics", name: "icon-a", actions: ["action-a"] }),
  entry({ class: "template", family: "shared-graphics", name: "icon-b", actions: ["action-b"] }),
  // template family "camera-focus" — mirrors the real repo quirk: single unambiguous
  // consumer "camera-controls", which has NO key/category entry of its own — its
  // key.svg/icon.svg live under a differently-named action folder ("camera-focus",
  // the pre-rename UUID/asset folder — CAMERA_FOCUS_UUID === CAMERA_CONTROLS_UUID in
  // camera-controls.ts). Both key and category placement fall back to the same-slug
  // match (gallery restructure wave, item 4 fix — previously category-only).
  entry({ class: "template", family: "camera-focus", name: "focus-your-car", actions: ["camera-controls"] }),
  // key entries
  entry({ class: "key", family: "fuel-service", name: "fuel-service", actions: ["fuel-service"] }),
  entry({ class: "key", family: "force-feedback", name: "force-feedback", actions: ["force-feedback"] }),
  entry({ class: "key", family: "camera-focus", name: "camera-focus", actions: ["camera-focus"] }),
  entry({ class: "key", family: "orphan-action", name: "orphan-action", actions: ["orphan-action"] }),
  entry({ class: "key", family: "pit-crew", name: "pit-crew", actions: ["pit-crew"] }),
  entry({ class: "key", family: "session-info", name: "session-info", actions: ["session-info"] }),
  entry({ class: "key", family: "telemetry-display", name: "telemetry-display", actions: ["telemetry-display"] }),
  // category entries
  entry({ class: "category", family: "fuel-service", name: "fuel-service" }),
  entry({ class: "category", family: "force-feedback", name: "force-feedback" }),
  entry({ class: "category", family: "camera-focus", name: "camera-focus" }),
  entry({ class: "category", family: "orphan-action", name: "orphan-action" }),
  entry({ class: "category", family: "pit-crew", name: "pit-crew" }),
  entry({ class: "category", family: "session-info", name: "session-info" }),
  entry({ class: "category", family: "telemetry-display", name: "telemetry-display" }),
  // dynamic entries — most stay in the flat "Dynamic templates" section
  // (family "dynamic-templates"); the three dynamic-only actions are tagged
  // with their own action slug as family so they attach to their group instead
  // (item 2). Pit Crew renders two distinct tri-state samples off the same
  // physical template (item 2's investigation).
  entry({ class: "dynamic", family: "dynamic-templates", name: "tire-service", sample: true }),
  entry({ class: "dynamic", family: "dynamic-templates", name: "setup-view", sample: true }),
  entry({
    class: "dynamic",
    family: "pit-crew",
    name: "pit-crew-engineer",
    actions: ["pit-crew"],
    familyName: "Pit Crew",
    sample: true,
  }),
  entry({
    class: "dynamic",
    family: "pit-crew",
    name: "pit-crew-radar",
    actions: ["pit-crew"],
    familyName: "Pit Crew",
    sample: true,
  }),
  entry({
    class: "dynamic",
    family: "session-info",
    name: "session-info",
    actions: ["session-info"],
    familyName: "Session Info",
    sample: true,
  }),
  entry({
    class: "dynamic",
    family: "telemetry-display",
    name: "telemetry-display",
    actions: ["telemetry-display"],
    familyName: "Telemetry Display",
    sample: true,
  }),
  // dial entries — fuel-service is dial-capable (icon + dash sample), matched
  // by direct slug. A "mystery" dash with no matching group proves
  // dialRemainder's safety net (item 3) actually catches an unmatched entry.
  entry({ class: "dial", family: "fuel-service", name: "fuel-service" }),
  entry({ class: "dial", family: "touch-strip", name: "fuel-service-dash", sample: true }),
  entry({ class: "dial", family: "touch-strip", name: "mystery-dash", sample: true }),
];

describe("familiesOf", () => {
  it("groups entries by family within a class, sorted by family name", () => {
    const grouped = familiesOf(FIXTURE, "template");

    expect(grouped.map(([family]) => family)).toEqual([
      "camera-focus",
      "camera-select",
      "force-feedback",
      "fuel-service",
      "shared-graphics",
    ]);
    expect(grouped.find(([family]) => family === "fuel-service")?.[1]).toHaveLength(2);
  });

  it("returns an empty array when the class has no entries", () => {
    expect(familiesOf(FIXTURE, "nonexistent")).toEqual([]);
  });
});

describe("familyAnchor", () => {
  it("joins class id and family with a hyphen", () => {
    expect(familyAnchor("template", "fuel-service")).toBe("template-fuel-service");
  });
});

describe("titleCaseSlug", () => {
  it("title-cases a single-segment slug", () => {
    expect(titleCaseSlug("chat")).toBe("Chat");
  });

  it("title-cases a multi-segment hyphenated slug", () => {
    expect(titleCaseSlug("camera-select")).toBe("Camera Select");
    expect(titleCaseSlug("ai-spotter-controls")).toBe("Ai Spotter Controls");
  });
});

describe("familyDisplayName", () => {
  it("uses the entry's familyName when set", () => {
    expect(familyDisplayName("fuel-service", FIXTURE)).toBe("Fuel Service");
  });

  it("falls back to the title-cased slug when familyName is unset", () => {
    expect(familyDisplayName("camera-select", FIXTURE)).toBe("Camera Select");
  });
});

describe("defaultKeyFor", () => {
  it("resolves the key entry when the family has exactly one consuming action with a key.svg", () => {
    const key = defaultKeyFor(FIXTURE, "fuel-service");

    expect(key?.name).toBe("fuel-service");
    expect(key?.class).toBe("key");
  });

  it("prefers the same-named consumer when a family has multiple consumers (item 16 tie-break)", () => {
    const key = defaultKeyFor(FIXTURE, "force-feedback");

    expect(key?.name).toBe("force-feedback");
    expect(key?.class).toBe("key");
  });

  it("returns undefined for an ambiguous family with no same-named consumer", () => {
    expect(defaultKeyFor(FIXTURE, "shared-graphics")).toBeUndefined();
  });

  it("returns undefined when the resolved consumer has no key.svg entry and no same-slug entry exists either", () => {
    expect(defaultKeyFor(FIXTURE, "camera-select")).toBeUndefined();
  });

  it("falls back to a same-slug key entry when the resolved consumer has none (gallery restructure wave, item 4 fix)", () => {
    // "camera-focus" resolves to consumer "camera-controls" (no key.svg), but a key
    // entry literally named "camera-focus" exists under a differently-named action
    // folder for the SAME real-world action — use it, mirroring defaultCategoryFor.
    const key = defaultKeyFor(FIXTURE, "camera-focus");

    expect(key?.name).toBe("camera-focus");
    expect(key?.class).toBe("key");
  });

  it("returns undefined for an unknown family", () => {
    expect(defaultKeyFor(FIXTURE, "does-not-exist")).toBeUndefined();
  });

  it("resolves an action-group slug directly by same-slug match (no template family, item 2)", () => {
    const key = defaultKeyFor(FIXTURE, "pit-crew");

    expect(key?.name).toBe("pit-crew");
    expect(key?.class).toBe("key");
  });
});

describe("computePlacedKeyActions / keyRemainder", () => {
  it("places fuel-service, force-feedback (tie-break), camera-focus (same-slug fallback), and the three dynamic-only actions, leaving only the true orphan", () => {
    const placed = computePlacedKeyActions(FIXTURE);

    expect(placed.has("fuel-service")).toBe(true);
    expect(placed.has("force-feedback")).toBe(true);
    expect(placed.has("camera-focus")).toBe(true);
    expect(placed.has("pit-crew")).toBe(true);
    expect(placed.has("session-info")).toBe(true);
    expect(placed.has("telemetry-display")).toBe(true);
    expect(placed.has("orphan-action")).toBe(false);

    const remainder = keyRemainder(FIXTURE);

    expect(remainder.map((e) => e.name)).toEqual(["orphan-action"]);
  });
});

describe("defaultCategoryFor", () => {
  it("resolves the category entry when the family has exactly one consuming action with an icon.svg", () => {
    const category = defaultCategoryFor(FIXTURE, "fuel-service");

    expect(category?.name).toBe("fuel-service");
    expect(category?.class).toBe("category");
  });

  it("prefers the same-named consumer when a family has multiple consumers (item 16 tie-break)", () => {
    const category = defaultCategoryFor(FIXTURE, "force-feedback");

    expect(category?.name).toBe("force-feedback");
    expect(category?.class).toBe("category");
  });

  it("returns undefined for an ambiguous family with no same-named consumer", () => {
    expect(defaultCategoryFor(FIXTURE, "shared-graphics")).toBeUndefined();
  });

  it("returns undefined when neither the resolved consumer nor the family slug has a category entry", () => {
    expect(defaultCategoryFor(FIXTURE, "camera-select")).toBeUndefined();
  });

  it("falls back to a same-slug category entry when the resolved consumer has none", () => {
    const category = defaultCategoryFor(FIXTURE, "camera-focus");

    expect(category?.name).toBe("camera-focus");
    expect(category?.class).toBe("category");
  });

  it("resolves an action-group slug directly by same-slug match (no template family, item 2)", () => {
    const category = defaultCategoryFor(FIXTURE, "session-info");

    expect(category?.name).toBe("session-info");
    expect(category?.class).toBe("category");
  });
});

describe("computePlacedCategoryActions / categoryRemainder", () => {
  it("places fuel-service, force-feedback (tie-break), camera-focus (same-slug fallback), and the three dynamic-only actions, leaving only the true orphan", () => {
    const placed = computePlacedCategoryActions(FIXTURE);

    expect(placed.has("fuel-service")).toBe(true);
    expect(placed.has("force-feedback")).toBe(true);
    expect(placed.has("camera-focus")).toBe(true);
    expect(placed.has("pit-crew")).toBe(true);
    expect(placed.has("session-info")).toBe(true);
    expect(placed.has("telemetry-display")).toBe(true);
    expect(placed.has("orphan-action")).toBe(false);

    const remainder = categoryRemainder(FIXTURE);

    expect(remainder.map((e) => e.name)).toEqual(["orphan-action"]);
  });
});

describe("dynamicSectionEntries", () => {
  it("keeps only the dynamic entries tagged with the generic dynamic-templates family", () => {
    const flat = dynamicSectionEntries(FIXTURE);

    expect(flat.map((e) => e.name).sort()).toEqual(["setup-view", "tire-service"]);
  });

  it("excludes the three dynamic-only actions' entries — they render inside their action group instead", () => {
    const flat = dynamicSectionEntries(FIXTURE);

    expect(flat.some((e) => e.family === "pit-crew")).toBe(false);
    expect(flat.some((e) => e.family === "session-info")).toBe(false);
    expect(flat.some((e) => e.family === "telemetry-display")).toBe(false);
  });
});

describe("dialEntriesFor", () => {
  it("returns the dial icon and dash sample for a dial-capable slug, icon first", () => {
    const dial = dialEntriesFor(FIXTURE, "fuel-service");

    expect(dial.map((e) => e.name)).toEqual(["fuel-service", "fuel-service-dash"]);
  });

  it("returns an empty array for a slug with no dial assets", () => {
    expect(dialEntriesFor(FIXTURE, "camera-select")).toEqual([]);
  });
});

describe("dialRemainder", () => {
  it("is empty when every dial entry maps to a group", () => {
    const withoutMystery = FIXTURE.filter((e) => e.name !== "mystery-dash");

    expect(dialRemainder(withoutMystery)).toEqual([]);
  });

  it("catches a dial entry that maps to no group (item 3 safety net)", () => {
    const remainder = dialRemainder(FIXTURE);

    expect(remainder.map((e) => e.name)).toEqual(["mystery-dash"]);
  });
});

describe("buildTemplateGroups", () => {
  const groups = buildTemplateGroups(FIXTURE);

  it("includes one group per template family plus one per dynamic-only action, sorted by display name", () => {
    expect(groups.map((g) => g.displayName)).toEqual([
      "Camera Focus",
      "Camera Select",
      "Force Feedback",
      "Fuel Service",
      "Pit Crew",
      "Session Info",
      "Shared Graphics",
      "Telemetry Display",
    ]);
  });

  it("marks family groups vs action groups correctly", () => {
    const byName = new Map(groups.map((g) => [g.displayName, g]));

    expect(byName.get("Fuel Service")?.kind).toBe("family");
    expect(byName.get("Pit Crew")?.kind).toBe("action");
    expect(byName.get("Session Info")?.kind).toBe("action");
    expect(byName.get("Telemetry Display")?.kind).toBe("action");
  });

  it("gives an action group its dynamic entries as the main grid, with the explanatory blurb set", () => {
    const pitCrew = groups.find((g) => g.slug === "pit-crew");

    expect(pitCrew?.entries.map((e) => e.name).sort()).toEqual(["pit-crew-engineer", "pit-crew-radar"]);
    expect(pitCrew?.blurb).toMatch(/no static icon templates/);
    expect(pitCrew?.defaultKey?.name).toBe("pit-crew");
    expect(pitCrew?.categoryIcon?.name).toBe("pit-crew");
  });

  it("gives a family group its template entries as the main grid, with no blurb", () => {
    const fuel = groups.find((g) => g.slug === "fuel-service");

    expect(fuel?.entries.map((e) => e.name).sort()).toEqual(["add-fuel", "clear-fuel"]);
    expect(fuel?.blurb).toBeUndefined();
  });

  it("attaches the dial sub-row only to the dial-capable group", () => {
    const fuel = groups.find((g) => g.slug === "fuel-service");
    const camera = groups.find((g) => g.slug === "camera-select");

    expect(fuel?.dialEntries.map((e) => e.name)).toEqual(["fuel-service", "fuel-service-dash"]);
    expect(camera?.dialEntries).toEqual([]);
  });

  it("anchors action groups the same way as family groups", () => {
    const pitCrew = groups.find((g) => g.slug === "pit-crew");

    expect(pitCrew?.anchor).toBe("template-pit-crew");
  });
});

describe("DYNAMIC_ONLY_ACTIONS", () => {
  it("names exactly the three dynamic-only actions", () => {
    expect([...DYNAMIC_ONLY_ACTIONS].sort()).toEqual(["pit-crew", "session-info", "telemetry-display"]);
  });
});

describe("CLASS_SECTIONS", () => {
  it("keeps only the template and dynamic sections — key/category/dial were dissolved into groups", () => {
    expect(CLASS_SECTIONS.map((s) => s.id)).toEqual(["template", "dynamic"]);
  });

  it("marks only the template section as non-flat", () => {
    const flags = Object.fromEntries(CLASS_SECTIONS.map((s) => [s.id, s.flat]));

    expect(flags.template).toBe(false);
    expect(flags.dynamic).toBe(true);
  });
});

describe("buildGalleryToc", () => {
  it("emits one depth-2 item per class section, in CLASS_SECTIONS order", () => {
    const toc = buildGalleryToc(FIXTURE);

    expect(toc.map((t) => t.slug)).toEqual(CLASS_SECTIONS.map((s) => `class-${s.id}`));
    expect(toc.every((t) => t.depth === 2)).toBe(true);
  });

  it("gives the dynamic section no children", () => {
    const toc = buildGalleryToc(FIXTURE);
    const dynamic = toc.find((t) => t.slug === "class-dynamic");

    expect(dynamic?.children).toEqual([]);
  });

  it("gives the template section one depth-3 child per group — families AND the three action groups — using the friendly display name", () => {
    const toc = buildGalleryToc(FIXTURE);
    const template = toc.find((t) => t.slug === "class-template");

    expect(template?.children).toEqual([
      { depth: 3, slug: "template-camera-focus", text: "Camera Focus", children: [] },
      { depth: 3, slug: "template-camera-select", text: "Camera Select", children: [] },
      { depth: 3, slug: "template-force-feedback", text: "Force Feedback", children: [] },
      { depth: 3, slug: "template-fuel-service", text: "Fuel Service", children: [] },
      { depth: 3, slug: "template-pit-crew", text: "Pit Crew", children: [] },
      { depth: 3, slug: "template-session-info", text: "Session Info", children: [] },
      { depth: 3, slug: "template-shared-graphics", text: "Shared Graphics", children: [] },
      { depth: 3, slug: "template-telemetry-display", text: "Telemetry Display", children: [] },
    ]);
  });
});
