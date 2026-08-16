/**
 * Contract test for the `PointerMoveResult` mirror.
 *
 * `deck-core`'s mouse pointer service declares its own `PointerMoveResult` constants
 * rather than importing them from `@iracedeck/iracing-native`: that package
 * loads the native addon as a module side effect, which a platform-agnostic
 * package must not do. The values are still a native contract, so they have to
 * be kept in sync by hand — this test is the guard, and it lives here because
 * the plugin is a package that already depends on both.
 */
import { PointerMoveResult as CorePointerMoveResult } from "@iracedeck/deck-core";
import { PointerMoveResult as NativePointerMoveResult } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

/** Member names of a TS numeric enum, without its reverse-mapping entries. */
function memberNames(numericEnum: Record<string, unknown>): string[] {
  return Object.keys(numericEnum)
    .filter((key) => !Number.isFinite(Number(key)))
    .sort();
}

describe("PointerMoveResult mirror (issue #926)", () => {
  it("covers exactly the members the native enum declares", () => {
    expect(memberNames(CorePointerMoveResult)).toEqual(
      memberNames(NativePointerMoveResult as unknown as Record<string, unknown>),
    );
  });

  // Derived from the member list rather than written out, so a member added to
  // both enums with MISMATCHED values fails here instead of slipping through on
  // a name-only comparison.
  it("assigns each member the same value as the native enum", () => {
    const names = memberNames(CorePointerMoveResult);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(CorePointerMoveResult[name as keyof typeof CorePointerMoveResult], name).toBe(
        (NativePointerMoveResult as unknown as Record<string, number>)[name],
      );
    }
  });
});
