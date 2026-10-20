// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./deck-device-select.js";
import { parseDeviceTypes } from "./profile-variants.js";

type GlobalHook = (key: string, onValue: (value: unknown) => void) => void;

/**
 * The Stream Deck Profiles card's per-deck rows (#1457): the real picker drives
 * the real wrapper, in the markup `global-stream-deck-profiles.ejs` renders.
 */
describe("ird-profile-variants", () => {
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

  /** The card: a picker, then the wrapper with two rows and the note. */
  function mountCard(selectId = "sw-deck"): HTMLElement {
    const card = document.createElement("div");

    card.innerHTML =
      `<ird-deck-device-select select-id="${selectId}"></ird-deck-device-select>` +
      `<ird-profile-variants device-from="${selectId}">` +
      `<div class="row" data-device-types="0,2,7,13">Default</div>` +
      `<div class="row" data-device-types="0,2">Replay</div>` +
      `<div class="other">no types</div>` +
      `<div class="note" data-no-variants hidden>none</div>` +
      `</ird-profile-variants>`;
    document.body.appendChild(card);

    return card;
  }

  function state(card: HTMLElement): { rows: string[]; note: boolean } {
    const rows = Array.from(card.querySelectorAll<HTMLElement>(".row"))
      .filter((r) => !r.hidden)
      .map((r) => r.textContent ?? "");

    return { rows, note: !card.querySelector<HTMLElement>(".note")!.hidden };
  }

  function pick(card: HTMLElement, id: string): void {
    const select = card.querySelector("select")!;

    select.value = id;
    select.dispatchEvent(new Event("change"));
  }

  const twoDecks = JSON.stringify([
    { id: "plus", name: "Stream Deck +", type: 7 },
    { id: "neo", name: "Stream Deck Neo", type: 9 },
  ]);

  it("shows every row and no note with no deck chosen — today's behaviour", () => {
    const card = mountCard();

    deliver?.(twoDecks);

    expect(state(card)).toEqual({ rows: ["Default", "Replay"], note: false });
  });

  it("hides a row whose template has no variant for the chosen deck", () => {
    const card = mountCard();

    deliver?.(twoDecks);
    pick(card, "plus");

    expect(state(card)).toEqual({ rows: ["Default"], note: false });
  });

  it("shows the note in place of the rows when the chosen deck has no variant of any template", () => {
    const card = mountCard();

    deliver?.(twoDecks);
    pick(card, "neo");

    expect(state(card)).toEqual({ rows: [], note: true });
  });

  it("never hides a child that carries no device types", () => {
    const card = mountCard();

    deliver?.(twoDecks);
    pick(card, "neo");

    expect(card.querySelector<HTMLElement>(".other")!.hidden).toBe(false);
  });

  it("follows the auto-selected single deck", () => {
    const card = mountCard();

    deliver?.(JSON.stringify([{ id: "xl", name: "Stream Deck XL", type: 2 }]));

    expect(state(card)).toEqual({ rows: ["Default", "Replay"], note: false });

    deliver?.(JSON.stringify([{ id: "plus", name: "Stream Deck +", type: 7 }]));

    expect(state(card)).toEqual({ rows: ["Default"], note: false });
  });

  it("returns to every row when the choice is cleared", () => {
    const card = mountCard();

    deliver?.(twoDecks);
    pick(card, "neo");
    pick(card, "");

    expect(state(card)).toEqual({ rows: ["Default", "Replay"], note: false });
  });

  it("shows every row for a deck published without a type, since nothing can be judged", () => {
    const card = mountCard();

    deliver?.(JSON.stringify([{ id: "x", name: "Unknown deck" }]));

    expect(card.querySelector("select")!.value).toBe("x");
    expect(state(card)).toEqual({ rows: ["Default", "Replay"], note: false });
  });

  it("reads a choice the picker already holds when it connects after the picker", () => {
    const picker = document.createElement("ird-deck-device-select");

    picker.setAttribute("select-id", "late");
    document.body.appendChild(picker);
    deliver?.(JSON.stringify([{ id: "neo", name: "Stream Deck Neo", type: 9 }]));

    const wrapper = document.createElement("div");

    wrapper.innerHTML =
      `<ird-profile-variants device-from="late">` +
      `<div class="row" data-device-types="0,2">Replay</div>` +
      `<div class="note" data-no-variants hidden>none</div>` +
      `</ird-profile-variants>`;
    document.body.appendChild(wrapper);

    expect(state(wrapper)).toEqual({ rows: [], note: true });
  });

  it("ignores another picker's announcements", () => {
    const card = mountCard("sw-deck");
    const other = document.createElement("ird-deck-device-select");

    other.setAttribute("select-id", "elsewhere");
    document.body.appendChild(other);
    // `deliver` now feeds the second picker, the last to subscribe.
    deliver?.(JSON.stringify([{ id: "neo", name: "Stream Deck Neo", type: 9 }]));

    expect(other.querySelector("select")!.value).toBe("neo");
    expect(state(card)).toEqual({ rows: ["Default", "Replay"], note: false });
  });
});

describe("parseDeviceTypes", () => {
  it("reads a comma list of device types", () => {
    expect(parseDeviceTypes("0,2, 7,13")).toEqual([0, 2, 7, 13]);
  });

  it("reads a missing or malformed list as no variants", () => {
    expect(parseDeviceTypes(null)).toEqual([]);
    expect(parseDeviceTypes("")).toEqual([]);
    expect(parseDeviceTypes("x,-1,2.5")).toEqual([]);
  });
});
