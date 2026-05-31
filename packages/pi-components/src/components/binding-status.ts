/// <reference lib="dom" />
/**
 * Binding / communication status line (issue #612).
 *
 * Rendered directly under an action's Mode selector. For the currently
 * selected mode it states how that mode talks to iRacing (iRacing API, key
 * binding, or chat command) and — for key-binding modes — whether a binding is
 * configured (keyboard OR SimHub role), with a link that opens the global
 * key-bindings accordion. Updates live as the mode changes and as bindings are
 * set / cleared / switched between keyboard and SimHub.
 *
 * Usage in a PI template (the comms map is emitted from action-comms.json):
 * ```html
 * <ird-binding-status
 *   mode-setting="mode"
 *   comms='<%- JSON.stringify(require("./data/action-comms.json")["fuel-service"]) %>'
 * ></ird-binding-status>
 * ```
 *
 * Attributes:
 * - comms        — JSON ActionCommMap: mode value → { method, binding? }
 * - mode-setting — name of the primary mode setting (default "mode")
 * - default-mode — mode value to use when there is no mode setting (single-mode actions)
 *
 * SYNC NOTE: CommDescriptor / BindingKeyRef below mirror their authoritative
 * counterparts in @iracedeck/deck-core/comm-descriptor.ts. The PI runs in a
 * browser and cannot import from deck-core (Node.js). When the descriptor
 * shape changes, update BOTH locations.
 */
import { formatKeyBinding, parseKeyBinding } from "./key-binding-utils.js";

type CommMethod = "api" | "keybind" | "chat";

interface BindingKeyConstant {
  scope: "global" | "action";
  key: string;
}
interface BindingKeyResolved {
  scope: "global" | "action";
  keyBy: { setting: string; map: Record<string, string> };
}
type BindingKeyRef = BindingKeyConstant | BindingKeyResolved;

interface CommDescriptor {
  method: CommMethod;
  binding?: BindingKeyRef;
}
type ActionCommMap = Record<string, CommDescriptor>;

/** Accordion that holds the global key bindings (see global-key-bindings.ejs). */
const KEY_BINDINGS_ACCORDION_ID = "Related Key Bindings";
const SIMHUB_REACHABLE_SETTING = "_simHubReachable";

type SettingsCallback = (value: string) => void;
interface SDPILike {
  useSettings: (key: string, cb: SettingsCallback, def: unknown) => [() => Promise<string>, (v: string) => void];
  useGlobalSettings: (key: string, cb: SettingsCallback, def: unknown) => [() => Promise<string>, (v: string) => void];
}

function isConstantKey(ref: BindingKeyRef): ref is BindingKeyConstant {
  return "key" in ref;
}

/** Parse a stored binding global-setting value into a display-ready shape. */
function parseStoredBinding(
  value: string,
): { kind: "keyboard"; text: string } | { kind: "simhub"; role: string } | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as { type?: string; role?: string };

    if (parsed.type === "simhub" && typeof parsed.role === "string" && parsed.role.length > 0) {
      return { kind: "simhub", role: parsed.role };
    }
  } catch {
    return null;
  }

  const kb = parseKeyBinding(value);
  const text = formatKeyBinding(kb);

  return text ? { kind: "keyboard", text } : null;
}

let styleInjected = false;

export class BindingStatus extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private comms: ActionCommMap = {};
  private currentMode = "";
  /** Live values of secondary (keyBy) settings, by setting name. */
  private secondary = new Map<string, string>();
  /** Live binding values, by global-settings key. */
  private bindings = new Map<string, string>();
  private simHubReachable = true;
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;

    this.initialized = true;
    this.injectStyle();
    this.container = document.createElement("div");
    this.container.className = "ird-binding-status";
    this.appendChild(this.container);

    this.comms = this.parseComms(this.getAttribute("comms"));
    this.currentMode = this.getAttribute("default-mode") ?? "";
    this.hookSettings();
    this.render();
  }

  private parseComms(raw: string | null): ActionCommMap {
    if (!raw) return {};

    try {
      const parsed: unknown = JSON.parse(raw);

      return parsed && typeof parsed === "object" ? (parsed as ActionCommMap) : {};
    } catch {
      return {};
    }
  }

  private get sdpi(): SDPILike | undefined {
    return (window as unknown as { SDPIComponents?: SDPILike }).SDPIComponents;
  }

  private hookSettings(): void {
    const sdpi = this.sdpi;

    if (!sdpi) return;

    // Primary mode setting.
    const modeSetting = this.getAttribute("mode-setting");

    if (modeSetting) {
      sdpi.useSettings(
        modeSetting,
        (value) => {
          this.currentMode = value || (this.getAttribute("default-mode") ?? "");
          this.render();
        },
        null,
      );
    }

    // Secondary (keyBy) settings and the candidate binding keys.
    const secondarySettings = new Set<string>();
    const bindingKeys = new Set<string>();

    for (const descriptor of Object.values(this.comms)) {
      const ref = descriptor.binding;

      if (!ref) continue;

      if (isConstantKey(ref)) {
        bindingKeys.add(ref.key);
      } else {
        secondarySettings.add(ref.keyBy.setting);

        for (const key of Object.values(ref.keyBy.map)) bindingKeys.add(key);
      }
    }

    for (const setting of secondarySettings) {
      sdpi.useSettings(
        setting,
        (value) => {
          this.secondary.set(setting, value);
          this.render();
        },
        null,
      );
    }

    for (const key of bindingKeys) {
      sdpi.useGlobalSettings(
        key,
        (value) => {
          this.bindings.set(key, value);
          this.render();
        },
        null,
      );
    }

    sdpi.useGlobalSettings(
      SIMHUB_REACHABLE_SETTING,
      (value) => {
        // Default to reachable when unknown so we don't nag before the plugin reports.
        this.simHubReachable = value !== "false" && value !== "0";
        this.render();
      },
      null,
    );
  }

  /** Resolve the active binding key for the current mode, if any. */
  private resolveKey(descriptor: CommDescriptor): string | undefined {
    const ref = descriptor.binding;

    if (!ref) return undefined;

    if (isConstantKey(ref)) return ref.key;

    const secondaryValue = this.secondary.get(ref.keyBy.setting);

    return secondaryValue ? ref.keyBy.map[secondaryValue] : undefined;
  }

  private render(): void {
    if (!this.container) return;

    const descriptor = this.comms[this.currentMode];

    if (!descriptor) {
      this.container.replaceChildren();

      return;
    }

    if (descriptor.method === "api") {
      this.renderOk("iRacing API — no binding needed.");

      return;
    }

    if (descriptor.method === "chat") {
      this.renderOk("Chat command — no binding needed.");

      return;
    }

    // keybind
    const key = this.resolveKey(descriptor);
    const binding = key ? parseStoredBinding(this.bindings.get(key) ?? "") : null;

    if (!binding) {
      this.renderMissing();

      return;
    }

    if (binding.kind === "keyboard") {
      this.renderOk(`Key binding — currently set: ${binding.text}.`);

      return;
    }

    // SimHub role — configured, but only works while SimHub runs.
    this.renderSimHub(binding.role);
  }

  private renderOk(text: string): void {
    this.container!.replaceChildren(this.line("ok", "✓", text));
  }

  private renderMissing(): void {
    const row = this.line("warn", "⚠", "No binding set — ");
    const link = document.createElement("a");
    link.href = "#";
    link.className = "ird-binding-status-link";
    link.textContent = "set it here";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      this.openKeyBindings();
    });
    row.querySelector(".ird-binding-status-text")!.appendChild(link);
    row.querySelector(".ird-binding-status-text")!.appendChild(document.createTextNode("."));
    this.container!.replaceChildren(row);
  }

  private renderSimHub(role: string): void {
    const main = this.line("ok", "✓", `Bound to SimHub role: ${role}.`);
    const caveat = this.simHubReachable
      ? this.line("muted", "", "Requires SimHub to be running.")
      : this.line("warn", "⚠", "SimHub isn't running — this binding won't work until it is.");
    this.container!.replaceChildren(main, caveat);
  }

  private line(level: "ok" | "warn" | "muted", symbol: string, text: string): HTMLDivElement {
    const row = document.createElement("div");
    row.className = `ird-binding-status-line ird-binding-status-${level}`;

    if (symbol) {
      const icon = document.createElement("span");
      icon.className = "ird-binding-status-icon";
      icon.textContent = symbol;
      row.appendChild(icon);
    }

    const span = document.createElement("span");
    span.className = "ird-binding-status-text";
    span.textContent = text;
    row.appendChild(span);

    return row;
  }

  /** Open the global key-bindings accordion and scroll it into view. */
  private openKeyBindings(): void {
    const selector = `details[data-accordion-id="${KEY_BINDINGS_ACCORDION_ID}"]`;
    const accordion = document.querySelector(selector) as HTMLDetailsElement | null;

    if (!accordion) return;

    // Setting `open` fires a toggle event, which the accordion persistence
    // listener picks up — no need to write _accordionState here.
    accordion.open = true;
    accordion.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-binding-status { display: block; }
      ird-binding-status .ird-binding-status-line {
        display: flex;
        gap: 6px;
        align-items: baseline;
        margin: 4px 0 4px 95px;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif,
                     "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        font-size: 8pt;
        line-height: 1.3;
      }
      ird-binding-status .ird-binding-status-icon { flex-shrink: 0; }
      ird-binding-status .ird-binding-status-ok { color: #5dd17a; }
      ird-binding-status .ird-binding-status-warn { color: #ffc04d; }
      ird-binding-status .ird-binding-status-muted { color: #9aa4ad; }
      ird-binding-status .ird-binding-status-link { color: #4aa3ff; cursor: pointer; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-binding-status")) {
    customElements.define("ird-binding-status", BindingStatus);
  }
}
