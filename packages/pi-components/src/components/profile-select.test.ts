// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./profile-select.js";
import { parseProfileNames } from "./profile-select.js";

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

  it("renders a placeholder option plus one per profile name", () => {
    const el = mount();
    emit("_deviceProfiles", JSON.stringify(["iRaceDeck Default", "iRaceDeck Replay"]));

    const opts = Array.from(el.querySelector("select")!.options).map((o) => o.value);
    expect(opts).toEqual(["", "iRaceDeck Default", "iRaceDeck Replay"]);
  });

  it("selects the saved profile once the options arrive", () => {
    const el = mount();
    emit("profile", "iRaceDeck Replay");
    emit("_deviceProfiles", JSON.stringify(["iRaceDeck Default", "iRaceDeck Replay"]));

    expect(el.querySelector("select")!.value).toBe("iRaceDeck Replay");
  });

  it("saves the selected profile on change", () => {
    const el = mount();
    emit("_deviceProfiles", JSON.stringify(["iRaceDeck Default", "iRaceDeck Replay"]));

    const select = el.querySelector("select")!;
    select.value = "iRaceDeck Default";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(saves["profile"]).toHaveBeenCalledWith("iRaceDeck Default");
  });

  it("falls back to the empty option when the saved profile is not in the list", () => {
    const el = mount();
    emit("profile", "iRaceDeck Pit Actions");
    emit("_deviceProfiles", JSON.stringify(["iRaceDeck Default"]));

    expect(el.querySelector("select")!.value).toBe("");
  });

  describe("default attribute (#755)", () => {
    it("displays the default profile while the setting is empty, without persisting it", () => {
      const el = mount({ default: "iRaceDeck Default" });
      emit("profile", "");
      emit("_deviceProfiles", JSON.stringify(["iRaceDeck Default", "iRaceDeck Replay"]));

      expect(el.querySelector("select")!.value).toBe("iRaceDeck Default");
      expect(saves["profile"]).not.toHaveBeenCalled();
    });

    it("keeps an explicit saved selection over the default", () => {
      const el = mount({ default: "iRaceDeck Default" });
      emit("profile", "iRaceDeck Replay");
      emit("_deviceProfiles", JSON.stringify(["iRaceDeck Default", "iRaceDeck Replay"]));

      expect(el.querySelector("select")!.value).toBe("iRaceDeck Replay");
    });

    it("shows the placeholder when the default is not available for this device", () => {
      const el = mount({ default: "iRaceDeck Default" });
      emit("profile", "");
      emit("_deviceProfiles", JSON.stringify(["iRaceDeck Mini Only"]));

      expect(el.querySelector("select")!.value).toBe("");
    });
  });

  describe("parseProfileNames", () => {
    it("parses JSON strings, accepts arrays, and rejects junk", () => {
      expect(parseProfileNames('["a","b"]')).toEqual(["a", "b"]);
      expect(parseProfileNames(["a", "", 3, "b"])).toEqual(["a", "b"]);
      expect(parseProfileNames("")).toEqual([]);
      expect(parseProfileNames("not json")).toEqual([]);
      expect(parseProfileNames(null)).toEqual([]);
      expect(parseProfileNames(42)).toEqual([]);
    });
  });
});
