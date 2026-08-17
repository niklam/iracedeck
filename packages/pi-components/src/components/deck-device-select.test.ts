// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./deck-device-select.js";

type GlobalHook = (key: string, onValue: (value: unknown) => void) => void;

describe("ird-deck-device-select", () => {
  let deliver: ((value: unknown) => void) | undefined;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    deliver = undefined;

    const useGlobalSettings: GlobalHook = vi.fn((key, onValue) => {
      if (key === "_deckDevices") deliver = onValue;
    });
    (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function mount(attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement("ird-deck-device-select");

    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);

    document.body.appendChild(el);

    return el;
  }

  it("renders a <select> with the given id and a placeholder option", () => {
    const el = mount({ "select-id": "deck" });
    const select = el.querySelector("select");

    expect(select?.id).toBe("deck");
    expect(select?.options[0]?.value).toBe("");
  });

  it("populates one option per connected deck from the _deckDevices global", () => {
    const el = mount({ "select-id": "deck" });

    deliver?.(
      JSON.stringify([
        { id: "dev-1", name: "Stream Deck XL", type: 2 },
        { id: "dev-2", name: "Stream Deck +", type: 7 },
      ]),
    );

    const options = Array.from(el.querySelector("select")?.options ?? []).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["", "Choose a Stream Deck…"],
      ["dev-1", "Stream Deck XL"],
      ["dev-2", "Stream Deck +"],
    ]);
  });

  it("auto-selects the deck when exactly one is connected — the common case needs no click", () => {
    const el = mount({ "select-id": "deck" });

    deliver?.(JSON.stringify([{ id: "dev-1", name: "Stream Deck XL", type: 2 }]));

    expect(el.querySelector("select")?.value).toBe("dev-1");
  });

  it("keeps the user's choice across list refreshes when that deck is still present", () => {
    const el = mount({ "select-id": "deck" });
    const two = JSON.stringify([
      { id: "dev-1", name: "A", type: 2 },
      { id: "dev-2", name: "B", type: 7 },
    ]);

    deliver?.(two);
    const select = el.querySelector("select")!;
    select.value = "dev-2";
    deliver?.(two);

    expect(select.value).toBe("dev-2");
  });

  it("tolerates a malformed list", () => {
    const el = mount({ "select-id": "deck" });

    expect(() => deliver?.("not json")).not.toThrow();
    expect(el.querySelector("select")?.options.length).toBe(1);
  });
});
