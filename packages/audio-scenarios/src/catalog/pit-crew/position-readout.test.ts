/**
 * Unit tests for the position-readout reaction gate and bare/full intro logic
 * (issue #603).
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetPositionReadoutCooldown,
  _setReactionRandom,
  INTRO_COOLDOWN_MS,
  REACTION_CHANCE,
  shouldReactToOvertake,
  shouldSpeakIntro,
} from "./position-readout.js";

describe("shouldReactToOvertake — random gate, podium-exempt (#603)", () => {
  beforeEach(() => _resetPositionReadoutCooldown());

  it("always reacts for podium positions (P1/P2/P3) regardless of the roll", () => {
    _setReactionRandom(() => 0.99); // would fail the chance gate

    expect(shouldReactToOvertake(1)).toBe(true);
    expect(shouldReactToOvertake(2)).toBe(true);
    expect(shouldReactToOvertake(3)).toBe(true);
  });

  it("reacts for a non-podium position when the roll is under the chance", () => {
    _setReactionRandom(() => REACTION_CHANCE - 0.01);

    expect(shouldReactToOvertake(4)).toBe(true);
    expect(shouldReactToOvertake(15)).toBe(true);
  });

  it("skips the reaction for a non-podium position when the roll is at or over the chance", () => {
    _setReactionRandom(() => REACTION_CHANCE);
    expect(shouldReactToOvertake(4)).toBe(false);

    _setReactionRandom(() => 0.99);
    expect(shouldReactToOvertake(20)).toBe(false);
  });
});

describe("shouldSpeakIntro — bare vs full intro (#603)", () => {
  beforeEach(() => _resetPositionReadoutCooldown());

  const T0 = 1_000_000;

  it("speaks the full intro on the first readout", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
  });

  it("drops the intro for a ≤1-position move within the cooldown window", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
    expect(shouldSpeakIntro(4, T0 + 1000)).toBe(false); // delta 1, inside 30 s → bare
    expect(shouldSpeakIntro(4, T0 + 2000)).toBe(false); // same position → bare
  });

  it("restores the full intro once the cooldown elapses", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
    expect(shouldSpeakIntro(4, T0 + INTRO_COOLDOWN_MS)).toBe(true);
  });

  it("always uses the full intro for a move of more than one position, even inside the window", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
    expect(shouldSpeakIntro(2, T0 + 1000)).toBe(true); // delta 3 > 1 → full
  });
});
