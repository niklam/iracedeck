// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CalloutCount, formatCalloutCount } from "./callout-count.js";

type Box = HTMLElement & { value?: unknown };

/** What sdpi does when a checkbox's value changes: set it, then dispatch `valuechange` on the box. */
function setValue(box: Box, value: unknown): void {
  box.value = value;
  box.dispatchEvent(new Event("valuechange"));
}

/** A section as the partial renders it, with plain elements standing in for the sdpi controls. */
function section(id: string, initial: string, boxes: string): string {
  return (
    `<details class="ird-callout-section" data-callout-section="${id}">` +
    `<summary><span>${id}</span><ird-callout-count>${initial}</ird-callout-count></summary>` +
    boxes +
    `</details>`
  );
}

function box(setting: string, on: boolean): string {
  return `<sdpi-checkbox setting="${setting}" label="x" global${on ? ' default="true"' : ""}></sdpi-checkbox>`;
}

function count(id: string): CalloutCount {
  return document.querySelector(`[data-callout-section="${id}"] ird-callout-count`)!;
}

function boxIn(setting: string): Box {
  return document.querySelector(`[setting="${setting}"]`)!;
}

describe("formatCalloutCount", () => {
  it("says how many of the section's opt-ins are on, in the partial's words", () => {
    expect(formatCalloutCount(24, 25)).toBe("24 of 25 on");
    expect(formatCalloutCount(0, 3)).toBe("0 of 3 on");
  });
});

describe("ird-callout-count (#1700)", () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  it("is registered as ird-callout-count", () => {
    expect(customElements.get("ird-callout-count")).toBe(CalloutCount);
  });

  it("counts value ?? default: the stored value wins, the default attribute stands in while nothing is stored", () => {
    document.body.innerHTML = section(
      "s",
      "stale",
      box("calloutEnabledA", true) + box("calloutEnabledB", true) + box("calloutEnabledC", false),
    );

    expect(count("s").textContent).toBe("2 of 3 on");

    setValue(boxIn("calloutEnabledA"), false);
    expect(count("s").textContent).toBe("1 of 3 on");

    setValue(boxIn("calloutEnabledC"), true);
    expect(count("s").textContent).toBe("2 of 3 on");
  });

  it("recounts on each box's valuechange, as a click, a plugin push or the initial load fires it", () => {
    document.body.innerHTML = section("s", "", box("calloutEnabledA", false) + box("calloutEnabledB", false));

    expect(count("s").textContent).toBe("0 of 2 on");

    setValue(boxIn("calloutEnabledA"), true);
    expect(count("s").textContent).toBe("1 of 2 on");

    setValue(boxIn("calloutEnabledB"), true);
    expect(count("s").textContent).toBe("2 of 2 on");
  });

  it("counts only the callout boxes of its own section, never a slider or another section's boxes", () => {
    document.body.innerHTML =
      section(
        "one",
        "",
        box("calloutEnabledA", true) +
          '<ird-range-input setting="gapAlertThresholdSeconds" global></ird-range-input>' +
          '<sdpi-checkbox setting="raceEngineerRadioBeeps" global default="true"></sdpi-checkbox>',
      ) + section("two", "", box("calloutEnabledB", false) + box("calloutEnabledC", false));

    expect(count("one").textContent).toBe("1 of 1 on");
    expect(count("two").textContent).toBe("0 of 2 on");

    setValue(boxIn("calloutEnabledB"), true);
    expect(count("one").textContent).toBe("1 of 1 on");
    expect(count("two").textContent).toBe("1 of 2 on");

    setValue(boxIn("calloutEnabledA"), false);
    expect(count("one").textContent).toBe("0 of 1 on");
    expect(count("two").textContent).toBe("1 of 2 on");
  });

  it("writes text only, never markup", () => {
    document.body.innerHTML = section("s", "<b>bold</b>", box("calloutEnabledA", true));

    expect(count("s").textContent).toBe("1 of 1 on");
    expect(count("s").children).toHaveLength(0);
  });

  describe("while the document is still parsing", () => {
    const readyState = Object.getOwnPropertyDescriptor(Document.prototype, "readyState")!;

    afterEach(() => {
      delete (document as unknown as Record<string, unknown>).readyState;
      Object.defineProperty(Document.prototype, "readyState", readyState);
    });

    function parsing(): void {
      Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    }

    it("keeps the rendered text until its boxes exist, then picks them up at DOMContentLoaded", () => {
      parsing();
      // The summary, and the count in it, is parsed before the boxes below it.
      document.body.innerHTML = section("s", "1 of 2 on", "");

      expect(count("s").textContent).toBe("1 of 2 on");

      document
        .querySelector("details")!
        .insertAdjacentHTML("beforeend", box("calloutEnabledA", true) + box("calloutEnabledB", true));
      document.dispatchEvent(new Event("DOMContentLoaded"));

      expect(count("s").textContent).toBe("2 of 2 on");

      setValue(boxIn("calloutEnabledB"), false);
      expect(count("s").textContent).toBe("1 of 2 on");
    });

    it("drops its DOMContentLoaded listener when disconnected before the document is parsed", () => {
      parsing();
      document.body.innerHTML = section("s", "rendered", "");

      const details = document.querySelector("details")!;
      const counter = count("s");

      // Detach the whole section, then give it boxes: a listener left behind
      // would find them through the detached section and count them.
      details.remove();
      details.insertAdjacentHTML("beforeend", box("calloutEnabledA", true) + box("calloutEnabledB", false));
      document.dispatchEvent(new Event("DOMContentLoaded"));

      expect(counter.textContent).toBe("rendered");
    });
  });

  it("drops its box listeners on disconnect", () => {
    document.body.innerHTML = section("s", "", box("calloutEnabledA", true) + box("calloutEnabledB", true));

    const details = document.querySelector("details")!;
    const counter = count("s");
    const a = boxIn("calloutEnabledA");

    expect(counter.textContent).toBe("2 of 2 on");

    // Detach the whole section: the boxes stay reachable from the count, so a
    // listener left behind would recount them on the next change.
    details.remove();
    setValue(a, false);

    expect(counter.textContent).toBe("2 of 2 on");
  });
});
