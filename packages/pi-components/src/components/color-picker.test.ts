// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import { historySettingKey, inferSlotType, parseColorHistory } from "./color-picker.js";
import "./color-picker.js";

/** Test stub for window.SDPIComponents that tracks saves and lets tests emit values to all registered listeners for a key. */
function installSDPIStub(initialByKey: Record<string, string> = {}): {
  saves: Record<string, string[]>;
  emit: (key: string, value: string) => void;
} {
  const saves: Record<string, string[]> = {};
  const listeners: Record<string, Array<(value: string) => void>> = {};

  const makeHook = (key: string, callback: (value: string) => void) => {
    (listeners[key] ??= []).push(callback);
    callback(initialByKey[key] ?? "");

    return [
      () => Promise.resolve(initialByKey[key] ?? ""),
      (value: string) => {
        (saves[key] ??= []).push(value);
      },
    ];
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = {
    useSettings: makeHook,
    useGlobalSettings: makeHook,
  };

  return {
    saves,
    emit: (key, value) => {
      for (const listener of listeners[key] ?? []) listener(value);
    },
  };
}

function clearBody(): void {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

function createPicker(setting?: string): HTMLElement {
  const el = document.createElement("ird-color-picker");

  if (setting) el.setAttribute("setting", setting);

  document.body.appendChild(el);

  return el;
}

function smallSwatches(picker: HTMLElement): HTMLDivElement[] {
  return Array.from(picker.querySelectorAll<HTMLDivElement>("[data-swatch-index]"));
}

describe("ird-color-picker", () => {
  let picker: HTMLElement;

  beforeEach(() => {
    // Mock SDPIComponents (not available in test environment)
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;

    picker = document.createElement("ird-color-picker");

    // Clear document body using DOM API
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    document.body.appendChild(picker);
  });

  describe("DOM structure", () => {
    it("should create container with swatch, hex input, and small swatch group", () => {
      const container = picker.querySelector("div");
      expect(container).not.toBeNull();

      const inputs = picker.querySelectorAll("input");
      expect(inputs.length).toBe(2); // hidden color + text

      const colorInput = picker.querySelector('input[type="color"]');
      expect(colorInput).not.toBeNull();

      const textInput = picker.querySelector('input[type="text"]');
      expect(textInput).not.toBeNull();
      expect(textInput!.getAttribute("placeholder")).toBe("Not set");

      // Clear button was replaced with a "Not set" swatch — no <button> element
      expect(picker.querySelector("button")).toBeNull();

      const swatches = picker.querySelectorAll("[data-swatch-index]");
      expect(swatches.length).toBe(8); // not-set + icon default + black + white + 4 recents
    });
  });

  describe("value getter/setter", () => {
    it("should default to empty string (not set)", () => {
      expect((picker as HTMLInputElement).value).toBe("");
    });

    it("should accept hex color values", () => {
      (picker as HTMLInputElement).value = "#ff0000";
      expect((picker as HTMLInputElement).value).toBe("#ff0000");
    });

    it("should accept empty string for not set", () => {
      (picker as HTMLInputElement).value = "#ff0000";
      (picker as HTMLInputElement).value = "";
      expect((picker as HTMLInputElement).value).toBe("");
    });

    it("should normalize legacy #000001 sentinel to empty string", () => {
      (picker as HTMLInputElement).value = "#000001";
      expect((picker as HTMLInputElement).value).toBe("");
    });
  });

  describe("display update", () => {
    it("should show not-set indicator when value is empty", () => {
      (picker as HTMLInputElement).value = "";
      const swatch = picker.querySelector("div > div") as HTMLDivElement;
      expect(swatch.style.backgroundImage).toContain("data:image/svg+xml");
    });

    it("should show color in swatch when value is set", () => {
      (picker as HTMLInputElement).value = "#ff0000";
      const swatch = picker.querySelector("div > div") as HTMLDivElement;
      expect(swatch.style.backgroundColor).toBe("rgb(255, 0, 0)");
    });

    it("should show hex in text input when value is set", () => {
      (picker as HTMLInputElement).value = "#00aaff";
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      expect(textInput.value).toBe("#00aaff");
    });

    it("should clear text input when not set", () => {
      (picker as HTMLInputElement).value = "#ff0000";
      (picker as HTMLInputElement).value = "";
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      expect(textInput.value).toBe("");
    });
  });

  describe("not-set swatch", () => {
    function notSetSwatch(p: HTMLElement): HTMLDivElement {
      return p.querySelector<HTMLDivElement>('[data-swatch-index="0"]')!;
    }

    it("should clear the value when clicked", () => {
      clearBody();
      const p = createPicker("colorOverrides.backgroundColor");
      (p as HTMLInputElement).value = "#ff0000";
      notSetSwatch(p).click();
      expect((p as HTMLInputElement).value).toBe("");
    });

    it("should dispatch change event when clicked", () => {
      clearBody();
      const p = createPicker("colorOverrides.backgroundColor");
      (p as HTMLInputElement).value = "#ff0000";
      const handler = vi.fn();
      p.addEventListener("change", handler);
      notSetSwatch(p).click();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should show the red-diagonal indicator background", () => {
      clearBody();
      const p = createPicker("colorOverrides.backgroundColor");
      const sw = notSetSwatch(p);
      expect(sw.style.backgroundImage).toContain("data:image/svg+xml");
      expect(sw.title).toBe("Not set");
    });
  });

  describe("hex input", () => {
    it("should accept valid 6-digit hex on blur", () => {
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      textInput.value = "#aabbcc";
      textInput.dispatchEvent(new Event("blur"));
      expect((picker as HTMLInputElement).value).toBe("#aabbcc");
    });

    it("should accept valid 3-digit hex and expand", () => {
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      textInput.value = "#abc";
      textInput.dispatchEvent(new Event("blur"));
      expect((picker as HTMLInputElement).value).toBe("#aabbcc");
    });

    it("should accept hex without # prefix", () => {
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      textInput.value = "ff0000";
      textInput.dispatchEvent(new Event("blur"));
      expect((picker as HTMLInputElement).value).toBe("#ff0000");
    });

    it("should be case-insensitive", () => {
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      textInput.value = "#AABBCC";
      textInput.dispatchEvent(new Event("blur"));
      expect((picker as HTMLInputElement).value).toBe("#aabbcc");
    });

    it("should revert display on invalid hex", () => {
      (picker as HTMLInputElement).value = "#ff0000";
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      textInput.value = "not-a-color";
      textInput.dispatchEvent(new Event("blur"));
      // Value should not change
      expect((picker as HTMLInputElement).value).toBe("#ff0000");
      // Display should revert
      expect(textInput.value).toBe("#ff0000");
    });

    it("should clear value when hex input is emptied", () => {
      (picker as HTMLInputElement).value = "#ff0000";
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      textInput.value = "";
      textInput.dispatchEvent(new Event("blur"));
      expect((picker as HTMLInputElement).value).toBe("");
    });

    it("should commit on Enter key", () => {
      const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
      textInput.value = "#00ff00";
      textInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect((picker as HTMLInputElement).value).toBe("#00ff00");
    });
  });

  describe("save", () => {
    it("should call saveToStreamDeck with current value", () => {
      const saveFn = vi.fn();
      (picker as unknown as Record<string, unknown>).saveToStreamDeck = saveFn;

      (picker as HTMLInputElement).value = "#ff0000";
      (picker as unknown as { save(): void }).save();

      expect(saveFn).toHaveBeenCalledWith("#ff0000");
    });

    it("should call saveToStreamDeck with empty string when cleared", () => {
      const saveFn = vi.fn();
      (picker as unknown as Record<string, unknown>).saveToStreamDeck = saveFn;

      (picker as HTMLInputElement).value = "";
      (picker as unknown as { save(): void }).save();

      expect(saveFn).toHaveBeenCalledWith("");
    });

    it("should be a no-op when saveToStreamDeck is null", () => {
      (picker as HTMLInputElement).value = "#ff0000";
      // saveToStreamDeck is null by default (no SDPIComponents in test)
      expect(() => (picker as unknown as { save(): void }).save()).not.toThrow();
    });
  });
});

describe("inferSlotType", () => {
  it("infers from dotted per-action setting", () => {
    expect(inferSlotType("colorOverrides.backgroundColor")).toBe("backgroundColor");
    expect(inferSlotType("colorOverrides.textColor")).toBe("textColor");
    expect(inferSlotType("colorOverrides.graphic1Color")).toBe("graphic1Color");
    expect(inferSlotType("colorOverrides.graphic2Color")).toBe("graphic2Color");
  });

  it("infers from flat global color* setting", () => {
    expect(inferSlotType("colorBackgroundColor")).toBe("backgroundColor");
    expect(inferSlotType("colorTextColor")).toBe("textColor");
    expect(inferSlotType("colorGraphic1Color")).toBe("graphic1Color");
    expect(inferSlotType("colorGraphic2Color")).toBe("graphic2Color");
  });

  it("infers borderColor from dotted and flat forms", () => {
    expect(inferSlotType("borderOverrides.borderColor")).toBe("borderColor");
    expect(inferSlotType("borderColor")).toBe("borderColor");
  });

  it("infers the dial dash-box color slots (issue #811)", () => {
    expect(inferSlotType("dial.colors.borderColor")).toBe("borderColor");
    expect(inferSlotType("dial.colors.backgroundColor")).toBe("backgroundColor");
    expect(inferSlotType("dial.colors.labelColor")).toBe("labelColor");
    expect(inferSlotType("dial.colors.valueColor")).toBe("valueColor");
  });

  it("returns null for unknown or empty settings", () => {
    expect(inferSlotType(null)).toBeNull();
    expect(inferSlotType("")).toBeNull();
    expect(inferSlotType("somethingElse")).toBeNull();
    expect(inferSlotType("colorOverrides.unknownSlot")).toBeNull();
  });
});

describe("historySettingKey", () => {
  it("uses the underscore-prefixed flat key per slot", () => {
    expect(historySettingKey("backgroundColor")).toBe("_colorHistoryBackgroundColor");
    expect(historySettingKey("textColor")).toBe("_colorHistoryTextColor");
    expect(historySettingKey("graphic1Color")).toBe("_colorHistoryGraphic1Color");
    expect(historySettingKey("graphic2Color")).toBe("_colorHistoryGraphic2Color");
    expect(historySettingKey("borderColor")).toBe("_colorHistoryBorderColor");
  });
});

describe("parseColorHistory", () => {
  it("returns empty array for empty/null/invalid input", () => {
    expect(parseColorHistory("")).toEqual([]);
    expect(parseColorHistory(null)).toEqual([]);
    expect(parseColorHistory("not-json")).toEqual([]);
    expect(parseColorHistory('{"foo": 1}')).toEqual([]);
  });

  it("filters non-normalized entries", () => {
    expect(parseColorHistory('["#ff0000","ff0000","#xyz","#ff0000ff",42]')).toEqual(["#ff0000"]);
  });

  it("truncates to 6 entries", () => {
    const seven = ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777"];
    expect(parseColorHistory(JSON.stringify(seven))).toHaveLength(6);
  });
});

describe("ird-color-picker — preset and recent swatches", () => {
  beforeEach(() => {
    clearBody();
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  it("hides the small swatch group when no slot type can be inferred", () => {
    const picker = createPicker(); // no setting attribute → no slot type
    const swatches = smallSwatches(picker);
    expect(swatches).toHaveLength(8);

    for (const sw of swatches) expect(sw.style.display).toBe("none");
  });

  it("renders Not-Set, Black, and White when slot type is recognized, with no icon default", () => {
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);
    // Slot 0: Not set — always visible
    expect(swatches[0].style.display).not.toBe("none");
    expect(swatches[0].style.backgroundImage).toContain("data:image/svg+xml");
    expect(swatches[0].title).toBe("Not set");
    // Slot 1 (icon default) hidden when no `default` attr
    expect(swatches[1].style.display).toBe("none");
    // Black at index 2
    expect(swatches[2].style.display).not.toBe("none");
    expect(swatches[2].style.backgroundColor).toBe("rgb(0, 0, 0)");
    expect(swatches[2].title).toBe("Use Black");
    // White at index 3
    expect(swatches[3].style.display).not.toBe("none");
    expect(swatches[3].style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(swatches[3].title).toBe("Use White");

    // Recents 4..7 hidden when no history
    for (let i = 4; i < 8; i++) expect(swatches[i].style.display).toBe("none");
  });

  it("clicking the Black preset sets the picker value to #000000", () => {
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);
    swatches[2].click();
    expect((picker as HTMLInputElement).value).toBe("#000000");
  });

  it("clicking the White preset sets the picker value to #ffffff", () => {
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);
    swatches[3].click();
    expect((picker as HTMLInputElement).value).toBe("#ffffff");
  });

  it("renders the icon default preset from the `default` attribute at slot 1", () => {
    const picker = document.createElement("ird-color-picker");
    picker.setAttribute("setting", "colorOverrides.backgroundColor");
    picker.setAttribute("default", "#3a4a5a");
    document.body.appendChild(picker);
    const swatches = smallSwatches(picker);
    expect(swatches[1].style.display).not.toBe("none");
    expect(swatches[1].style.backgroundColor).toBe("rgb(58, 74, 90)");
    expect(swatches[1].title).toBe("Use icon default (#3a4a5a)");
  });

  it("renders the icon default preset from the `data-default-color` attribute (border picker)", () => {
    const picker = document.createElement("ird-color-picker");
    picker.setAttribute("setting", "borderOverrides.borderColor");
    picker.setAttribute("data-default-color", "#00aaff");
    document.body.appendChild(picker);
    const swatches = smallSwatches(picker);
    expect(swatches[1].style.display).not.toBe("none");
    expect(swatches[1].style.backgroundColor).toBe("rgb(0, 170, 255)");
  });

  it("hides the icon default preset when the default equals Black or White (no duplicate)", () => {
    const picker = document.createElement("ird-color-picker");
    picker.setAttribute("setting", "colorOverrides.backgroundColor");
    picker.setAttribute("default", "#000000");
    document.body.appendChild(picker);
    const swatches = smallSwatches(picker);
    expect(swatches[1].style.display).toBe("none");
  });

  it("clicking the icon default preset sets the picker value", () => {
    const picker = document.createElement("ird-color-picker");
    picker.setAttribute("setting", "colorOverrides.backgroundColor");
    picker.setAttribute("default", "#3a4a5a");
    document.body.appendChild(picker);
    const swatches = smallSwatches(picker);
    swatches[1].click();
    expect((picker as HTMLInputElement).value).toBe("#3a4a5a");
  });
});

describe("ird-color-picker — history persistence", () => {
  beforeEach(() => {
    clearBody();
  });

  it("renders recent colors from the global history setting", () => {
    installSDPIStub({
      _colorHistoryBackgroundColor: '["#ff0000","#00ff00","#0000ff"]',
    });
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);

    expect(swatches[4].style.display).not.toBe("none");
    expect(swatches[4].style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(swatches[4].title).toBe("Use #ff0000");

    expect(swatches[5].style.backgroundColor).toBe("rgb(0, 255, 0)");
    expect(swatches[6].style.backgroundColor).toBe("rgb(0, 0, 255)");

    expect(swatches[7].style.display).toBe("none");
  });

  it("clicking a recent swatch sets the value and bumps it to the front of history", () => {
    const { saves } = installSDPIStub({
      _colorHistoryBackgroundColor: '["#aaaaaa","#bbbbbb","#cccccc"]',
    });
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);
    // Recent slot index 2 → swatch index 6 (#cccccc)
    swatches[6].click();
    expect((picker as HTMLInputElement).value).toBe("#cccccc");
    const history = saves._colorHistoryBackgroundColor!;
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0])).toEqual(["#cccccc", "#aaaaaa", "#bbbbbb"]);
  });

  it("commits a hex input to history", () => {
    const { saves } = installSDPIStub();
    const picker = createPicker("colorOverrides.backgroundColor");
    const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
    textInput.value = "#aabbcc";
    textInput.dispatchEvent(new Event("blur"));
    const history = saves._colorHistoryBackgroundColor!;
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0])).toEqual(["#aabbcc"]);
  });

  it("does not write Black or White to history", () => {
    const { saves } = installSDPIStub();
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);
    swatches[2].click(); // Black
    swatches[3].click(); // White
    expect(saves._colorHistoryBackgroundColor).toBeUndefined();
    expect((picker as HTMLInputElement).value).toBe("#ffffff");
  });

  it("does not write the icon default to history", () => {
    const { saves } = installSDPIStub();
    const picker = document.createElement("ird-color-picker");
    picker.setAttribute("setting", "colorOverrides.backgroundColor");
    picker.setAttribute("default", "#3a4a5a");
    document.body.appendChild(picker);
    const swatches = smallSwatches(picker);
    swatches[1].click();
    expect(saves._colorHistoryBackgroundColor).toBeUndefined();
    expect((picker as HTMLInputElement).value).toBe("#3a4a5a");
  });

  it("also skips history when the icon default is committed via the hex input", () => {
    const { saves } = installSDPIStub();
    const picker = document.createElement("ird-color-picker");
    picker.setAttribute("setting", "colorOverrides.backgroundColor");
    picker.setAttribute("default", "#3a4a5a");
    document.body.appendChild(picker);
    const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
    textInput.value = "#3a4a5a";
    textInput.dispatchEvent(new Event("blur"));
    expect(saves._colorHistoryBackgroundColor).toBeUndefined();
  });

  it("dedupes and bumps an existing color to position 0", () => {
    const { saves } = installSDPIStub({
      _colorHistoryBackgroundColor: '["#111111","#222222","#333333"]',
    });
    const picker = createPicker("colorOverrides.backgroundColor");
    const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
    textInput.value = "#222222";
    textInput.dispatchEvent(new Event("blur"));
    const history = saves._colorHistoryBackgroundColor!;
    expect(JSON.parse(history[history.length - 1])).toEqual(["#222222", "#111111", "#333333"]);
  });

  it("truncates to 6 stored colors when more are committed", () => {
    const { saves } = installSDPIStub();
    const picker = createPicker("colorOverrides.backgroundColor");
    const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
    const colors = ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777"];

    for (const c of colors) {
      textInput.value = c;
      textInput.dispatchEvent(new Event("blur"));
    }

    const history = saves._colorHistoryBackgroundColor!;
    const last = JSON.parse(history[history.length - 1]);
    expect(last).toHaveLength(6);
    expect(last[0]).toBe("#777777");
    expect(last).not.toContain("#111111");
  });

  it("clicking the Not-Set swatch clears the picker but does not touch history", () => {
    const { saves } = installSDPIStub({
      _colorHistoryBackgroundColor: '["#aaaaaa","#bbbbbb"]',
    });
    const picker = createPicker("colorOverrides.backgroundColor");
    // Commit a non-preset color through the hex input
    const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
    textInput.value = "#abcdef";
    textInput.dispatchEvent(new Event("blur"));
    const beforeClear = (saves._colorHistoryBackgroundColor ?? []).length;
    expect(beforeClear).toBe(1);
    const notSetSw = smallSwatches(picker)[0];
    notSetSw.click();
    expect((picker as HTMLInputElement).value).toBe("");
    const afterClear = (saves._colorHistoryBackgroundColor ?? []).length;
    expect(afterClear).toBe(beforeClear);
  });

  it("re-renders swatches when an external history change arrives via the subscription", () => {
    const { emit } = installSDPIStub({
      _colorHistoryBackgroundColor: "[]",
    });
    const picker = createPicker("colorOverrides.backgroundColor");
    expect(smallSwatches(picker)[4].style.display).toBe("none");
    emit("_colorHistoryBackgroundColor", '["#deadbe","#cafeba"]');
    const after = smallSwatches(picker);
    expect(after[4].style.display).not.toBe("none");
    expect(after[4].style.backgroundColor).toBe("rgb(222, 173, 190)");
    expect(after[5].style.backgroundColor).toBe("rgb(202, 254, 186)");
  });

  it("two pickers for the same slot stay in sync when one emits new history", () => {
    const { emit } = installSDPIStub({
      _colorHistoryBackgroundColor: "[]",
    });
    const a = createPicker("colorOverrides.backgroundColor");
    const b = createPicker("colorBackgroundColor"); // global flat form, same slot
    expect(smallSwatches(a)[4].style.display).toBe("none");
    expect(smallSwatches(b)[4].style.display).toBe("none");
    emit("_colorHistoryBackgroundColor", '["#111111","#222222"]');
    // Both pickers (per-action and global, same slot) update independently
    expect(smallSwatches(a)[4].style.backgroundColor).toBe("rgb(17, 17, 17)");
    expect(smallSwatches(a)[5].style.backgroundColor).toBe("rgb(34, 34, 34)");
    expect(smallSwatches(b)[4].style.backgroundColor).toBe("rgb(17, 17, 17)");
    expect(smallSwatches(b)[5].style.backgroundColor).toBe("rgb(34, 34, 34)");
  });

  it("commits to history when the native color picker dispatches change", () => {
    const { saves } = installSDPIStub();
    const picker = createPicker("colorOverrides.backgroundColor");
    const nativeInput = picker.querySelector('input[type="color"]') as HTMLInputElement;
    nativeInput.value = "#abcdef";
    nativeInput.dispatchEvent(new Event("change"));
    expect((picker as HTMLInputElement).value).toBe("#abcdef");
    const history = saves._colorHistoryBackgroundColor!;
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0])).toEqual(["#abcdef"]);
  });

  it("renders 4 recent swatches and hides the 5th when 5 colors are stored", () => {
    installSDPIStub({
      _colorHistoryBackgroundColor: '["#111111","#222222","#333333","#444444","#555555"]',
    });
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);

    // Slots 4..7 are the 4 visible recent slots
    for (let i = 4; i < 8; i++) expect(swatches[i].style.display).not.toBe("none");

    // There is no swatch index 8 — HISTORY_VISIBLE caps visible recents at 4
    expect(swatches).toHaveLength(8);
    // Visible colors are the 4 most-recent stored entries
    expect(swatches[4].style.backgroundColor).toBe("rgb(17, 17, 17)");
    expect(swatches[5].style.backgroundColor).toBe("rgb(34, 34, 34)");
    expect(swatches[6].style.backgroundColor).toBe("rgb(51, 51, 51)");
    expect(swatches[7].style.backgroundColor).toBe("rgb(68, 68, 68)");
  });

  it("does not save when clicking a swatch whose color is already the current value", () => {
    const { saves } = installSDPIStub();
    const picker = createPicker("colorOverrides.backgroundColor");
    const swatches = smallSwatches(picker);
    // First click on Black sets currentValue = #000000
    swatches[2].click();
    // Black is excluded from history so nothing was saved, but currentValue is set
    expect((picker as HTMLInputElement).value).toBe("#000000");
    expect(saves._colorHistoryBackgroundColor).toBeUndefined();
    // Second click on the same Black swatch should be a no-op (hex === currentValue)
    // and therefore not even invoke the StreamDeck save handler (would be caught by the guard).
    const mainSavesBefore = (saves["colorOverrides.backgroundColor"] ?? []).length;
    swatches[2].click();
    const mainSavesAfter = (saves["colorOverrides.backgroundColor"] ?? []).length;
    expect(mainSavesAfter).toBe(mainSavesBefore);
  });

  it("does not save when clicking Not-Set on an already-empty picker", () => {
    const { saves } = installSDPIStub();
    const picker = createPicker("colorOverrides.backgroundColor");
    const notSet = smallSwatches(picker)[0];
    notSet.click();
    expect(saves._colorHistoryBackgroundColor).toBeUndefined();
    // Value remained empty, no main-setting save either
    expect((picker as HTMLInputElement).value).toBe("");
  });

  it("does not re-save when the subscription echoes back the just-saved value", () => {
    const { saves, emit } = installSDPIStub();
    const picker = createPicker("colorOverrides.backgroundColor");
    const textInput = picker.querySelector('input[type="text"]') as HTMLInputElement;
    textInput.value = "#abcdef";
    textInput.dispatchEvent(new Event("blur"));
    const savedJson = saves._colorHistoryBackgroundColor!.at(-1)!;
    // Echo back the same value via the subscription
    emit("_colorHistoryBackgroundColor", savedJson);
    // No additional save triggered
    expect(saves._colorHistoryBackgroundColor!).toHaveLength(1);
  });
});
