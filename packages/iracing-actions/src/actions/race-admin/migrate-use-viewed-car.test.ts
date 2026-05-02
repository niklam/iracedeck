import { describe, expect, it } from "vitest";

import { migrateUseViewedCarToDriverTarget } from "./migrate-use-viewed-car.js";

describe("migrateUseViewedCarToDriverTarget", () => {
  it("maps useViewedCar=true to driverTarget=viewed-car and drops the legacy key", () => {
    const result = migrateUseViewedCarToDriverTarget({ useViewedCar: true });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({ driverTarget: "viewed-car" });
    expect(result.migrated.useViewedCar).toBeUndefined();
  });

  it("maps useViewedCar=false to driverTarget=specific and drops the legacy key", () => {
    const result = migrateUseViewedCarToDriverTarget({ useViewedCar: false });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({ driverTarget: "specific" });
    expect(result.migrated.useViewedCar).toBeUndefined();
  });

  it('treats string "true" as truthy (sdpi-checkbox stores booleans as strings)', () => {
    const result = migrateUseViewedCarToDriverTarget({ useViewedCar: "true" });

    expect(result.changed).toBe(true);
    expect(result.migrated.driverTarget).toBe("viewed-car");
    expect(result.migrated.useViewedCar).toBeUndefined();
  });

  it("treats other string values as falsy and maps to specific", () => {
    const result = migrateUseViewedCarToDriverTarget({ useViewedCar: "false" });

    expect(result.changed).toBe(true);
    expect(result.migrated.driverTarget).toBe("specific");
  });

  it("preserves other settings keys during migration", () => {
    const result = migrateUseViewedCarToDriverTarget({
      mode: "black-flag",
      useViewedCar: false,
      carNumber: "42",
      penaltyValue: "30",
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({
      mode: "black-flag",
      driverTarget: "specific",
      carNumber: "42",
      penaltyValue: "30",
    });
  });

  it("does not change settings that already use driverTarget", () => {
    const result = migrateUseViewedCarToDriverTarget({ driverTarget: "viewed-car" });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ driverTarget: "viewed-car" });
  });

  it("keeps driverTarget when both keys are present (already-migrated wins)", () => {
    const result = migrateUseViewedCarToDriverTarget({
      driverTarget: "type-in-chat",
      useViewedCar: true,
    });

    expect(result.changed).toBe(false);
    expect(result.migrated.driverTarget).toBe("type-in-chat");
  });

  it("handles empty raw settings", () => {
    const result = migrateUseViewedCarToDriverTarget({});

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({});
  });

  it("handles null and undefined raw settings", () => {
    expect(migrateUseViewedCarToDriverTarget(null)).toEqual({ migrated: {}, changed: false });
    expect(migrateUseViewedCarToDriverTarget(undefined)).toEqual({ migrated: {}, changed: false });
  });

  it("handles non-object raw settings (string, number, boolean)", () => {
    expect(migrateUseViewedCarToDriverTarget("string").changed).toBe(false);
    expect(migrateUseViewedCarToDriverTarget(42).changed).toBe(false);
    expect(migrateUseViewedCarToDriverTarget(true).changed).toBe(false);
  });
});
