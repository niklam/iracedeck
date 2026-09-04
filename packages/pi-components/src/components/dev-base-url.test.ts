// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import "./dev-base-url.js";

let callback: ((value: string) => void) | undefined;

function mount(): HTMLElement {
  callback = undefined;
  document.body.replaceChildren();
  (window as unknown as { SDPIComponents: unknown }).SDPIComponents = {
    useGlobalSettings: (_key: string, cb: (value: string) => void) => {
      callback = cb;

      return [async () => "", vi.fn()];
    },
  };

  const el = document.createElement("ird-dev-base-url");

  document.body.appendChild(el);

  return el;
}

const publish = (value: string) => callback?.(value);

describe("ird-dev-base-url (#1100)", () => {
  beforeEach(() => mount());

  // The design: an ordinary installation's Diagnostics tab must be unchanged,
  // with no field inviting anyone to paste a URL in.
  it.each([
    ["nothing has been published", null],
    ["the value is empty", ""],
    ["the value is whitespace", "   "],
  ])("renders nothing when %s", (_label, value) => {
    const el = document.querySelector("ird-dev-base-url")!;

    if (value !== null) publish(value);

    expect(el.textContent).toBe("");
    expect((el as HTMLElement).hidden).toBe(true);
  });

  it("shows the resolved catalog URL when the override is set", () => {
    const el = document.querySelector("ird-dev-base-url")!;

    publish("http://127.0.0.1:8080");

    expect((el as HTMLElement).hidden).toBe(false);
    expect(el.textContent).toContain("http://127.0.0.1:8080/voice-catalog.json");
  });

  // A typo must not look active on the very screen someone checks to find out
  // whether it is.
  it.each([
    ["plaintext to a real host", "http://example.com"],
    ["not a URL", "iracedeck.com"],
    ["a query string", "https://example.com?x=1"],
  ])("shows the published URL when the override is unusable (%s)", (_label, value) => {
    const el = document.querySelector("ird-dev-base-url")!;

    publish(value);

    expect(el.textContent).toContain("https://iracedeck.com/voice-catalog.json");
  });

  it("renders the value as text, never as markup", () => {
    const el = document.querySelector("ird-dev-base-url")!;

    publish("https://example.com/<img src=x onerror=alert(1)>");

    expect(el.querySelector("img")).toBeNull();
  });

  it("goes back to rendering nothing when the override is removed", () => {
    const el = document.querySelector("ird-dev-base-url")!;

    publish("http://127.0.0.1:8080");
    publish("");

    expect((el as HTMLElement).hidden).toBe(true);
    expect(el.textContent).toBe("");
  });
});
