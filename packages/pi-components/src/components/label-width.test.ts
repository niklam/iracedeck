// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseLabelWidth } from "./label-width.js";

/** Stands in for the vendored sdpi-item: a shadow root holding its `.grid`. */
class FakeSdpiItem extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `<div class="container grid"></div>`;
  }
}

const markerStyles = (item: Element): HTMLStyleElement[] =>
  Array.from(item.shadowRoot!.querySelectorAll<HTMLStyleElement>("style[data-ird-label-width]"));

/** Let the wrapper's `whenDefined` callback run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("parseLabelWidth", () => {
  it("reads a width in range and falls back to 140 otherwise", () => {
    expect(parseLabelWidth("160")).toBe(160);
    expect(parseLabelWidth(" 120 ")).toBe(120);
    expect(parseLabelWidth(null)).toBe(140);
    expect(parseLabelWidth("")).toBe(140);
    expect(parseLabelWidth("wide")).toBe(140);
    expect(parseLabelWidth("12.5")).toBe(140);
    expect(parseLabelWidth("40")).toBe(140);
    expect(parseLabelWidth("900")).toBe(140);
  });
});

describe("ird-label-width", () => {
  beforeAll(() => {
    if (!customElements.get("sdpi-item")) customElements.define("sdpi-item", FakeSdpiItem);
  });

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  it("widens the label column of every sdpi-item inside it, once each, and leaves the rest alone", async () => {
    document.body.innerHTML =
      `<sdpi-item id="outside" label="Outside"></sdpi-item>` +
      `<ird-label-width width="160"><sdpi-item label="Race Admin Per Car"></sdpi-item>` +
      `<div><sdpi-item label="Nested"></sdpi-item></div></ird-label-width>`;
    await flush();

    const inside = Array.from(document.querySelectorAll("ird-label-width sdpi-item"));

    expect(inside).toHaveLength(2);

    for (const item of inside) {
      expect(markerStyles(item).map((s) => s.textContent)).toEqual([
        ".container.grid{grid-template-columns:160px 241px}",
      ]);
    }

    expect(markerStyles(document.getElementById("outside")!)).toEqual([]);

    // Re-applying (a second connect) updates the one style rather than adding another.
    const wrapper = document.querySelector("ird-label-width")!;

    wrapper.setAttribute("width", "150");
    document.body.appendChild(wrapper);
    await flush();
    expect(markerStyles(inside[0]!).map((s) => s.textContent)).toEqual([
      ".container.grid{grid-template-columns:150px 241px}",
    ]);
  });

  it("exposes the width for the supporting-text indent and uses the default without an attribute", async () => {
    document.body.innerHTML = `<ird-label-width><sdpi-item label="Default"></sdpi-item></ird-label-width>`;
    await flush();

    const wrapper = document.querySelector<HTMLElement>("ird-label-width")!;

    expect(wrapper.style.getPropertyValue("--ird-label-width")).toBe("140px");
    expect(document.head.textContent).toContain(
      "ird-label-width .ird-supporting-text:not(.ird-supporting-text-full) { padding-left: var(--ird-label-width); }",
    );
  });
});
