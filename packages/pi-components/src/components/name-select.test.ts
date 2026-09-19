// @vitest-environment jsdom
import { stripTakeSuffix, TAKE_SUFFIX } from "@iracedeck/callout-script";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import { NAME_TAKE_SUFFIX } from "./name-select.js";

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
  saves: Map<string, ReturnType<typeof vi.fn>>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = { callbacks: new Map(), saves: new Map() };

  const useGlobalSettings = (key: string, callback: SettingsCallback): [() => Promise<string>, unknown] => {
    state.callbacks.set(key, callback);

    const save = vi.fn();
    state.saves.set(key, save);

    return [async () => "", save];
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };

  return state;
}

describe("ird-name-select", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    el = document.createElement("ird-name-select");
    // What the settings window's Race Engineer card sets (`race-engineer-settings.ejs`).
    el.setAttribute("default", "driver");
    document.body.appendChild(el);
  });

  const publishNames = (names: string[]): void => void mock.callbacks.get("_driverNames")?.(JSON.stringify(names));
  const publishChoice = (value: string): void => void mock.callbacks.get("driverName")?.(value);
  const save = (): ReturnType<typeof vi.fn> => mock.saves.get("driverName")!;
  const selected = (): string => (el.querySelector("select") as HTMLSelectElement).value;
  const options = (): { value: string; text: string }[] =>
    Array.from((el.querySelector("select") as HTMLSelectElement).options).map((o) => ({
      value: o.value,
      text: o.textContent ?? "",
    }));

  it("renders one capitalised option per listed name, keeping the key as the value", () => {
    publishNames(["driver", "niklas"]);

    expect(options()).toEqual([
      { value: "driver", text: "Driver" },
      { value: "niklas", text: "Niklas" },
    ]);
  });

  it("selects the saved name when it is in the list", () => {
    publishChoice("niklas");
    publishNames(["driver", "niklas"]);

    expect(selected()).toBe("niklas");
    expect(save()).not.toHaveBeenCalled();
  });

  it("seeds the default on a fresh install, where there is no choice to lose", () => {
    publishChoice("");
    publishNames(["adam", "driver", "niklas"]);

    expect(selected()).toBe("driver");
    expect(save()).toHaveBeenCalledWith("driver");
  });

  it("shows the default for a name that left the list, but does NOT overwrite it (#1034)", () => {
    publishChoice("oivindl");
    publishNames(["driver", "niklas"]);

    expect(selected()).toBe("driver");
    expect(save()).not.toHaveBeenCalled();
  });

  describe("a stored name take (#1173)", () => {
    // Before #1173 the list carried a voice pack's name takes (`adam-01`) as
    // names of their own, so a user may have picked one. The list now offers
    // only bases, and the plugin plays such a choice under its base — so the
    // dropdown shows the base, and writes nothing.

    it("shows the base for a take-suffixed stored value, and persists nothing", () => {
      publishChoice("adam-01");
      publishNames(["adam", "driver", "niklas"]);

      expect(selected()).toBe("adam");
      expect(save()).not.toHaveBeenCalled();
    });

    it("keeps showing the base when the list is republished", () => {
      // Every scan (a Rescan press, a pack install) publishes the list again.
      publishChoice("adam-01");
      publishNames(["adam", "driver", "niklas"]);
      publishNames(["adam", "driver", "niklas", "zoe"]);

      expect(selected()).toBe("adam");
      expect(save()).not.toHaveBeenCalled();
    });

    it("still saves a different name the user then picks", () => {
      publishChoice("adam-01");
      publishNames(["adam", "driver", "niklas"]);

      const select = el.querySelector("select") as HTMLSelectElement;
      select.value = "niklas";
      select.dispatchEvent(new Event("change"));

      expect(save()).toHaveBeenCalledExactlyOnceWith("niklas");
    });

    it("prefers an exact match over the base", () => {
      publishChoice("adam-01");
      publishNames(["adam", "adam-01", "driver"]);

      expect(selected()).toBe("adam-01");
      expect(save()).not.toHaveBeenCalled();
    });

    it("falls back without persisting when neither the take nor its base is listed", () => {
      publishChoice("adam-01");
      publishNames(["driver", "niklas"]);

      expect(selected()).toBe("driver");
      expect(save()).not.toHaveBeenCalled();
    });

    it.each([
      ["r2d2", ["driver", "r2d"]],
      ["abc-1", ["abc", "driver"]],
      ["abc-123", ["abc", "abc-1", "driver"]],
    ])("does not read %s as a take", (name, names) => {
      // Only the engine's two-digit take shape folds; a listed prefix of any
      // other name is a different name.
      publishChoice(name);
      publishNames(names);

      expect(selected()).toBe("driver");
      expect(save()).not.toHaveBeenCalled();
    });
  });
});

describe("NAME_TAKE_SUFFIX — the browser copy of the shared take rule (#1173)", () => {
  // The component cannot import `@iracedeck/callout-script` (see the constant's
  // comment), so it keeps a copy. A copy that drifted would show a stored
  // name under a different base from the one the plugin plays.

  it("is the same pattern as callout-script's TAKE_SUFFIX", () => {
    expect(NAME_TAKE_SUFFIX.source).toBe(TAKE_SUFFIX.source);
    expect(NAME_TAKE_SUFFIX.flags).toBe(TAKE_SUFFIX.flags);
  });

  it.each(["adam-01", "adam-99", "adam", "r2d2", "abc-1", "abc-123", "a-01-02", "-01"])(
    "folds %s exactly as stripTakeSuffix does",
    (name) => {
      expect(name.replace(NAME_TAKE_SUFFIX, "")).toBe(stripTakeSuffix(name));
    },
  );
});
