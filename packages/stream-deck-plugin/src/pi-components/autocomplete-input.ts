/// <reference lib="dom" />
/**
 * Autocomplete Input Web Component for Stream Deck Property Inspector
 *
 * A reusable text input with dropdown suggestions, clear button, and status messages.
 *
 * Usage:
 * ```typescript
 * const autocomplete = document.createElement("ird-autocomplete") as AutocompleteInput;
 * autocomplete.placeholder = "Type or select...";
 * autocomplete.setSuggestions(["Option A", "Option B"]);
 * autocomplete.addEventListener("change", () => console.log(autocomplete.value));
 * ```
 */
import { SDPI_THEME, UI_TEXT } from "./key-binding-utils.js";

/**
 * AutocompleteInput — text input with dropdown suggestions and clear button.
 */
class AutocompleteInput extends HTMLElement {
  private input: HTMLInputElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;
  private panel: HTMLDivElement | null = null;
  private suggestions: string[] = [];
  private statusMessage: string | null = null;

  get value(): string {
    return this.input?.value ?? "";
  }

  set value(val: string) {
    if (this.input) {
      this.input.value = val;
      this.updateClearButton();
    }
  }

  set placeholder(val: string) {
    if (this.input) {
      this.input.placeholder = val;
    }
  }

  connectedCallback(): void {
    Object.assign(this.style, {
      display: "flex",
      alignItems: "center",
      flex: "1",
      minWidth: "0",
      position: "relative",
    });

    // Text input
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = UI_TEXT.SIMHUB_PLACEHOLDER;
    Object.assign(this.input.style, {
      backgroundColor: "transparent",
      color: SDPI_THEME.text,
      fontFamily: SDPI_THEME.fontFamily,
      fontSize: SDPI_THEME.fontSize,
      height: SDPI_THEME.height,
      padding: SDPI_THEME.padding,
      border: "none",
      boxSizing: "border-box",
      flex: "1",
      minWidth: "0",
    });

    // Clear button
    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.textContent = "×";
    this.clearBtn.title = "Clear";
    Object.assign(this.clearBtn.style, {
      background: "none",
      border: "none",
      color: "#888",
      cursor: "pointer",
      fontSize: "14px",
      padding: "0 4px",
      flexShrink: "0",
      lineHeight: SDPI_THEME.height,
      display: "none",
    });

    // Dropdown panel
    this.panel = document.createElement("div");
    Object.assign(this.panel.style, {
      display: "none",
      position: "absolute",
      top: "100%",
      left: "0",
      right: "0",
      zIndex: "999",
      backgroundColor: "#2a2a2a",
      border: "1px solid #555",
      borderRadius: "4px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
      maxHeight: "150px",
      overflowY: "auto",
      marginTop: "2px",
    });

    this.appendChild(this.input);
    this.appendChild(this.clearBtn);
    this.appendChild(this.panel);

    // Events
    this.input.addEventListener("input", () => {
      this.filterAndShow(this.input!.value);
      this.emitChange();
    });

    this.input.addEventListener("focus", () => {
      this.showDropdown();
    });

    this.input.addEventListener("blur", () => {
      this.hideDropdown();
    });

    this.clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (this.input) {
        this.input.value = "";
        this.updateClearButton();
        this.emitChange();
        this.input.focus();
        this.showDropdown();
      }
    });
  }

  /**
   * Set the available suggestions for the autocomplete dropdown.
   */
  setSuggestions(items: string[]): void {
    this.suggestions = items;
    this.statusMessage = null;

    // If input is focused, show the dropdown immediately with new suggestions
    if (this.input && document.activeElement === this.input) {
      this.showDropdown();
    }
  }

  /**
   * Set a status message to display instead of suggestions
   * (e.g., "SimHub not reachable").
   */
  setStatus(message: string): void {
    this.statusMessage = message;
    this.suggestions = [];

    if (this.input && document.activeElement === this.input) {
      this.showDropdown();
    }
  }

  /**
   * Clear the status message without setting suggestions.
   */
  clearStatus(): void {
    this.statusMessage = null;
  }

  /**
   * Focus the input.
   */
  focusInput(): void {
    this.input?.focus();
  }

  private showDropdown(): void {
    if (this.statusMessage) {
      this.showMessage(this.statusMessage);

      return;
    }

    if (this.suggestions.length === 0) {
      return;
    }

    this.filterAndShow(this.input?.value ?? "");
  }

  private filterAndShow(query: string): void {
    if (!this.panel || this.suggestions.length === 0) return;

    const lower = query.toLowerCase();
    const filtered = lower ? this.suggestions.filter((s) => s.toLowerCase().includes(lower)) : this.suggestions;

    if (filtered.length === 0) {
      this.hideDropdown();

      return;
    }

    this.panel.innerHTML = "";

    for (const item of filtered) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        padding: "5px 10px",
        cursor: "pointer",
        fontSize: "11px",
        color: SDPI_THEME.text,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      row.textContent = item;
      row.addEventListener("mouseenter", () => {
        row.style.backgroundColor = "#444";
      });
      row.addEventListener("mouseleave", () => {
        row.style.backgroundColor = "transparent";
      });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      row.addEventListener("click", () => {
        if (this.input) {
          this.input.value = item;
          this.updateClearButton();
          this.emitChange();
          this.hideDropdown();
        }
      });
      this.panel.appendChild(row);
    }

    this.panel.style.display = "block";
  }

  private showMessage(message: string): void {
    if (!this.panel) return;

    this.panel.innerHTML = "";

    const row = document.createElement("div");
    Object.assign(row.style, {
      padding: "6px 10px",
      fontSize: "11px",
      color: "#999",
      fontStyle: "italic",
    });
    row.textContent = message;
    this.panel.appendChild(row);
    this.panel.style.display = "block";
  }

  private hideDropdown(): void {
    if (this.panel) {
      this.panel.style.display = "none";
    }
  }

  private updateClearButton(): void {
    if (this.clearBtn) {
      this.clearBtn.style.display = this.input?.value ? "block" : "none";
    }
  }

  private emitChange(): void {
    this.dispatchEvent(new Event("change"));
  }
}

if (typeof customElements !== "undefined") {
  customElements.define("ird-autocomplete", AutocompleteInput);
}

export { AutocompleteInput };
