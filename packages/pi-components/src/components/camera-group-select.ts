/// <reference lib="dom" />
/**
 * Camera Group picker for Camera Controls' Change Camera mode (issue #1653).
 *
 * Replaces the `<sdpi-select setting="cameraGroup">` that bound one setting to
 * 25 static options. A choice now writes two per-key settings, the list changes
 * under an open PI as sessions come and go, and a name can be typed — none of
 * which an `sdpi-select` does.
 *
 * WHAT IT SHOWS. The options `buildCameraGroupPicker` orders (spec decision 7):
 * the session's groups under "On this track" (or "On this track (custom camera
 * file)"), the standard groups not on it, every other remembered group with
 * the tracks it was seen on, the key's stored name when none of those lists it,
 * and finally **Other…**, which reveals an `sdpi-textfield` for typing a name.
 * The stored choice is the per-key `cameraGroupName`; an empty one is read from
 * the `cameraGroup` number, which is every key saved before #1653.
 *
 * WHAT IT WRITES, AND WHEN. Only on the user's choice — never on load, never on
 * a push, never to settle a default. Choosing a group writes its name, and the
 * `cameraGroup` number too when the name is one of the 25 standard groups; a
 * custom name leaves the number as it was (decision 5). A typed name is written
 * as the user types (trimmed; a standard name in any case becomes the canonical
 * standard name and its number), through sdpi's own debounced save.
 *
 * WHAT IT READS, AND WHEN. The two per-key settings and the run-scoped
 * `_cameraCatalog` global, each through sdpi's settings hooks — so it re-renders
 * on every `didReceiveSettings` / `didReceiveGlobalSettings` push (through
 * `skipUnchanged`), takes the catalog sdpi already holds once from its hook's
 * getter on connect (a local read; sdpi replays no earlier push to a new
 * subscriber), and reads nothing in response to a DOM event: in sdpi a read
 * is not addressed to the requester, so one fired from a change handler replaces
 * the shared settings snapshot under every other control (the
 * `ird-enable-feature` lesson in `stream-deck-actions.md`). Stream Deck does not
 * echo a PI's own `setSettings` back, so the component keeps what it wrote.
 *
 * Usage:
 * ```html
 * <sdpi-item label="Camera Group">
 *   <ird-camera-group-select setting="cameraGroupName" number-setting="cameraGroup"
 *     catalog="_cameraCatalog" default="9"></ird-camera-group-select>
 * </sdpi-item>
 * ```
 *
 * Attributes (all optional, defaults shown above):
 * - setting: the per-key setting holding the group NAME.
 * - number-setting: the per-key setting holding the standard group NUMBER.
 * - catalog: the global holding the camera catalog view JSON.
 * - default: the number a key with neither stored reads as (the schema's default).
 */
import { CAMERA_CATALOG_KEY, type CameraCatalogView } from "@iracedeck/app-constants";

import {
  buildCameraGroupPicker,
  cameraGroupWrite,
  DEFAULT_CAMERA_GROUP_VALUE,
  effectiveCameraGroupName,
  parseCameraCatalog,
  resolveTypedCameraGroupName,
} from "./camera-groups-view.js";
import { skipUnchanged } from "./settings-change-filter.js";

let styleInjected = false;

const DEFAULT_NAME_SETTING = "cameraGroupName";
const DEFAULT_NUMBER_SETTING = "cameraGroup";

/** The Other… entry's label. Its option carries `data-other`, never a group name. */
export const OTHER_OPTION_LABEL = "Other…";

export class CameraGroupSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private otherWrap: HTMLDivElement | null = null;
  private otherField: HTMLElement | null = null;
  private _initialized = false;
  private storedName: unknown = "";
  private storedNumber: unknown = undefined;
  private catalog: CameraCatalogView | null = null;
  /**
   * The user chose Other…: the select stays on it and the text field stays open
   * until they pick another option, whatever pushes arrive meanwhile — a
   * catalog push must not snatch the field away mid-word.
   */
  private otherMode = false;
  /**
   * The `cameraGroup` number the key held when Other… was chosen, or the one a
   * settings push brought while it is open. A typed name is written as the user
   * types, so its prefix can be a standard name (`Chase` on the way to
   * `Chase Cam`) and write that group's number; once the text is a custom name
   * again this number is put back, so a custom name leaves the number at the
   * key's last value, as a choice from the list does (decision 5).
   */
  private numberBeforeOther: unknown = undefined;
  /**
   * Whether typing in the open Other… field wrote a number since
   * {@link numberBeforeOther} was taken. Only such a number is put back: one a
   * push brought is the key's state, not a typing artefact (#1653 review).
   */
  private numberWrittenWhileTyping = false;
  /**
   * Whether a push, the held read or a local write has set the `cameraGroup`
   * number, so the held read never overwrites a newer value.
   */
  private numberKnown = false;
  /**
   * Whether the key's number is established: reported by a push or the held
   * read, or chosen deliberately from the list. A typed prefix's write does not
   * count, since the number it replaced is still unknown.
   */
  private numberHeard = false;
  /**
   * Whether {@link numberBeforeOther} was taken before the key's number was
   * heard (#1653 review): Other… chosen before the held read resolved. The read
   * then supplies the baseline a custom name restores, even when typing has
   * already written a number and the read may no longer set the key's own.
   */
  private baselinePending = false;
  /**
   * A custom name ended Other… after a typed prefix wrote a number, while the
   * number to put back was not yet known (#1653 review): the held read puts it
   * back when it resolves — the default only when it reports none. A standard
   * choice or a newer push cancels it.
   */
  private restorePending = false;
  private saveName: ((value: string) => void) | null = null;
  private saveNumber: ((value: string) => void) | null = null;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.injectStyle();
    this.buildDOM();
    this.attachListeners();
    this.hookSettings();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    // The same flattened sdpi-select stack `ird-voice-select` uses, so the
    // dropdown looks identical to the native `sdpi-select` it replaces.
    const style = document.createElement("style");
    style.textContent = `
      ird-camera-group-select { display: block; }
      ird-camera-group-select select {
        box-sizing: border-box;
        outline: 0;
        border: none;
        border-radius: 0;
        min-width: 100%;
        max-width: 100%;
        color: #d8d8d8;
        font-size: 9pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif,
                     "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        height: 30px;
        background-color: #3d3d3d;
        padding: 6px 0;
        text-overflow: ellipsis;
        width: 100%;
      }
      ird-camera-group-select select:focus { box-shadow: inset 0 0 1px #969696; }
      ird-camera-group-select .ird-cgs-other { margin-top: 4px; }
      ird-camera-group-select .ird-cgs-other[hidden] { display: none; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.select = document.createElement("select");
    // The enclosing sdpi-item draws its label in its shadow root, which names
    // nothing for the native select: it takes the label itself (#1653 review).
    this.select.setAttribute("aria-label", this.closest("sdpi-item")?.getAttribute("label") || "Camera group");
    this.otherWrap = document.createElement("div");
    this.otherWrap.className = "ird-cgs-other";
    this.otherWrap.hidden = true;
    this.otherField = document.createElement("sdpi-textfield");
    this.otherField.setAttribute("placeholder", "Type a camera group name");
    this.otherWrap.appendChild(this.otherField);
    this.append(this.select, this.otherWrap);
    this.render();
  }

  private attachListeners(): void {
    this.select?.addEventListener("change", (ev: Event) => {
      if (!this.select) return;

      ev.stopPropagation();

      const option = this.select.selectedOptions[0];

      if (option?.dataset.other !== undefined) {
        if (!this.otherMode) {
          this.numberBeforeOther = this.storedNumber;
          this.numberWrittenWhileTyping = false;
          this.baselinePending = !this.numberHeard;
        }

        this.otherMode = true;
        this.showOther(true);

        return;
      }

      const leavingOther = this.otherMode;

      this.otherMode = false;
      this.showOther(false);

      // A listed standard group writes its own number: nothing to put back, and
      // the user's deliberate choice is the key's number from now on — the
      // baseline a later custom name restores, which a held read arriving
      // after it must not replace (#1653 review). A typed prefix stays
      // provisional.
      if (this.commit(this.select.value)) {
        this.restorePending = false;
        this.numberHeard = true;
      }

      // A listed custom group ends Other… like a typed custom name: a number a
      // standard prefix typed on the way wrote is put back (#1653 review). A
      // listed standard group keeps the number it just wrote.
      if (leavingOther) this.restoreNumberForCustomName(this.select.value);

      this.render();
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // sdpi-textfield announces every keystroke as `valuechange` on itself (its
    // inner input's own events stay in its shadow root).
    this.otherField?.addEventListener("valuechange", () => {
      const typed = (this.otherField as unknown as { value?: unknown }).value;
      const name = resolveTypedCameraGroupName(typeof typed === "string" ? typed : "", this.catalog);

      if (name === null) return;

      if (this.commit(name)) {
        this.numberWrittenWhileTyping = true;
        this.restorePending = false;
      }

      this.restoreNumberForCustomName(name);
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  private showOther(show: boolean): void {
    if (!this.otherWrap) return;

    this.otherWrap.hidden = !show;

    if (show) {
      (this.otherField as unknown as { value?: unknown }).value = "";
      this.otherField?.focus?.();
    }
  }

  /**
   * Write `name` (and its number when it is standard) and remember both locally.
   * Returns whether a number was written.
   */
  private commit(name: string): boolean {
    const write = cameraGroupWrite(name);

    if (write.name === this.storedName && (write.number === undefined || write.number === String(this.storedNumber))) {
      return false;
    }

    this.storedName = write.name;
    this.saveName?.(write.name);

    if (write.number === undefined) return false;

    this.storedNumber = write.number;
    this.saveNumber?.(write.number);

    return true;
  }

  /**
   * After a typed custom name, put back the number the key had before Other…
   * (or the last one pushed while it was open), should a standard-name prefix
   * typed on the way have replaced it. A number nobody typed is left alone.
   */
  private restoreNumberForCustomName(name: string): void {
    if (!this.numberWrittenWhileTyping || cameraGroupWrite(name).number !== undefined) return;

    this.numberWrittenWhileTyping = false;

    // The number to put back is not known yet: the held read puts it back.
    if (this.baselinePending) {
      this.restorePending = true;

      return;
    }

    this.writeNumberBack(this.numberBeforeOther);
  }

  /** Put `baseline` back as the key's number — the default for none. */
  private writeNumberBack(baseline: unknown): void {
    const before =
      baseline === undefined || baseline === null || baseline === "" ? String(this.fallbackNumber()) : String(baseline);

    if (String(this.storedNumber) === before) return;

    this.storedNumber = before;
    this.saveNumber?.(before);
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const nameKey = this.getAttribute("setting") ?? DEFAULT_NAME_SETTING;
    const numberKey = this.getAttribute("number-setting") ?? DEFAULT_NUMBER_SETTING;
    const catalogKey = this.getAttribute("catalog") ?? CAMERA_CATALOG_KEY;

    // Whether a push (or the user's own choice) has set each value, so the
    // getter read below — the value sdpi held before this element subscribed —
    // never overwrites a newer one.
    let nameKnown = false;

    const onName = skipUnchanged((value: unknown) => {
      nameKnown = true;
      this.storedName = value ?? "";
      this.render();
    });
    const [readName, saveName] = window.SDPIComponents.useSettings(nameKey, onName);

    this.saveName = (value: string) => {
      nameKnown = true;
      saveName(value);
    };

    const onNumber = skipUnchanged((value: unknown) => {
      this.numberKnown = true;
      this.numberHeard = true;
      this.storedNumber = value;
      // The key's number now: a restore still owed would undo it.
      this.restorePending = false;

      // A push while Other… is open is the key's number now: the one a custom
      // name typed next leaves in place, not a typed prefix's to undo.
      if (this.otherMode) {
        this.numberBeforeOther = value;
        this.numberWrittenWhileTyping = false;
        this.baselinePending = false;
      }

      this.render();
    });
    const [readNumber, saveNumber] = window.SDPIComponents.useSettings(numberKey, onNumber);

    this.saveNumber = (value: string) => {
      this.numberKnown = true;
      saveNumber(value);
    };

    // Per-key settings that arrived before this element subscribed are not
    // replayed either (#1653 review): read what sdpi holds, unless a push or a
    // local choice has already set the value.
    void readName().then((value) => {
      if (!nameKnown) onName(value);
    });
    void readNumber().then((value) => {
      const baselinePending = this.baselinePending;
      const restorePending = this.restorePending;

      this.baselinePending = false;
      this.restorePending = false;

      if (!this.numberKnown) {
        onNumber(value);

        return;
      }

      this.numberHeard = true;

      if (!baselinePending) return;

      // Typing wrote a number before the key's own was known: that write
      // stays, and the key's number becomes the one a custom name restores —
      // at once, when a custom name already ended Other… meanwhile.
      this.numberBeforeOther = value;

      if (restorePending) this.writeNumberBack(value);
    });

    const onCatalog = skipUnchanged((value: unknown) => {
      this.catalog = parseCameraCatalog(value);
      this.render();
    });
    const [readCatalog] = window.SDPIComponents.useGlobalSettings(catalogKey, onCatalog);

    // sdpi hands a subscription only the pushes after it: a global push that
    // came before this element connected is not replayed (#1653 review). The
    // hook's getter returns the value sdpi already holds — a local read that
    // sends nothing, so not the read the header rules out, resolving once
    // global settings first arrive — and skipUnchanged drops it when a push
    // delivered it first.
    void readCatalog().then(onCatalog);
  }

  private fallbackNumber(): number {
    const parsed = Number(this.getAttribute("default") ?? DEFAULT_CAMERA_GROUP_VALUE);

    return Number.isInteger(parsed) ? parsed : DEFAULT_CAMERA_GROUP_VALUE;
  }

  /** Rebuild the options from the current state. Writes nothing. */
  private render(): void {
    if (!this.select) return;

    const stored = effectiveCameraGroupName(this.storedName, this.storedNumber, this.fallbackNumber());
    const model = buildCameraGroupPicker(this.catalog, stored);

    this.select.replaceChildren();

    for (const section of model.sections) {
      const parent: HTMLElement = section.heading === null ? this.select : document.createElement("optgroup");

      if (section.heading !== null) {
        (parent as HTMLOptGroupElement).label = section.heading;
        this.select.appendChild(parent);
      }

      for (const entry of section.options) {
        const option = document.createElement("option");
        option.value = entry.value;
        option.textContent = entry.label;
        parent.appendChild(option);
      }
    }

    const other = document.createElement("option");
    other.value = "";
    other.dataset.other = "";
    other.textContent = OTHER_OPTION_LABEL;
    this.select.appendChild(other);

    if (this.otherMode) {
      other.selected = true;
    } else {
      // By option, not `select.value =`: a group may be named anything, and only
      // the model's own options are candidates.
      const match = Array.from(this.select.options).find(
        (option) => option.dataset.other === undefined && option.value === model.selected,
      );

      if (match) match.selected = true;
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-camera-group-select")) {
  customElements.define("ird-camera-group-select", CameraGroupSelect);
}
