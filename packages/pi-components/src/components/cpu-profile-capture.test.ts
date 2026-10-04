// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeCaptureStatus, parseCaptureStatus } from "./cpu-profile-capture.js";

let statusCallback: ((value: string) => void) | undefined;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.replaceChildren();
  statusCallback = undefined;
  send = vi.fn();
  (window as unknown as Record<string, unknown>).SDPIComponents = {
    streamDeckClient: { send },
    useGlobalSettings: (key: string, cb: (value: string) => void) => {
      if (key === "_profileCaptureStatus") statusCallback = cb;

      return [async () => "", vi.fn()];
    },
  };
});

afterEach(() => {
  (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  vi.useRealTimers();
});

function mount(tag: string): HTMLElement {
  const el = document.createElement(tag);

  document.body.appendChild(el);

  return el;
}

describe("ird-capture-cpu-profile / ird-open-profiles-folder (#1338)", () => {
  it("sends captureCpuProfile with no duration and no path", () => {
    const el = mount("ird-capture-cpu-profile");

    expect(el.querySelector("button")?.textContent).toBe("Capture CPU profile");
    el.querySelector("button")?.click();

    expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "captureCpuProfile" });
  });

  it("sends openProfilesFolder with no path", () => {
    const el = mount("ird-open-profiles-folder");

    el.querySelector("button")?.click();

    expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "openProfilesFolder" });
  });
});

describe("parseCaptureStatus", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not JSON", "{"],
    ["an unknown state", JSON.stringify({ state: "exploded" })],
    ["capturing without its clock", JSON.stringify({ state: "capturing" })],
    ["an array", "[]"],
  ])("reads %s as idle", (_label, raw) => {
    expect(parseCaptureStatus(raw)).toEqual({ state: "idle" });
  });

  it("reads each published state", () => {
    expect(parseCaptureStatus(JSON.stringify({ state: "capturing", startedAt: 1, durationMs: 2 }))).toEqual({
      state: "capturing",
      startedAt: 1,
      durationMs: 2,
    });
    expect(parseCaptureStatus(JSON.stringify({ state: "saved", startedAt: 1, file: "cpu-x.cpuprofile" }))).toEqual({
      state: "saved",
      file: "cpu-x.cpuprofile",
    });
    expect(parseCaptureStatus(JSON.stringify({ state: "failed", reason: "disk full" }))).toEqual({
      state: "failed",
      reason: "disk full",
    });
  });
});

describe("describeCaptureStatus", () => {
  it("counts down whole seconds, then says it is saving", () => {
    const capturing = { state: "capturing" as const, startedAt: 10_000, durationMs: 30_000 };

    expect(describeCaptureStatus(capturing, 10_000)).toBe("Capturing… 30 s left");
    expect(describeCaptureStatus(capturing, 10_500)).toBe("Capturing… 30 s left");
    expect(describeCaptureStatus(capturing, 39_001)).toBe("Capturing… 1 s left");
    expect(describeCaptureStatus(capturing, 40_000)).toBe("Capturing… saving the profile");
  });

  it("is empty while idle", () => {
    expect(describeCaptureStatus({ state: "idle" }, 0)).toBe("");
  });
});

describe("ird-cpu-profile-status (#1338)", () => {
  it("renders nothing while idle", () => {
    const el = mount("ird-cpu-profile-status");

    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe("");
  });

  it("ticks a countdown while capturing, then shows the saved file", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const el = mount("ird-cpu-profile-status");

    statusCallback?.(JSON.stringify({ state: "capturing", startedAt: 100_000, durationMs: 30_000 }));

    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("Capturing… 30 s left");

    vi.advanceTimersByTime(5000);

    expect(el.textContent).toBe("Capturing… 25 s left");

    statusCallback?.(JSON.stringify({ state: "saved", startedAt: 100_000, file: "cpu-2026.cpuprofile" }));

    expect(el.textContent).toBe("Saved cpu-2026.cpuprofile");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a failure's reason as text, never as markup", () => {
    const el = mount("ird-cpu-profile-status");

    statusCallback?.(JSON.stringify({ state: "failed", reason: "<img src=x onerror=alert(1)>" }));

    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("Capture failed: <img src=x onerror=alert(1)>");
  });

  it("stops the countdown when removed from the page", () => {
    vi.useFakeTimers();
    const el = mount("ird-cpu-profile-status");

    statusCallback?.(JSON.stringify({ state: "capturing", startedAt: Date.now(), durationMs: 30_000 }));
    el.remove();

    expect(vi.getTimerCount()).toBe(0);
  });
});
