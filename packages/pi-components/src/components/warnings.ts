/// <reference lib="dom" />
/**
 * Global Property Inspector warning banner (issue #610).
 *
 * Subscribes to the `_warnings` global setting — a JSON array of
 * `{ id, level, message }` records maintained by the plugin via deck-core's
 * `setWarning`/`clearWarning` — and renders one banner per record at the top
 * of the Property Inspector. State-driven and not dismissible: a warning
 * stays until its underlying condition clears.
 *
 * Auto-injected at the top of every PI body by `head-common.ejs`, so no
 * per-template markup is required.
 *
 * Placement filters (#1005). A warning about one specific control belongs
 * beside that control, not only in a strip the user has to scroll back up to
 * find: the settings-window banner explains why *Open iRaceDeck Settings* did
 * nothing, and that button sits at the BOTTOM of an action's Property
 * Inspector. So an instance can narrow what it shows:
 *
 * - `only="a,b"`   — render just these ids (the instance above the button).
 * - `except="a,b"` — render everything else (the auto-injected top strip).
 *
 * Used as complements, which is what stops a filtered warning appearing twice
 * on one page. A warning with no dedicated home is named in neither list and
 * still shows in the top strip, unchanged.
 */

let styleInjected = false;

type WarningLevel = "info" | "warning" | "error";
interface WarningRecord {
  id: string;
  level: WarningLevel;
  message: string;
}

const WARNINGS_SETTING = "_warnings";

const LEVEL_ICON: Record<WarningLevel, string> = {
  info: "ℹ️",
  warning: "⚠️",
  error: "⛔",
};

export class WarningsBanner extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private _initialized = false;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;
    this.injectStyle();
    this.container = document.createElement("div");
    this.appendChild(this.container);
    this.hookSettings();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-warnings { display: block; }
      ird-warnings .ird-warning {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin: 8px 0;
        padding: 8px 10px;
        border-radius: 4px;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif,
                     "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        font-size: 9pt;
        line-height: 1.35;
      }
      ird-warnings .ird-warning-icon { flex-shrink: 0; }
      ird-warnings .ird-warning-info { background: #1e3a4a; border: 1px solid #2a6f97; color: #d6ecff; }
      ird-warnings .ird-warning-warning { background: #4a3a1e; border: 1px solid #b8860b; color: #ffe9b8; }
      ird-warnings .ird-warning-error { background: #4a1e1e; border: 1px solid #c0392b; color: #ffd6d6; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    window.SDPIComponents.useGlobalSettings(WARNINGS_SETTING, (value: string) => {
      this.render(this.parse(value));
    });
  }

  private parse(value: unknown): WarningRecord[] {
    if (typeof value !== "string" || value === "") return [];

    try {
      const parsed: unknown = JSON.parse(value);

      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (w): w is WarningRecord =>
          !!w &&
          typeof (w as WarningRecord).id === "string" &&
          typeof (w as WarningRecord).message === "string" &&
          ((w as WarningRecord).level === "info" ||
            (w as WarningRecord).level === "warning" ||
            (w as WarningRecord).level === "error"),
      );
    } catch {
      return [];
    }
  }

  /** Comma-separated id list from an attribute; empty when unset or blank. */
  private idList(attribute: string): string[] {
    return (this.getAttribute(attribute) ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
  }

  private applyPlacementFilters(warnings: WarningRecord[]): WarningRecord[] {
    const only = this.idList("only");
    const except = this.idList("except");

    return warnings.filter((w) => (only.length === 0 || only.includes(w.id)) && !except.includes(w.id));
  }

  private render(warnings: WarningRecord[]): void {
    if (!this.container) return;

    this.container.replaceChildren();

    for (const w of this.applyPlacementFilters(warnings)) {
      const row = document.createElement("div");
      row.className = `ird-warning ird-warning-${w.level}`;

      const icon = document.createElement("span");
      icon.className = "ird-warning-icon";
      icon.textContent = LEVEL_ICON[w.level];
      row.appendChild(icon);

      const text = document.createElement("span");
      text.className = "ird-warning-text";
      text.textContent = w.message;
      row.appendChild(text);

      this.container.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-warnings")) {
    customElements.define("ird-warnings", WarningsBanner);
  }
}
