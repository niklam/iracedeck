import { describe, expect, it } from "vitest";

import type { GalleryEntry } from "./lib.js";
import {
  buildGalleryToc,
  categoryRemainder,
  CLASS_SECTIONS,
  computePlacedCategoryActions,
  computePlacedKeyActions,
  defaultCategoryFor,
  defaultKeyFor,
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
  // template family "fuel-service" — unambiguous single consumer, has a matching key entry.
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
  // template family "camera-select" — unambiguous single consumer, NO familyName set
  // (fallback path), and NO matching key entry (its consumer has no key.svg).
  entry({ class: "template", family: "camera-select", name: "blimp", actions: ["camera-controls"] }),
  // template family "car-control" — AMBIGUOUS: two distinct consuming actions.
  entry({ class: "template", family: "car-control", name: "drs-on", actions: ["car-control"] }),
  entry({ class: "template", family: "car-control", name: "drs-off", actions: ["other-action"] }),
  // key entries
  entry({ class: "key", family: "fuel-service", name: "fuel-service", actions: ["fuel-service"] }),
  entry({ class: "key", family: "orphan-action", name: "orphan-action", actions: ["orphan-action"] }),
  // category entries — fuel-service placeable beside its family heading (item 15);
  // orphan-action has no template family, so it stays in the remainder.
  entry({ class: "category", family: "fuel-service", name: "fuel-service" }),
  entry({ class: "category", family: "orphan-action", name: "orphan-action" }),
  // flat classes
  entry({ class: "dynamic", family: "dynamic-templates", name: "tire-service" }),
  entry({ class: "dial", family: "shared", name: "setup-brakes-dash" }),
];

describe("familiesOf", () => {
  it("groups entries by family within a class, sorted by family name", () => {
    const grouped = familiesOf(FIXTURE, "template");

    expect(grouped.map(([family]) => family)).toEqual(["camera-select", "car-control", "fuel-service"]);
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

  it("returns undefined for an ambiguous family (more than one consuming action)", () => {
    expect(defaultKeyFor(FIXTURE, "car-control")).toBeUndefined();
  });

  it("returns undefined when the unambiguous consumer has no key.svg entry", () => {
    expect(defaultKeyFor(FIXTURE, "camera-select")).toBeUndefined();
  });

  it("returns undefined for an unknown family", () => {
    expect(defaultKeyFor(FIXTURE, "does-not-exist")).toBeUndefined();
  });
});

describe("computePlacedKeyActions / keyRemainder", () => {
  it("places the fuel-service key action and leaves the orphan action in the remainder", () => {
    const placed = computePlacedKeyActions(FIXTURE);

    expect(placed.has("fuel-service")).toBe(true);
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

  it("returns undefined for an ambiguous family (more than one consuming action)", () => {
    expect(defaultCategoryFor(FIXTURE, "car-control")).toBeUndefined();
  });

  it("returns undefined when the unambiguous consumer has no category entry", () => {
    expect(defaultCategoryFor(FIXTURE, "camera-select")).toBeUndefined();
  });
});

describe("computePlacedCategoryActions / categoryRemainder", () => {
  it("places the fuel-service category action and leaves the orphan action in the remainder", () => {
    const placed = computePlacedCategoryActions(FIXTURE);

    expect(placed.has("fuel-service")).toBe(true);
    expect(placed.has("orphan-action")).toBe(false);

    const remainder = categoryRemainder(FIXTURE);

    expect(remainder.map((e) => e.name)).toEqual(["orphan-action"]);
  });
});

describe("CLASS_SECTIONS", () => {
  it("marks only the template section as non-flat", () => {
    const flags = Object.fromEntries(CLASS_SECTIONS.map((s) => [s.id, s.flat]));

    expect(flags.template).toBe(false);
    expect(flags.dynamic).toBe(true);
    expect(flags.key).toBe(true);
    expect(flags.dial).toBe(true);
    expect(flags.category).toBe(true);
  });
});

describe("buildGalleryToc", () => {
  it("emits one depth-2 item per class section, in CLASS_SECTIONS order", () => {
    const toc = buildGalleryToc(FIXTURE);

    expect(toc.map((t) => t.slug)).toEqual(CLASS_SECTIONS.map((s) => `class-${s.id}`));
    expect(toc.every((t) => t.depth === 2)).toBe(true);
  });

  it("gives flat sections no children", () => {
    const toc = buildGalleryToc(FIXTURE);
    const dynamic = toc.find((t) => t.slug === "class-dynamic");

    expect(dynamic?.children).toEqual([]);
  });

  it("gives the template section one depth-3 child per family, using the friendly display name", () => {
    const toc = buildGalleryToc(FIXTURE);
    const template = toc.find((t) => t.slug === "class-template");

    expect(template?.children).toEqual([
      { depth: 3, slug: "template-camera-select", text: "Camera Select", children: [] },
      { depth: 3, slug: "template-car-control", text: "Car Control", children: [] },
      { depth: 3, slug: "template-fuel-service", text: "Fuel Service", children: [] },
    ]);
  });
});
