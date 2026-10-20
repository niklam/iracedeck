// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_DEVICE_CHANGE_EVENT, type DeckDeviceChangeDetail, type DeckDeviceSelect } from "./deck-device-select.js";

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

  describe("the chosen deck's type (#1457)", () => {
    function listen(): DeckDeviceChangeDetail[] {
      const seen: DeckDeviceChangeDetail[] = [];

      document.addEventListener(DECK_DEVICE_CHANGE_EVENT, (e) => {
        seen.push((e as CustomEvent<DeckDeviceChangeDetail>).detail);
      });

      return seen;
    }

    it("is undefined with no deck chosen", () => {
      const el = mount({ "select-id": "deck" }) as DeckDeviceSelect;

      deliver?.(
        JSON.stringify([
          { id: "dev-1", name: "A", type: 2 },
          { id: "dev-2", name: "B", type: 7 },
        ]),
      );

      expect(el.selectedDeviceType).toBeUndefined();
    });

    it("announces the auto-selected deck's type, bubbling to the document", () => {
      const seen = listen();
      const el = mount({ "select-id": "deck-auto" }) as DeckDeviceSelect;

      deliver?.(JSON.stringify([{ id: "dev-1", name: "Stream Deck +", type: 7 }]));

      expect(el.selectedDeviceType).toBe(7);
      expect(seen.filter((d) => d.selectId === "deck-auto")).toEqual([
        { selectId: "deck-auto", deviceId: "dev-1", deviceType: 7 },
      ]);
    });

    it("announces the user's pick, and the return to no choice", () => {
      const seen = listen();
      const el = mount({ "select-id": "deck-pick" });

      deliver?.(
        JSON.stringify([
          { id: "dev-1", name: "A", type: 2 },
          { id: "dev-2", name: "B", type: 9 },
        ]),
      );

      const select = el.querySelector("select")!;

      select.value = "dev-2";
      select.dispatchEvent(new Event("change"));
      select.value = "";
      select.dispatchEvent(new Event("change"));

      expect(seen.filter((d) => d.selectId === "deck-pick")).toEqual([
        { selectId: "deck-pick", deviceId: "dev-2", deviceType: 9 },
        { selectId: "deck-pick", deviceId: "", deviceType: undefined },
      ]);
    });

    it("stays silent on a refresh that keeps the same deck", () => {
      const seen = listen();
      const list = JSON.stringify([{ id: "dev-1", name: "A", type: 2 }]);

      mount({ "select-id": "deck-quiet" });
      deliver?.(list);
      deliver?.(JSON.stringify([{ id: "dev-1", name: "A renamed", type: 2 }]));

      expect(seen.filter((d) => d.selectId === "deck-quiet")).toHaveLength(1);
    });

    it("announces the loss of the chosen deck when it disconnects", () => {
      const seen = listen();

      mount({ "select-id": "deck-gone" });
      deliver?.(JSON.stringify([{ id: "dev-1", name: "A", type: 2 }]));
      deliver?.(JSON.stringify([]));

      expect(seen.filter((d) => d.selectId === "deck-gone").at(-1)).toEqual({
        selectId: "deck-gone",
        deviceId: "",
        deviceType: undefined,
      });
    });

    it("reads a deck published without a type as unknown", () => {
      const el = mount({ "select-id": "deck" }) as DeckDeviceSelect;

      deliver?.(JSON.stringify([{ id: "dev-1", name: "A" }]));

      expect(el.querySelector("select")?.value).toBe("dev-1");
      expect(el.selectedDeviceType).toBeUndefined();
    });
  });

  it("tolerates a malformed list", () => {
    const el = mount({ "select-id": "deck" });

    expect(() => deliver?.("not json")).not.toThrow();
    expect(el.querySelector("select")?.options.length).toBe(1);
  });
});
