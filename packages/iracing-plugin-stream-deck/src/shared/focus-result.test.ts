/**
 * Contract test for the `FocusResult` mirror.
 *
 * `deck-core`'s window focus service declares its own `FocusResult` constants
 * rather than importing them from `@iracedeck/iracing-native`: that package
 * loads the native addon as a module side effect, which a platform-agnostic
 * package must not do. The values are still a native contract, so they have to
 * be kept in sync by hand — this test is the guard, and it lives here because
 * the plugin is a package that already depends on both.
 */
import { FocusResult as CoreFocusResult } from "@iracedeck/deck-core";
import { FocusResult as NativeFocusResult } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

/** Member names of a TS numeric enum, without its reverse-mapping entries. */
function memberNames(numericEnum: Record<string, unknown>): string[] {
  return Object.keys(numericEnum)
    .filter((key) => !Number.isFinite(Number(key)))
    .sort();
}

describe("FocusResult mirror (issue #930)", () => {
  it("covers exactly the members the native enum declares", () => {
    expect(memberNames(CoreFocusResult)).toEqual(memberNames(NativeFocusResult as unknown as Record<string, unknown>));
  });

  it("assigns each member the same value as the native enum", () => {
    expect(CoreFocusResult.AlreadyFocused).toBe(NativeFocusResult.AlreadyFocused);
    expect(CoreFocusResult.Focused).toBe(NativeFocusResult.Focused);
    expect(CoreFocusResult.WindowNotFound).toBe(NativeFocusResult.WindowNotFound);
    expect(CoreFocusResult.FocusTimedOut).toBe(NativeFocusResult.FocusTimedOut);
  });
});
