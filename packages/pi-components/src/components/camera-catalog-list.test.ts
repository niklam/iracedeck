// @vitest-environment jsdom
import { CAMERA_CATALOG_KEY, type CameraCatalogView } from "@iracedeck/app-constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the module also registers the custom element.
import { CAMERA_CATALOG_REMOVE_ARM_MS, cameraCatalogRows, formatLastSeen } from "./camera-catalog-list.js";

type SettingsCallback = (value: string) => void;

const CATALOG: CameraCatalogView = {
  version: 1,
  tracks: [
    { id: 1, name: "Spa", config: "" },
    { id: 2, name: "Monza", config: "" },
    { id: 3, name: "Daytona", config: "" },
    { id: 4, name: "Sebring", config: "" },
    { id: 5, name: "Spa", config: "Endurance" },
  ],
  groups: [
    { name: "TV1", tracks: [0, 1, 2, 3, 4], lastSeen: "2026-11-08T12:00:00.000Z" },
    { name: "drone", tracks: [0], lastSeen: "2026-10-01T12:00:00.000Z" },
    { name: "CrankItUp", tracks: [], lastSeen: "2026-09-15T12:00:00.000Z" },
  ],
  // The card lists every track, the current one included.
  current: { trackId: 2, groups: ["TV1"] },
};

describe("cameraCatalogRows", () => {
  it("lists every remembered name alphabetically, with every track that has it", () => {
    expect(cameraCatalogRows(CATALOG)).toEqual([
      { name: "CrankItUp", tracks: [], lastSeen: "2026-09-15T12:00:00.000Z" },
      { name: "drone", tracks: ["Spa"], lastSeen: "2026-10-01T12:00:00.000Z" },
      { name: "TV1", tracks: ["Daytona", "Monza", "Sebring", "Spa"], lastSeen: "2026-11-08T12:00:00.000Z" },
    ]);
  });

  it("is empty with no catalog", () => {
    expect(cameraCatalogRows(null)).toEqual([]);
  });
});

describe("formatLastSeen", () => {
  it("shows the date in the viewer's time zone", () => {
    const iso = "2026-11-08T12:00:00.000Z";
    const date = new Date(iso);
    const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

    expect(formatLastSeen(iso)).toBe(expected);
  });

  it("is empty for a missing or unreadable time", () => {
    expect(formatLastSeen("")).toBe("");
    expect(formatLastSeen("yesterday")).toBe("");
  });
});

describe("ird-camera-catalog-list", () => {
  let el: HTMLElement;
  let callback: SettingsCallback | undefined;
  let send: ReturnType<typeof vi.fn>;
  /** The catalog sdpi already holds, which the hook's getter returns; undefined: none delivered yet. */
  let stored: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    callback = undefined;
    stored = undefined;
    send = vi.fn(() => Promise.resolve());
    (window as unknown as Record<string, unknown>).SDPIComponents = {
      useGlobalSettings: (key: string, cb: SettingsCallback) => {
        if (key === CAMERA_CATALOG_KEY) callback = cb;

        // Before sdpi's first delivery the getter never resolves.
        return [() => (stored === undefined ? new Promise(() => {}) : Promise.resolve(stored)), vi.fn()];
      },
      streamDeckClient: { send },
    };
    el = document.createElement("ird-camera-catalog-list");
    document.body.appendChild(el);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const publish = (view: unknown): void => callback?.(typeof view === "string" ? view : JSON.stringify(view));
  const rows = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(".ird-cc-row"));
  const button = (name: string): HTMLButtonElement =>
    el.querySelector<HTMLButtonElement>(`.ird-cc-row[data-name="${name}"] button`) as HTMLButtonElement;

  it("shows the catalog sdpi already held when it connected (#1653 review)", async () => {
    // The push that brought it came before this element subscribed, and sdpi
    // does not replay one; only the hook's getter still has it.
    stored = JSON.stringify(CATALOG);
    document.body.replaceChildren();
    el = document.createElement("ird-camera-catalog-list");
    document.body.appendChild(el);
    await Promise.resolve();
    await Promise.resolve();

    expect(rows().map((r) => r.dataset.name)).toEqual(["CrankItUp", "drone", "TV1"]);
  });

  it("says nothing is remembered before the catalog arrives, and for a bad payload", () => {
    expect(el.querySelector(".ird-cc-empty")).not.toBeNull();

    publish("not json");

    expect(rows()).toHaveLength(0);
    expect(el.querySelector(".ird-cc-empty")).not.toBeNull();
  });

  it("renders one row per name with its tracks and when it was last seen", () => {
    publish(CATALOG);

    expect(rows().map((r) => r.dataset.name)).toEqual(["CrankItUp", "drone", "TV1"]);
    expect(el.querySelector(".ird-cc-count")?.textContent).toBe("3 remembered groups");

    const meta = rows().map((r) => r.querySelector(".ird-cc-meta")?.textContent ?? "");

    expect(meta[0]).toMatch(/^On no track's current camera file · last seen \d{4}-\d{2}-\d{2}$/);
    expect(meta[1]).toMatch(/^On Spa · last seen /);
    expect(meta[2]).toMatch(/^On Daytona, Monza, Sebring \+1 · last seen /);
    expect(rows()[2].querySelector(".ird-cc-meta")?.getAttribute("title")).toBe("Daytona, Monza, Sebring, Spa");
  });

  it("renders a name as text, never as markup", () => {
    publish({ ...CATALOG, groups: [{ name: "<img src=x onerror=alert(1)>", tracks: [], lastSeen: "" }] });

    expect(el.querySelector("img")).toBeNull();
    expect(rows()[0].querySelector(".ird-cc-name")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("lists and removes groups named like Object.prototype members", () => {
    publish({
      ...CATALOG,
      groups: ["__proto__", "constructor", "toString"].map((name) => ({ name, tracks: [0], lastSeen: "" })),
    });

    expect(rows().map((r) => r.dataset.name)).toEqual(["__proto__", "constructor", "toString"]);

    button("__proto__").click();
    button("__proto__").click();

    expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "cameraCatalogRemove", name: "__proto__" });
  });

  it("sends nothing on the first Remove press, which only arms it", () => {
    publish(CATALOG);
    button("drone").click();

    expect(send).not.toHaveBeenCalled();
    expect(button("drone").textContent).toBe("Remove — are you sure?");
  });

  it("sends cameraCatalogRemove with the name on the second press", () => {
    publish(CATALOG);
    button("drone").click();
    button("drone").click();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "cameraCatalogRemove", name: "drone" });
    expect(button("drone").textContent).toBe("Remove");
  });

  it("disarms after the arm window", () => {
    publish(CATALOG);
    button("drone").click();
    vi.advanceTimersByTime(CAMERA_CATALOG_REMOVE_ARM_MS);
    button("drone").click();

    expect(send).not.toHaveBeenCalled();
  });

  it("arming another row disarms the first", () => {
    publish(CATALOG);
    button("drone").click();
    button("TV1").click();

    expect(button("drone").textContent).toBe("Remove");
    button("drone").click();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps an arm across a push that still lists the name, and drops it when the name leaves", () => {
    publish(CATALOG);
    button("drone").click();
    publish({ ...CATALOG, current: null });

    expect(button("drone").textContent).toBe("Remove — are you sure?");

    publish({ ...CATALOG, groups: CATALOG.groups.filter((g) => g.name !== "drone") });
    publish(CATALOG);

    expect(button("drone").textContent).toBe("Remove");
  });
});
