// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import "./range-input.js";

describe("ird-range-input", () => {
  let range: HTMLElement;

  beforeEach(() => {
    // Mock SDPIComponents (not available in test environment)
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;

    range = document.createElement("ird-range-input");
    range.setAttribute("min", "1");
    range.setAttribute("max", "20");
    range.setAttribute("step", "1");

    // Clear document body using DOM API
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    document.body.appendChild(range);
  });

  describe("DOM structure", () => {
    it("should create container with range input and number input", () => {
      const container = range.querySelector("div");
      expect(container).not.toBeNull();

      const rangeInput = range.querySelector('input[type="range"]');
      expect(rangeInput).not.toBeNull();

      const numberInput = range.querySelector('input[type="number"]');
      expect(numberInput).not.toBeNull();
    });

    it("should propagate min/max/step to range input", () => {
      const rangeInput = range.querySelector('input[type="range"]') as HTMLInputElement;
      expect(rangeInput.min).toBe("1");
      expect(rangeInput.max).toBe("20");
      expect(rangeInput.step).toBe("1");
    });

    it("should propagate min/max/step to number input", () => {
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;
      expect(numberInput.min).toBe("1");
      expect(numberInput.max).toBe("20");
      expect(numberInput.step).toBe("1");
    });

    it("should not show labels when showlabels is absent", () => {
      const spans = range.querySelectorAll("span");
      expect(spans.length).toBe(0);
    });

    it("should show min/max labels when showlabels is present", () => {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }

      const labeled = document.createElement("ird-range-input");
      labeled.setAttribute("min", "5");
      labeled.setAttribute("max", "100");
      labeled.setAttribute("showlabels", "");
      document.body.appendChild(labeled);

      const spans = labeled.querySelectorAll("span");
      expect(spans.length).toBe(2);
      expect(spans[0].textContent).toBe("5");
      expect(spans[1].textContent).toBe("100");
    });

    it("should inject a shared style into document head", () => {
      const style = document.head.querySelector("style");
      expect(style).not.toBeNull();
      expect(style!.textContent).toContain('ird-range-input input[type="range"]');
    });
  });

  describe("value getter/setter", () => {
    it("should default to empty string", () => {
      expect((range as HTMLInputElement).value).toBe("");
    });

    it("should accept numeric string values", () => {
      (range as HTMLInputElement).value = "10";
      expect((range as HTMLInputElement).value).toBe("10");
    });

    it("should accept empty string for cleared state", () => {
      (range as HTMLInputElement).value = "10";
      (range as HTMLInputElement).value = "";
      expect((range as HTMLInputElement).value).toBe("");
    });
  });

  describe("display update", () => {
    it("should sync range input when value is set", () => {
      (range as HTMLInputElement).value = "15";
      const rangeInput = range.querySelector('input[type="range"]') as HTMLInputElement;
      expect(rangeInput.value).toBe("15");
    });

    it("should sync number input when value is set", () => {
      (range as HTMLInputElement).value = "15";
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;
      expect(numberInput.value).toBe("15");
    });

    it("should show fallback in number input when value is empty", () => {
      (range as HTMLInputElement).value = "15";
      (range as HTMLInputElement).value = "";
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;
      // Falls back to min attribute ("1") since no default attribute is set
      expect(numberInput.value).toBe("1");
    });
  });

  describe("bidirectional sync", () => {
    it("should update number input when range slider fires input event", () => {
      const rangeInput = range.querySelector('input[type="range"]') as HTMLInputElement;
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;

      rangeInput.value = "12";
      rangeInput.dispatchEvent(new Event("input"));

      expect(numberInput.value).toBe("12");
      expect((range as HTMLInputElement).value).toBe("12");
    });

    it("should update range slider when number input fires input event", () => {
      const rangeInput = range.querySelector('input[type="range"]') as HTMLInputElement;
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;

      numberInput.value = "8";
      numberInput.dispatchEvent(new Event("input"));

      expect(rangeInput.value).toBe("8");
      expect((range as HTMLInputElement).value).toBe("8");
    });

    it("should not sync when number input is empty (user clearing to retype)", () => {
      const rangeInput = range.querySelector('input[type="range"]') as HTMLInputElement;
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;

      // Set initial value
      (range as HTMLInputElement).value = "10";

      // Simulate user clearing the field to type a new number
      numberInput.value = "";
      numberInput.dispatchEvent(new Event("input"));

      // Should not change the component value or range slider
      expect((range as HTMLInputElement).value).toBe("10");
      expect(rangeInput.value).toBe("10");
    });

    it("should write clamped value back to number input on input event", () => {
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;

      numberInput.value = "25";
      numberInput.dispatchEvent(new Event("input"));

      // Clamped to max (20), written back to number input
      expect(numberInput.value).toBe("20");
      expect((range as HTMLInputElement).value).toBe("20");
    });
  });

  describe("value clamping", () => {
    it("should clamp number input below min on blur", () => {
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;

      numberInput.value = "-5";
      numberInput.dispatchEvent(new Event("blur"));

      expect((range as HTMLInputElement).value).toBe("1");
    });

    it("should clamp number input above max on blur", () => {
      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;

      // Set initial value first so the clamp triggers a change
      (range as HTMLInputElement).value = "10";

      numberInput.value = "50";
      numberInput.dispatchEvent(new Event("blur"));

      expect((range as HTMLInputElement).value).toBe("20");
    });
  });

  describe("events", () => {
    it("should dispatch change event when range slider is dragged", () => {
      const handler = vi.fn();
      range.addEventListener("change", handler);

      const rangeInput = range.querySelector('input[type="range"]') as HTMLInputElement;
      rangeInput.value = "10";
      rangeInput.dispatchEvent(new Event("input"));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should dispatch change event on number input commit", () => {
      const handler = vi.fn();
      range.addEventListener("change", handler);

      (range as HTMLInputElement).value = "5";

      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;
      numberInput.value = "15";
      numberInput.dispatchEvent(new Event("blur"));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should commit number input on Enter key", () => {
      (range as HTMLInputElement).value = "5";

      const numberInput = range.querySelector('input[type="number"]') as HTMLInputElement;
      numberInput.value = "12";
      numberInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

      expect((range as HTMLInputElement).value).toBe("12");
    });
  });

  describe("save", () => {
    it("should call saveToStreamDeck with current value", () => {
      const saveFn = vi.fn();
      (range as unknown as Record<string, unknown>).saveToStreamDeck = saveFn;

      (range as HTMLInputElement).value = "15";
      (range as unknown as { save(): void }).save();

      expect(saveFn).toHaveBeenCalledWith("15");
    });

    it("should call saveToStreamDeck with empty string when cleared", () => {
      const saveFn = vi.fn();
      (range as unknown as Record<string, unknown>).saveToStreamDeck = saveFn;

      (range as HTMLInputElement).value = "";
      (range as unknown as { save(): void }).save();

      expect(saveFn).toHaveBeenCalledWith("");
    });

    it("should be a no-op when saveToStreamDeck is null", () => {
      (range as HTMLInputElement).value = "10";
      // saveToStreamDeck is null by default (no SDPIComponents in test)
      expect(() => (range as unknown as { save(): void }).save()).not.toThrow();
    });
  });

  describe("default attribute", () => {
    it("should use default attribute for display when value is empty", () => {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }

      const withDefault = document.createElement("ird-range-input");
      withDefault.setAttribute("min", "1");
      withDefault.setAttribute("max", "100");
      withDefault.setAttribute("default", "50");
      document.body.appendChild(withDefault);

      // Range slider and number input should both show the default
      const rangeInput = withDefault.querySelector('input[type="range"]') as HTMLInputElement;
      expect(rangeInput.value).toBe("50");

      const numberInput = withDefault.querySelector('input[type="number"]') as HTMLInputElement;
      expect(numberInput.value).toBe("50");

      // But the component value is still empty (not persisted until user interacts)
      expect((withDefault as HTMLInputElement).value).toBe("");
    });
  });

  describe("settings hook value coercion", () => {
    /**
     * Test stub for window.SDPIComponents that exposes the value listener so
     * tests can simulate the host delivering different value types (number,
     * string, null, undefined, "") to the persistence callback.
     */
    function installSDPIStub(): { emit: (value: unknown) => void } {
      let listener: ((value: string) => void) | null = null;
      const makeHook = (_key: string, callback: (value: string) => void) => {
        listener = callback;

        return [() => Promise.resolve(""), () => undefined];
      };

      (window as unknown as Record<string, unknown>).SDPIComponents = {
        useSettings: makeHook,
        useGlobalSettings: makeHook,
      };

      return {
        emit: (value) => {
          // The runtime can deliver non-string types even though the type
          // annotation in key-binding-utils.ts says (value: string).
          listener?.(value as string);
        },
      };
    }

    function createWithSetting(defaultAttr = "100"): {
      el: HTMLElement;
      rangeInput: HTMLInputElement;
      numberInput: HTMLInputElement;
    } {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }

      const el = document.createElement("ird-range-input");
      el.setAttribute("min", "0");
      el.setAttribute("max", "100");
      el.setAttribute("default", defaultAttr);
      el.setAttribute("setting", "radarVolume");
      document.body.appendChild(el);

      return {
        el,
        rangeInput: el.querySelector('input[type="range"]') as HTMLInputElement,
        numberInput: el.querySelector('input[type="number"]') as HTMLInputElement,
      };
    }

    it("displays 0 when callback fires with the number 0 (not the default)", () => {
      const stub = installSDPIStub();
      const { el, rangeInput, numberInput } = createWithSetting("100");

      stub.emit(0);

      expect((el as HTMLInputElement).value).toBe("0");
      expect(rangeInput.value).toBe("0");
      expect(numberInput.value).toBe("0");
    });

    it('displays 0 when callback fires with the string "0"', () => {
      const stub = installSDPIStub();
      const { el, rangeInput, numberInput } = createWithSetting("100");

      stub.emit("0");

      expect((el as HTMLInputElement).value).toBe("0");
      expect(rangeInput.value).toBe("0");
      expect(numberInput.value).toBe("0");
    });

    it("falls back to default attribute when callback fires with empty string", () => {
      const stub = installSDPIStub();
      const { el, rangeInput, numberInput } = createWithSetting("75");

      stub.emit("");

      expect((el as HTMLInputElement).value).toBe("");
      expect(rangeInput.value).toBe("75");
      expect(numberInput.value).toBe("75");
    });

    it("falls back to default attribute when callback fires with null", () => {
      const stub = installSDPIStub();
      const { el, rangeInput, numberInput } = createWithSetting("75");

      stub.emit(null);

      expect((el as HTMLInputElement).value).toBe("");
      expect(rangeInput.value).toBe("75");
      expect(numberInput.value).toBe("75");
    });

    it("falls back to default attribute when callback fires with undefined", () => {
      const stub = installSDPIStub();
      const { el, rangeInput, numberInput } = createWithSetting("75");

      stub.emit(undefined);

      expect((el as HTMLInputElement).value).toBe("");
      expect(rangeInput.value).toBe("75");
      expect(numberInput.value).toBe("75");
    });

    it("displays the value after host echoes back a real 0 (regression: radar volume snap-to-100)", () => {
      const stub = installSDPIStub();
      const { el, rangeInput, numberInput } = createWithSetting("100");

      // Simulate a sequence: user has 5, presses Down, host echoes 0
      stub.emit(5);
      expect((el as HTMLInputElement).value).toBe("5");

      stub.emit(0);
      expect((el as HTMLInputElement).value).toBe("0");
      expect(rangeInput.value).toBe("0");
      expect(numberInput.value).toBe("0");
    });
  });
});
