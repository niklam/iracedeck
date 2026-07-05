// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./profile-select.js";
import { parseProfileEntries } from "./profile-select.js";

type Cb = (value: unknown) => void;

describe("ird-profile-select", () => {
  let listeners: Record<string, Cb[]>;
  let saves: Record<string, ReturnType<typeof vi.fn>>;

  function emit(key: string, value: unknown): void {
    for (const cb of listeners[key] ?? []) cb(value);
  }

  beforeEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    listeners = {};
    saves = {};

    const useSettings = (key: string, cb: Cb) => {
      (listeners[key] ??= []).push(cb);
      const save = (saves[key] ??= vi.fn());

      return [undefined, save];
    };

    (window as unknown as Record<string, unknown>).SDPIComponents = { useSettings };
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function mount(attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement("ird-profile-select");

    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }

    document.body.appendChild(el);

    return el;
  }

  /** The device-filtered entries the actions push since #753. */
  const ENTRIES = JSON.stringify([
    { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
    { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
  ]);

  it("renders a placeholder option plus one per profile entry, labeled without the device suffix (#753)", () => {
    const el = mount();
    emit("_deviceProfiles", ENTRIES);

    const opts = Array.from(el.querySelector("select")!.options);
    expect(opts.map((o) => o.value)).toEqual(["", "iRaceDeck Default XL", "iRaceDeck Replay XL"]);
    expect(opts.map((o) => o.textContent)).toEqual(["Select a profile…", "iRaceDeck Default", "iRaceDeck Replay"]);
  });

  it("still renders a legacy plain string array (pre-#753 persisted shape)", () => {
    const el = mount();
    emit("_deviceProfiles", JSON.stringify(["iRaceDeck Default", "iRaceDeck Replay"]));

    const opts = Array.from(el.querySelector("select")!.options);
    expect(opts.map((o) => o.value)).toEqual(["", "iRaceDeck Default", "iRaceDeck Replay"]);
    expect(opts.map((o) => o.textContent)).toEqual(["Select a profile…", "iRaceDeck Default", "iRaceDeck Replay"]);
  });

  it("selects the saved profile once the options arrive", () => {
    const el = mount();
    emit("profile", "iRaceDeck Replay XL");
    emit("_deviceProfiles", ENTRIES);

    expect(el.querySelector("select")!.value).toBe("iRaceDeck Replay XL");
  });

  it("displays a legacy saved display name via its option's label, without persisting (#753)", () => {
    const el = mount();
    emit("profile", "iRaceDeck Replay");
    emit("_deviceProfiles", ENTRIES);

    expect(el.querySelector("select")!.value).toBe("iRaceDeck Replay XL");
    expect(saves["profile"]).not.toHaveBeenCalled();
  });

  it("saves the selected profile's manifest name on change", () => {
    const el = mount();
    emit("_deviceProfiles", ENTRIES);

    const select = el.querySelector("select")!;
    select.value = "iRaceDeck Default XL";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(saves["profile"]).toHaveBeenCalledWith("iRaceDeck Default XL");
  });

  it("falls back to the empty option when the saved profile matches no option by name or label", () => {
    const el = mount();
    emit("profile", "iRaceDeck Pit Actions");
    emit("_deviceProfiles", ENTRIES);

    expect(el.querySelector("select")!.value).toBe("");
  });

  describe("default attribute (#755)", () => {
    it("renders no placeholder option — with a default, every choice does something", () => {
      const el = mount({ default: "iRaceDeck Default", "previous-label": "Back to previous" });
      emit("_deviceProfiles", ENTRIES);

      const opts = Array.from(el.querySelector("select")!.options).map((o) => o.value);
      expect(opts).toEqual(["__previous", "iRaceDeck Default XL", "iRaceDeck Replay XL"]);
    });

    it("displays the default profile (a display name matched by label) while the setting is empty, without persisting it", () => {
      const el = mount({ default: "iRaceDeck Default" });
      emit("profile", "");
      emit("_deviceProfiles", ENTRIES);

      expect(el.querySelector("select")!.value).toBe("iRaceDeck Default XL");
      expect(saves["profile"]).not.toHaveBeenCalled();
    });

    it("keeps an explicit saved selection over the default", () => {
      const el = mount({ default: "iRaceDeck Default" });
      emit("profile", "iRaceDeck Replay XL");
      emit("_deviceProfiles", ENTRIES);

      expect(el.querySelector("select")!.value).toBe("iRaceDeck Replay XL");
    });

    it("displays the default when the saved profile is not available for this device", () => {
      const el = mount({ default: "iRaceDeck Default" });
      emit("profile", "iRaceDeck Pit Actions");
      emit("_deviceProfiles", ENTRIES);

      expect(el.querySelector("select")!.value).toBe("iRaceDeck Default XL");
    });

    it("shows no selection when the default itself is not available for this device", () => {
      const el = mount({ default: "iRaceDeck Default" });
      emit("profile", "");
      emit("_deviceProfiles", JSON.stringify([{ name: "iRaceDeck Pit Actions Mini", label: "iRaceDeck Pit Actions" }]));

      expect(el.querySelector("select")!.value).toBe("");
    });
  });

  describe("parseProfileEntries", () => {
    it("parses entry objects, labeling by displayName", () => {
      expect(parseProfileEntries('[{"name":"a XL","label":"a"}]')).toEqual([{ name: "a XL", label: "a" }]);
      expect(parseProfileEntries([{ name: "a XL", label: "a" }])).toEqual([{ name: "a XL", label: "a" }]);
    });

    it("normalizes legacy plain strings to name-as-label entries", () => {
      expect(parseProfileEntries('["a","b"]')).toEqual([
        { name: "a", label: "a" },
        { name: "b", label: "b" },
      ]);
      expect(parseProfileEntries(["a", "", 3, "b"])).toEqual([
        { name: "a", label: "a" },
        { name: "b", label: "b" },
      ]);
    });

    it("rejects junk", () => {
      expect(parseProfileEntries("")).toEqual([]);
      expect(parseProfileEntries("not json")).toEqual([]);
      expect(parseProfileEntries(null)).toEqual([]);
      expect(parseProfileEntries(42)).toEqual([]);
      expect(parseProfileEntries([{ label: "no name" }])).toEqual([]);
    });
  });
});
