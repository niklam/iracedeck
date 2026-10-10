// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { installDigitsOnlyField, restrictToDigits } from "./digits-only-field.js";

/**
 * A stand-in for `sdpi-textfield`: an inner input in a shadow root, and a
 * `value` the component copies from that input on every keystroke, before any
 * listener on the element itself runs.
 */
function textfield(): { field: HTMLElement & { value?: unknown }; input: HTMLInputElement; saved: unknown[] } {
  const field = document.createElement("div") as HTMLElement & { value?: unknown };
  const input = document.createElement("input");
  const saved: unknown[] = [];
  let value: unknown = "";

  Object.defineProperty(field, "value", {
    get: () => value,
    set: (next: unknown) => {
      value = next;
      saved.push(next);
    },
  });
  field.attachShadow({ mode: "open" }).appendChild(input);
  input.addEventListener("input", () => {
    field.value = input.value;
  });

  return { field, input, saved };
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

describe("restrictToDigits (#1353)", () => {
  it("removes a rejected character from the field and from the value it stores", () => {
    const { field, input } = textfield();
    restrictToDigits(field);

    type(input, "07a");

    expect(input.value).toBe("07");
    expect(field.value).toBe("07");
  });

  it("keeps leading zeros", () => {
    const { field, input } = textfield();
    restrictToDigits(field);

    type(input, "007");

    expect(input.value).toBe("007");
    expect(field.value).toBe("007");
  });

  it("leaves a digits-only value alone", () => {
    const { field, input, saved } = textfield();
    restrictToDigits(field);

    type(input, "42");

    // Only the component's own copy: the filter wrote nothing.
    expect(saved).toEqual(["42"]);
  });

  it("empties the field when nothing typed is a digit", () => {
    const { field, input } = textfield();
    restrictToDigits(field);

    type(input, "abc");

    expect(input.value).toBe("");
    expect(field.value).toBe("");
  });

  it("filters an input that is a plain child of the field", () => {
    const field = document.createElement("div") as HTMLElement & { value?: unknown };
    const input = document.createElement("input");
    field.appendChild(input);
    restrictToDigits(field);

    type(input, "1x2");

    expect(input.value).toBe("12");
    expect(field.value).toBe("12");
  });

  it("does nothing for a field without an input", () => {
    const field = document.createElement("div") as HTMLElement & { value?: unknown };
    restrictToDigits(field);

    field.dispatchEvent(new Event("input"));

    expect(field.value).toBeUndefined();
  });
});

describe("installDigitsOnlyField (#1353)", () => {
  it("exposes the filter on the target window", () => {
    const target: { irdDigitsOnly?: (field: HTMLElement) => void } = {};

    installDigitsOnlyField(target);

    expect(target.irdDigitsOnly).toBe(restrictToDigits);
  });

  it("keeps an existing filter on a second install", () => {
    const existing = (): void => {};
    const target = { irdDigitsOnly: existing };

    installDigitsOnlyField(target);

    expect(target.irdDigitsOnly).toBe(existing);
  });
});
