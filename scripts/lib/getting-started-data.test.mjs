import { describe, expect, it } from "vitest";

import { buildGettingStartedData, serializeGettingStartedData } from "./getting-started-data.mjs";

const page = (body) => `---\ntitle: First Steps\ndescription: x\n---\n\n${body}`;

describe("buildGettingStartedData", () => {
  it("renders prose to escaped HTML", () => {
    const data = buildGettingStartedData(page("## S\n\nIt is **off** by default & quiet.\n"));

    expect(data.sections[0].blocks[0]).toEqual({
      type: "paragraph",
      html: "It is <strong>off</strong> by default &amp; quiet.",
    });
  });

  it("renders list items the same way", () => {
    const data = buildGettingStartedData(page("## S\n\n- **Fuel Service** — sets `fuel`\n"));

    expect(data.sections[0].blocks[0].items[0]).toContain("<strong>Fuel Service</strong>");
    expect(data.sections[0].blocks[0].items[0]).toContain("<code>fuel</code>");
  });

  it("rebases a site-absolute link onto the website, so the window can open it", () => {
    const data = buildGettingStartedData(page("## S\n\nSee [docs](/docs/).\n"));

    expect(data.sections[0].blocks[0].html).toContain('href="https://iracedeck.com/docs/"');
  });

  it("passes an action block through as its id alone", () => {
    const data = buildGettingStartedData(page("## S\n\nProse.\n\n<!-- ird:action open-profiles-tab -->\n"));

    // What the id renders as — and whether it renders at all, since the
    // Profiles control exists only where the `profiles` flag is on — is the
    // pane's business. The artifact carries the id and nothing else.
    expect(data.sections[0].blocks[1]).toEqual({ type: "action", id: "open-profiles-tab" });
  });

  it("names the section when a link target is refused", () => {
    expect(() => buildGettingStartedData(page("## Where to go next\n\nSee [x](mailto:a@b.c).\n"))).toThrow(
      /getting started \/ Where to go next/,
    );
  });

  it("records where it came from and how to regenerate it", () => {
    const data = buildGettingStartedData(page("## S\n\nText.\n"));

    expect(data._meta.generatedBy).toBe("pnpm generate:getting-started-data");
  });
});

describe("serializeGettingStartedData", () => {
  it("ends with a newline, so the committed file compares byte-for-byte", () => {
    expect(serializeGettingStartedData({ _meta: {}, sections: [] })).toBe('{\n  "_meta": {},\n  "sections": []\n}\n');
  });
});
