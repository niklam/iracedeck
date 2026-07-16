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
  // template family "fuel-service" — single consumer, has a matching key entry.
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
  // consumer "camera-controls", which has NO category entry of its own. A separate,
  // same-named "camera-focus" category entry exists from a distinct legacy action
  // folder — the SAME-SLUG fallback (category-only) should place it; key placement
  // must NOT use this fallback (a same-named key entry also exists, for contrast).
  entry({ class: "template", family: "camera-focus", name: "focus-your-car", actions: ["camera-controls"] }),
  // key entries
  entry({ class: "key", family: "fuel-service", name: "fuel-service", actions: ["fuel-service"] }),
  entry({ class: "key", family: "force-feedback", name: "force-feedback", actions: ["force-feedback"] }),
  entry({ class: "key", family: "camera-focus", name: "camera-focus", actions: ["camera-focus"] }),
  entry({ class: "key", family: "orphan-action", name: "orphan-action", actions: ["orphan-action"] }),
  // category entries — fuel-service/force-feedback placeable beside their family
  // headings (item 15); orphan-action has no template family, so it stays in the
  // remainder; camera-focus is the same-slug fallback case above.
  entry({ class: "category", family: "fuel-service", name: "fuel-service" }),
  entry({ class: "category", family: "force-feedback", name: "force-feedback" }),
  entry({ class: "category", family: "camera-focus", name: "camera-focus" }),
  entry({ class: "category", family: "orphan-action", name: "orphan-action" }),
  // flat classes
  entry({ class: "dynamic", family: "dynamic-templates", name: "tire-service" }),
  entry({ class: "dial", family: "shared", name: "setup-brakes-dash" }),
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

  it("returns undefined when the resolved consumer has no key.svg entry", () => {
    expect(defaultKeyFor(FIXTURE, "camera-select")).toBeUndefined();
  });

  it("does NOT apply the category same-slug fallback — a same-named key entry belonging to a different action is ignored", () => {
    // "camera-focus" resolves to consumer "camera-controls" (unambiguous), which has
    // no key.svg. A key entry literally named "camera-focus" exists (a different,
    // unrelated action folder) but must not be used — that fallback is category-only.
    expect(defaultKeyFor(FIXTURE, "camera-focus")).toBeUndefined();
  });

  it("returns undefined for an unknown family", () => {
    expect(defaultKeyFor(FIXTURE, "does-not-exist")).toBeUndefined();
  });
});

describe("computePlacedKeyActions / keyRemainder", () => {
  it("places the fuel-service and force-feedback (tie-break) key actions, leaving camera-focus and the orphan action in the remainder", () => {
    const placed = computePlacedKeyActions(FIXTURE);

    expect(placed.has("fuel-service")).toBe(true);
    expect(placed.has("force-feedback")).toBe(true);
    expect(placed.has("camera-focus")).toBe(false);
    expect(placed.has("orphan-action")).toBe(false);

    const remainder = keyRemainder(FIXTURE);

    expect(remainder.map((e) => e.name)).toEqual(["camera-focus", "orphan-action"]);
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

  it("falls back to a same-slug category entry when the resolved consumer has none (owner follow-up refinement)", () => {
    // "camera-focus" resolves to consumer "camera-controls" (no category icon), but a
    // category entry literally named "camera-focus" exists — use it.
    const category = defaultCategoryFor(FIXTURE, "camera-focus");

    expect(category?.name).toBe("camera-focus");
    expect(category?.class).toBe("category");
  });
});

describe("computePlacedCategoryActions / categoryRemainder", () => {
  it("places fuel-service, force-feedback (tie-break), and camera-focus (same-slug fallback) category actions, leaving only the orphan action in the remainder", () => {
    const placed = computePlacedCategoryActions(FIXTURE);

    expect(placed.has("fuel-service")).toBe(true);
    expect(placed.has("force-feedback")).toBe(true);
    expect(placed.has("camera-focus")).toBe(true);
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
      { depth: 3, slug: "template-camera-focus", text: "Camera Focus", children: [] },
      { depth: 3, slug: "template-camera-select", text: "Camera Select", children: [] },
      { depth: 3, slug: "template-force-feedback", text: "Force Feedback", children: [] },
      { depth: 3, slug: "template-fuel-service", text: "Fuel Service", children: [] },
      { depth: 3, slug: "template-shared-graphics", text: "Shared Graphics", children: [] },
    ]);
  });
});
