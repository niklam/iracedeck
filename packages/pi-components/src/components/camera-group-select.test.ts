// @vitest-environment jsdom
import { CAMERA_CATALOG_KEY, type CameraCatalogView } from "@iracedeck/app-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Importing the module also registers the custom element.
import { OTHER_OPTION_LABEL } from "./camera-group-select.js";
import { PICKER_HEADINGS } from "./camera-groups-view.js";

type SettingsCallback = (value: unknown) => void;

interface MockSDPI {
  perKey: Map<string, SettingsCallback>;
  global: Map<string, SettingsCallback>;
  saves: Map<string, ReturnType<typeof vi.fn>>;
  globalReads: number;
  /**
   * The values sdpi already holds, which a hook's getter returns. A key not
   * here models sdpi before its first delivery: the getter never resolves.
   */
  stored: Map<string, unknown>;
}

function installMockSDPI(): MockSDPI {
  const state: MockSDPI = { perKey: new Map(), global: new Map(), saves: new Map(), globalReads: 0, stored: new Map() };

  const hook =
    (into: Map<string, SettingsCallback>) =>
    (key: string, callback: SettingsCallback): [() => Promise<unknown>, unknown] => {
      into.set(key, callback);

      const save = vi.fn();
      state.saves.set(key, save);

      return [
        () => {
          state.globalReads++;

          return state.stored.has(key) ? Promise.resolve(state.stored.get(key)) : new Promise(() => {});
        },
        save,
      ];
    };

  (window as unknown as Record<string, unknown>).SDPIComponents = {
    useSettings: hook(state.perKey),
    useGlobalSettings: hook(state.global),
  };

  return state;
}

const CATALOG: CameraCatalogView = {
  version: 1,
  tracks: [
    { id: 1, name: "Spa", config: "" },
    { id: 2, name: "Monza", config: "" },
  ],
  groups: [
    { name: "Drone", tracks: [0], lastSeen: "2026-11-08T12:00:00.000Z" },
    { name: "DynamicTV", tracks: [1], lastSeen: "2026-11-08T12:00:00.000Z" },
  ],
  current: { trackId: 2, groups: ["TV1", "DynamicTV", "Nose"] },
};

describe("ird-camera-group-select", () => {
  let el: HTMLElement;
  let mock: MockSDPI;

  beforeEach(() => {
    document.body.replaceChildren();
    mock = installMockSDPI();
    el = document.createElement("ird-camera-group-select");
    document.body.appendChild(el);
  });

  const select = (): HTMLSelectElement => el.querySelector("select") as HTMLSelectElement;
  const field = (): HTMLElement & { value?: unknown } => el.querySelector("sdpi-textfield") as HTMLElement;
  const fieldShown = (): boolean => !(el.querySelector(".ird-cgs-other") as HTMLElement).hidden;
  const pushName = (v: unknown): void => mock.perKey.get("cameraGroupName")?.(v);
  const pushNumber = (v: unknown): void => mock.perKey.get("cameraGroup")?.(v);
  const pushCatalog = (v: unknown): void =>
    mock.global.get(CAMERA_CATALOG_KEY)?.(typeof v === "string" ? v : JSON.stringify(v));
  const saveName = (): ReturnType<typeof vi.fn> => mock.saves.get("cameraGroupName")!;
  const saveNumber = (): ReturnType<typeof vi.fn> => mock.saves.get("cameraGroup")!;
  const groupLabels = (): string[] => Array.from(select().querySelectorAll("optgroup")).map((g) => g.label);
  const selectedText = (): string => select().selectedOptions[0]?.textContent ?? "";

  function choose(predicate: (option: HTMLOptionElement) => boolean): void {
    const option = Array.from(select().options).find(predicate);

    if (!option) throw new Error("no such option");

    option.selected = true;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  }

  const chooseName = (name: string): void => choose((o) => o.value === name && o.dataset.other === undefined);
  const chooseOther = (): void => choose((o) => o.dataset.other !== undefined);

  function type(value: string): void {
    field().value = value;
    field().dispatchEvent(new Event("valuechange"));
  }

  it("binds the two per-key settings and the catalog global", () => {
    expect([...mock.perKey.keys()]).toEqual(["cameraGroupName", "cameraGroup"]);
    expect([...mock.global.keys()]).toEqual([CAMERA_CATALOG_KEY]);
  });

  describe("the enclosing item's label (#1653 review)", () => {
    /** What the vendored sdpi-item does on a label click: focus the first element under it that can. */
    function clickLabel(item: HTMLElement): void {
      for (const element of item.querySelectorAll("*")) {
        const candidate = element as HTMLElement & { canFocus?: boolean };

        if (candidate.canFocus) {
          candidate.focus();

          return;
        }
      }
    }

    it.each([false, true])("focuses the select, with Other… open: %s", (otherOpen) => {
      const item = document.createElement("div");
      const picker = document.createElement("ird-camera-group-select");
      item.appendChild(picker);
      document.body.appendChild(item);
      // The Other… field is an sdpi-textfield, which can focus too.
      Object.defineProperty(picker.querySelector("sdpi-textfield"), "canFocus", { value: true });

      if (otherOpen) {
        mock.perKey.get("cameraGroupName")?.("");
        const pickerSelect = picker.querySelector("select") as HTMLSelectElement;
        const other = Array.from(pickerSelect.options).find((o) => o.dataset.other !== undefined) as HTMLOptionElement;
        other.selected = true;
        pickerSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }

      clickLabel(item);

      expect(document.activeElement).toBe(picker.querySelector("select"));
    });
  });

  describe("the select's accessible name (#1653 review)", () => {
    it("is the enclosing item's label", () => {
      const item = document.createElement("sdpi-item");
      item.setAttribute("label", "Camera Group");
      const picker = document.createElement("ird-camera-group-select");
      item.appendChild(picker);
      document.body.appendChild(item);

      expect(picker.querySelector("select")?.getAttribute("aria-label")).toBe("Camera Group");
    });

    it("falls back to a name of its own outside an item", () => {
      expect(select().getAttribute("aria-label")).toBe("Camera group");
    });
  });

  describe("on load and on pushes it writes nothing", () => {
    it("shows an old key's group from its number, without writing the name", () => {
      pushName(undefined);
      pushNumber(17);
      pushCatalog(CATALOG);

      expect(select().value).toBe("TV1");
      expect(saveName()).not.toHaveBeenCalled();
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("shows Cockpit for a key that stores nothing, and still writes nothing", () => {
      pushName("");
      pushNumber(undefined);

      expect(select().value).toBe("Cockpit");
      expect(saveName()).not.toHaveBeenCalled();
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("re-renders on every catalog push without writing", () => {
      pushName("Drone");
      pushCatalog(CATALOG);
      expect(selectedText()).toBe("Drone (not on this track: Spa)");

      pushCatalog({ ...CATALOG, current: null });
      expect(selectedText()).toBe("Drone (on Spa)");

      pushCatalog("not json");
      expect(selectedText()).toBe("Drone (not seen yet)");

      expect(select().value).toBe("Drone");
      expect(saveName()).not.toHaveBeenCalled();
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("reads nothing in response to the user: settings arrive through the hooks", () => {
      const readsAtLoad = mock.globalReads;

      pushCatalog(CATALOG);
      chooseName("Drone");
      chooseOther();
      type("Foo");

      expect(mock.globalReads).toBe(readsAtLoad);
    });

    it("shows the catalog sdpi already held when it connected (#1653 review)", async () => {
      // The push that brought it came before this element subscribed, and sdpi
      // does not replay one; only the hook's getter still has it.
      mock.stored.set(CAMERA_CATALOG_KEY, JSON.stringify(CATALOG));
      const late = document.createElement("ird-camera-group-select");
      document.body.appendChild(late);
      await Promise.resolve();
      await Promise.resolve();

      const lateSelect = late.querySelector("select") as HTMLSelectElement;
      const headings = Array.from(lateSelect.querySelectorAll("optgroup")).map((g) => g.label);

      expect(headings).toContain(PICKER_HEADINGS.onTrackCustom);
      expect(headings).toContain(PICKER_HEADINGS.remembered);
      expect(saveName()).not.toHaveBeenCalled();
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("shows the key's group sdpi already held when it connected, writing nothing (#1653 review)", async () => {
      mock.stored.set("cameraGroupName", "");
      mock.stored.set("cameraGroup", "17");
      const late = document.createElement("ird-camera-group-select");
      document.body.appendChild(late);
      await Promise.resolve();
      await Promise.resolve();

      expect((late.querySelector("select") as HTMLSelectElement).value).toBe("TV1");
      expect(saveName()).not.toHaveBeenCalled();
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("never lets the held value overwrite a push that came first", async () => {
      mock.stored.set("cameraGroupName", "Old");
      const late = document.createElement("ird-camera-group-select");
      document.body.appendChild(late);
      mock.perKey.get("cameraGroupName")?.("Drone");
      await Promise.resolve();
      await Promise.resolve();

      expect((late.querySelector("select") as HTMLSelectElement).value).toBe("Drone");
    });

    describe("Other… chosen before the key's held number is read (#1653 review)", () => {
      let release: (value: unknown) => void = () => {};

      beforeEach(() => {
        mock.stored.set("cameraGroup", new Promise((resolve) => (release = resolve)));
        document.body.replaceChildren();
        el = document.createElement("ird-camera-group-select");
        document.body.appendChild(el);
        chooseOther();
      });

      const settle = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      };

      it("restores the key's number, not the default, after a typed prefix wrote one first", async () => {
        type("Chase"); // writes 12 before the key's 17 is known
        release(17);
        await settle();
        expect(saveNumber().mock.calls).toEqual([["12"]]);

        type("Chase Cam");

        expect(saveNumber()).toHaveBeenLastCalledWith("17");
      });

      it("takes the read as the key's number and baseline when typing has written none", async () => {
        release(17);
        await settle();
        type("Chase");
        type("Chase Cam");

        expect(saveNumber().mock.calls).toEqual([["12"], ["17"]]);
      });

      describe("a custom name ending Other… before the read resolves", () => {
        it("puts the key's number back once it is read, after a typed custom name", async () => {
          type("Chase"); // writes 12
          type("Chase Cam"); // the number to put back is not known yet
          expect(saveNumber().mock.calls).toEqual([["12"]]);

          release(17);
          await settle();

          expect(saveNumber().mock.calls).toEqual([["12"], ["17"]]);
        });

        it("puts the key's number back once it is read, after a listed custom group", async () => {
          pushCatalog(CATALOG);
          type("Chase");
          chooseName("DynamicTV");
          expect(saveNumber().mock.calls).toEqual([["12"]]);

          release(17);
          await settle();

          expect(saveName()).toHaveBeenLastCalledWith("DynamicTV");
          expect(saveNumber().mock.calls).toEqual([["12"], ["17"]]);
        });

        it("puts the default back only when the read reports no number", async () => {
          type("Chase");
          type("Chase Cam");

          release(undefined);
          await settle();

          expect(saveNumber().mock.calls).toEqual([["12"], ["9"]]);
        });

        it("puts nothing back after a standard choice", async () => {
          type("Chase");
          type("Chase Cam");
          type("Nose");
          const calls = saveNumber().mock.calls.length;

          release(17);
          await settle();

          expect(saveNumber().mock.calls).toHaveLength(calls);
        });

        it("puts nothing back after a newer push", async () => {
          type("Chase");
          type("Chase Cam");
          pushNumber(5);

          release(17);
          await settle();

          expect(saveNumber().mock.calls).toEqual([["12"]]);
        });
      });

      it("takes a listed standard choice made before the read as the baseline (#1653 review)", async () => {
        chooseName("TV1"); // leaves Other… and writes 17
        chooseOther();
        type("Chase"); // writes 12
        type("Chase Cam");

        expect(saveNumber().mock.calls).toEqual([["17"], ["12"], ["17"]]);

        release(9);
        await settle();

        expect(saveNumber().mock.calls).toEqual([["17"], ["12"], ["17"]]);
      });

      it("takes a listed standard choice as the baseline even when typing already wrote it", async () => {
        type("Chase"); // writes Chase and 12
        chooseName("Chase"); // the same group from the list: nothing new to write
        chooseOther();
        type("TV2"); // writes 18
        type("TV2 Low");

        expect(saveNumber().mock.calls).toEqual([["12"], ["18"], ["12"]]);

        release(17);
        await settle();

        expect(saveNumber().mock.calls).toEqual([["12"], ["18"], ["12"]]);
      });
    });
  });

  describe("the option groups", () => {
    it("with no session: the four standard sections, then Other…", () => {
      pushName("");
      pushNumber(9);

      expect(groupLabels()).toEqual(["Car", "Chase", "Track", "Aerial"]);
      expect(select().options[select().options.length - 1].textContent).toBe(OTHER_OPTION_LABEL);
    });

    it("with a session: this track, the standard sections, remembered, the stored name, then Other…", () => {
      pushName("Ghost");
      pushCatalog(CATALOG);

      expect(groupLabels()).toEqual([
        PICKER_HEADINGS.onTrackCustom,
        "Car",
        "Chase",
        "Track",
        "Aerial",
        PICKER_HEADINGS.remembered,
        PICKER_HEADINGS.stored,
      ]);
      expect(select().options[select().options.length - 1].textContent).toBe(OTHER_OPTION_LABEL);
    });

    it("labels remembered groups with their tracks and standard ones not on this track", () => {
      pushName("");
      pushNumber(9);
      pushCatalog(CATALOG);

      const texts = Array.from(select().options).map((o) => o.textContent);

      expect(texts).toContain("Drone (not on this track: Spa)");
      expect(texts).toContain("Cockpit (not on this track)");
      expect(selectedText()).toBe("Cockpit (not on this track)");
    });

    it("shows and keeps a stored name the catalog does not have", () => {
      pushName("Ghost");
      pushCatalog(CATALOG);

      expect(select().value).toBe("Ghost");
      expect(selectedText()).toBe("Ghost (not on this track)");
      expect(saveName()).not.toHaveBeenCalled();
    });
  });

  describe("the user's choice", () => {
    beforeEach(() => {
      pushName("");
      pushNumber(9);
      pushCatalog(CATALOG);
    });

    it("writes both the name and the number for a standard group", () => {
      chooseName("TV1");

      expect(saveName()).toHaveBeenCalledWith("TV1");
      expect(saveNumber()).toHaveBeenCalledWith("17");
    });

    it("writes only the name for a custom group, leaving the number as it was", () => {
      chooseName("DynamicTV");

      expect(saveName()).toHaveBeenCalledWith("DynamicTV");
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("keeps showing its own write, which the host does not echo back", () => {
      chooseName("Drone");
      pushCatalog({ ...CATALOG, groups: [...CATALOG.groups, { name: "New", tracks: [], lastSeen: "" }] });

      expect(select().value).toBe("Drone");
    });

    it("Other… reveals the text field and writes nothing by itself", () => {
      expect(fieldShown()).toBe(false);

      chooseOther();

      expect(fieldShown()).toBe(true);
      expect(saveName()).not.toHaveBeenCalled();
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("Other… writes the typed name, trimmed", () => {
      chooseOther();
      type("  My Chicane ");

      expect(saveName()).toHaveBeenLastCalledWith("My Chicane");
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("Other… writes a standard name typed in any case as the standard name and its number", () => {
      chooseOther();
      type("tv2");

      expect(saveName()).toHaveBeenLastCalledWith("TV2");
      expect(saveNumber()).toHaveBeenLastCalledWith("18");
    });

    it("Other… puts the number back when a standard prefix gives way to a custom name (#1653 review)", () => {
      chooseOther();
      type("Chase");
      type("Chase Cam");

      expect(saveName()).toHaveBeenLastCalledWith("Chase Cam");
      // `Chase` wrote 12 on the way; the custom name restores the key's own 9.
      expect(saveNumber()).toHaveBeenNthCalledWith(1, "12");
      expect(saveNumber()).toHaveBeenLastCalledWith("9");
    });

    it("Other… restores the default number for a key that never stored one", () => {
      pushNumber(undefined);
      chooseOther();
      type("TV1");
      type("TV1_Low");

      expect(saveNumber()).toHaveBeenLastCalledWith("9");
    });

    it("Other… leaves the number alone when no standard prefix was typed", () => {
      chooseOther();
      type("Drone");
      type("Drone 2");

      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("Other… keeps a number pushed while it is open when a custom name is typed (#1653 review)", () => {
      chooseOther();
      pushNumber(17);
      type("Drone");

      expect(saveName()).toHaveBeenLastCalledWith("Drone");
      expect(saveNumber()).not.toHaveBeenCalled();
    });

    it("Other… does not undo a typed prefix's number once a push has replaced it", () => {
      chooseOther();
      type("Chase");
      pushNumber(17);
      type("Chase Cam");

      expect(saveNumber()).toHaveBeenCalledTimes(1);
      expect(saveNumber()).toHaveBeenLastCalledWith("12");
    });

    it("Other… puts back the pushed number, not the one it opened at, after a typed prefix", () => {
      chooseOther();
      pushNumber(17);
      type("Chase");
      type("Chase Cam");

      expect(saveNumber()).toHaveBeenNthCalledWith(1, "12");
      expect(saveNumber()).toHaveBeenLastCalledWith("17");
    });

    it("Other… writes nothing for a blank entry", () => {
      chooseOther();
      type("   ");

      expect(saveName()).not.toHaveBeenCalled();
    });

    it("Other… stays open across a catalog push while the user types", () => {
      chooseOther();
      type("Dro");
      pushCatalog({ ...CATALOG, current: null });

      expect(fieldShown()).toBe(true);
      expect(select().selectedOptions[0].dataset.other).toBeDefined();
    });

    it("choosing a listed group after Other… closes the field", () => {
      chooseOther();
      chooseName("Nose");

      expect(fieldShown()).toBe(false);
      expect(saveName()).toHaveBeenLastCalledWith("Nose");
    });

    it("puts the number back when a typed prefix gives way to a listed custom group (#1653 review)", () => {
      chooseOther();
      type("Chase");
      chooseName("DynamicTV");

      expect(saveName()).toHaveBeenLastCalledWith("DynamicTV");
      // `Chase` wrote 12 on the way; the custom choice restores the key's own 9.
      expect(saveNumber()).toHaveBeenNthCalledWith(1, "12");
      expect(saveNumber()).toHaveBeenLastCalledWith("9");
    });

    it("keeps the new number when a typed prefix gives way to a listed standard group", () => {
      chooseOther();
      type("Chase");
      chooseName("TV1");

      expect(saveName()).toHaveBeenLastCalledWith("TV1");
      expect(saveNumber()).toHaveBeenLastCalledWith("17");
    });

    it("offers, shows and writes groups named like Object.prototype members", () => {
      pushCatalog({
        ...CATALOG,
        groups: [...CATALOG.groups, { name: "toString", tracks: [0], lastSeen: "" }],
        current: { trackId: 2, groups: ["TV1", "constructor", "__proto__"] },
      });

      const values = Array.from(select().options).map((o) => o.value);

      expect(values).toEqual(expect.arrayContaining(["constructor", "__proto__", "toString"]));

      chooseName("__proto__");
      expect(saveName()).toHaveBeenLastCalledWith("__proto__");
      expect(select().value).toBe("__proto__");

      pushName("constructor");
      expect(select().value).toBe("constructor");
      expect(selectedText()).toBe("constructor");
    });

    it("Other… writes no name the plugin would not record", () => {
      chooseOther();
      type("x".repeat(257));
      type(`Tab${String.fromCharCode(9)}here`);

      expect(saveName()).not.toHaveBeenCalled();
    });

    it("a typed name shows as the stored entry once the PI reopens", () => {
      chooseOther();
      type("My Chicane");

      const reopened = document.createElement("ird-camera-group-select");

      document.body.appendChild(reopened);
      mock.perKey.get("cameraGroupName")?.("My Chicane");
      mock.global.get(CAMERA_CATALOG_KEY)?.(JSON.stringify(CATALOG));

      const reopenedSelect = reopened.querySelector("select") as HTMLSelectElement;

      expect(reopenedSelect.value).toBe("My Chicane");
      expect(reopenedSelect.selectedOptions[0].textContent).toBe("My Chicane (not on this track)");
    });
  });
});
