import { describe, expectTypeOf, it } from "vitest";

import type {
  QualifyingInvalidationSnapshot,
  SessionCategory,
  SessionClass,
  SessionStartConditions,
  SimEventMap,
} from "./index.js";

/**
 * #1587 named the practice / qualifying / race union `SessionCategory`. The
 * three payload fields that spelled it inline must keep exactly the type they
 * had, so a published shape cannot drift through the alias (type test: a
 * mismatch fails `pnpm typecheck`).
 */
describe("SessionCategory", () => {
  it("is the same union the session-typed payloads always carried", () => {
    expectTypeOf<SessionCategory>().toEqualTypeOf<"practice" | "qualifying" | "race">();
    expectTypeOf<SessionStartConditions["sessionType"]>().toEqualTypeOf<"practice" | "qualifying" | "race">();
    expectTypeOf<QualifyingInvalidationSnapshot["sessionType"]>().toEqualTypeOf<
      "practice" | "qualifying" | "race" | undefined
    >();
    expectTypeOf<SimEventMap["lap.completed"]["data"]["sessionType"]>().toEqualTypeOf<
      "practice" | "qualifying" | "race" | undefined
    >();
  });

  it("is what a classified session carries, beside the solo-qualifying flag", () => {
    expectTypeOf<SessionClass>().toEqualTypeOf<{
      readonly category: "practice" | "qualifying" | "race";
      readonly soloQualifying: boolean;
    }>();
  });
});
