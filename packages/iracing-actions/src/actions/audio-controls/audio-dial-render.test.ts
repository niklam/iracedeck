import { applyBindingWarning } from "@iracedeck/deck-core";
import { describe, expect, it, vi } from "vitest";

import { renderAudioCanvasFor, renderAudioKnobSvg, renderAudioStripSvg } from "./audio-dial-render.js";

// Only the warning overlay is reached from deck-core; a marker makes it visible in the SVG.
vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: vi.fn((content: string) => `<g opacity="0.35">${content}</g><binding-warning/>`),
}));

describe("renderAudioStripSvg", () => {
  it("renders the category label band", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: false, bindingMissing: false });
    expect(svg).toContain("VOICE CHAT");
    expect(svg).toContain('viewBox="0 0 200 100"');
  });

  it("renders a level bar + numeric value for internal categories", () => {
    const svg = renderAudioStripSvg({
      category: "race-engineer",
      volume: 65,
      enabled: true,
      pttHeld: false,
      bindingMissing: false,
    });
    expect(svg).toContain("RACE ENGINEER");
    expect(svg).toContain(">65<");
    expect(svg).toContain("#2ecc71");
  });

  it("renders the OFF state (gray bar, OFF text) when the gate is disabled", () => {
    const svg = renderAudioStripSvg({
      category: "radar",
      volume: 40,
      enabled: false,
      pttHeld: false,
      bindingMissing: false,
    });
    expect(svg).toContain("OFF");
    expect(svg).toContain("#888888");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders no bar for keybind categories (no state available)", () => {
    const svg = renderAudioStripSvg({ category: "master", pttHeld: false, bindingMissing: false });
    expect(svg).toContain("MASTER");
    expect(svg).toContain("Turn to adjust");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders the spotter category identity-only (iRacing exposes no spotter volume, #809)", () => {
    const svg = renderAudioStripSvg({ category: "spotter", pttHeld: false, bindingMissing: false });
    expect(svg).toContain(">SPOTTER<");
    expect(svg).toContain("Turn to adjust");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders the ON AIR band while PTT is held", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: true, bindingMissing: false });
    expect(svg).toContain("ON AIR");
    expect(svg).toContain("#e74c3c");
  });

  it("applies the binding warning overlay when a required binding is missing", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: false, bindingMissing: true });
    expect(svg).toContain("<binding-warning/>");
  });

  it("sizes the binding warning for the 200x100 strip canvas, not the 144x144 key", () => {
    vi.mocked(applyBindingWarning).mockClear();
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: false, bindingMissing: true });
    expect(vi.mocked(applyBindingWarning)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyBindingWarning)).toHaveBeenCalledWith(expect.any(String), { width: 200, height: 100 });
    expect(svg).toContain('viewBox="0 0 200 100" width="200" height="100"');
  });
});

describe("renderAudioKnobSvg (#1013)", () => {
  it("draws the category band on the 176x112 knob canvas", () => {
    const svg = renderAudioKnobSvg({ category: "voice-chat", pttHeld: false, bindingMissing: false });
    expect(svg).toContain('viewBox="0 0 176 112" width="176" height="112"');
    expect(svg).toContain(">VOICE CHAT<");
  });

  it("draws the taller level bar and a larger value for internal categories", () => {
    const svg = renderAudioKnobSvg({
      category: "race-engineer",
      volume: 50,
      enabled: true,
      pttHeld: false,
      bindingMissing: false,
    });
    expect(svg).toContain(">RACE ENGINEER<");
    expect(svg).toMatch(/<rect x="8" y="58" width="160" height="36" rx="8" fill="#1a1f26"\/>/);
    expect(svg).toContain('width="80.0" height="36" rx="8" fill="#2ecc71"');
    expect(svg).toMatch(/font-size="22"[^>]*>50</);
  });

  it("draws the OFF state in gray", () => {
    const svg = renderAudioKnobSvg({
      category: "radar",
      volume: 40,
      enabled: false,
      pttHeld: false,
      bindingMissing: false,
    });
    expect(svg).toContain(">OFF<");
    expect(svg).toContain("#888888");
    expect(svg).not.toContain("#2ecc71");
  });

  it("draws the turn hint, not a bar, for the keybind categories", () => {
    const svg = renderAudioKnobSvg({ category: "spotter", pttHeld: false, bindingMissing: false });
    expect(svg).toContain(">SPOTTER<");
    expect(svg).toContain("Turn to adjust volume");
    expect(svg).not.toContain('rx="8"');
  });

  it("draws the ON AIR band while PTT is held", () => {
    const svg = renderAudioKnobSvg({ category: "voice-chat", pttHeld: true, bindingMissing: false });
    expect(svg).toContain(">ON AIR<");
    expect(svg).toContain("#e74c3c");
  });

  it("sizes the binding warning for the knob canvas", () => {
    vi.mocked(applyBindingWarning).mockClear();
    const svg = renderAudioKnobSvg({ category: "voice-chat", pttHeld: false, bindingMissing: true });
    expect(svg).toContain("<binding-warning/>");
    expect(vi.mocked(applyBindingWarning)).toHaveBeenCalledWith(expect.any(String), { width: 176, height: 112 });
  });
});

describe("renderAudioCanvasFor (#1013)", () => {
  const state = {
    category: "race-engineer",
    volume: 65,
    enabled: true,
    pttHeld: false,
    bindingMissing: false,
  } as const;

  it("draws the strip on the Stream Deck+ strip canvas", () => {
    expect(renderAudioCanvasFor({ id: "sd-plus-strip", width: 200, height: 100 }, state)).toBe(
      renderAudioStripSvg(state),
    );
  });

  it("draws the knob screen on the Stream Dock knob canvas", () => {
    expect(renderAudioCanvasFor({ id: "stream-dock-knob", width: 176, height: 112 }, state)).toBe(
      renderAudioKnobSvg(state),
    );
  });
});
