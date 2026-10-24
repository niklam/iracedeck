// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { shouldShowAutoSwitchNote } from "./auto-switch-note.js";

const KINDS = ["Test", "Practice", "Qualifying", "Race", "Replay"];

describe("shouldShowAutoSwitchNote", () => {
  it("shows only while the toggle is off and some row names a profile", () => {
    expect(shouldShowAutoSwitchNote(false, ["", "iRaceDeck Practice"])).toBe(true);
    expect(shouldShowAutoSwitchNote(undefined, ["iRaceDeck Race"])).toBe(true);
    expect(shouldShowAutoSwitchNote("false", ["iRaceDeck Race"])).toBe(true);
    expect(shouldShowAutoSwitchNote(false, ["", "", ""])).toBe(false);
    expect(shouldShowAutoSwitchNote(false, [undefined, null])).toBe(false);
    expect(shouldShowAutoSwitchNote(true, ["iRaceDeck Race"])).toBe(false);
    expect(shouldShowAutoSwitchNote("true", ["iRaceDeck Race"])).toBe(false);
  });
});

describe("ird-auto-switch-note", () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  /** The card as the partial renders it, with plain elements standing in for the sdpi controls. */
  function mountCard(): {
    note: HTMLElement;
    toggle: HTMLElement & { value?: unknown };
    rows: (HTMLElement & { value?: unknown })[];
  } {
    document.body.innerHTML =
      `<sdpi-checkbox setting="profileAutoSwitchEnabled"></sdpi-checkbox>` +
      `<ird-auto-switch-note hidden>note</ird-auto-switch-note>` +
      KINDS.map((k) => `<sdpi-select setting="profileForSessionKind${k}"></sdpi-select>`).join("");

    return {
      note: document.querySelector("ird-auto-switch-note")!,
      toggle: document.querySelector("sdpi-checkbox")!,
      rows: Array.from(document.querySelectorAll("sdpi-select")),
    };
  }

  /** What sdpi does when a control's value changes: set it, then dispatch `valuechange` on the control. */
  function setValue(control: HTMLElement & { value?: unknown }, value: unknown): void {
    control.value = value;
    control.dispatchEvent(new Event("valuechange"));
  }

  it("follows the controls: appears when a row is picked while off, and goes when the toggle is ticked or the row cleared", () => {
    const { note, toggle, rows } = mountCard();

    expect(note.hidden).toBe(true);

    setValue(rows[4]!, "iRaceDeck Replay");
    expect(note.hidden).toBe(false);

    setValue(toggle, true);
    expect(note.hidden).toBe(true);

    setValue(toggle, false);
    expect(note.hidden).toBe(false);

    setValue(rows[4]!, "");
    expect(note.hidden).toBe(true);
  });

  it("stays hidden with every row at Do not change the profile, whatever the toggle", () => {
    const { note, toggle, rows } = mountCard();

    for (const row of rows) setValue(row, "");

    setValue(toggle, false);

    expect(note.hidden).toBe(true);
  });
});
