import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearSelectedCar, getSelectedCar, onSelectedCarChange, setSelectedCar } from "./selected-car.js";

describe("selected-car", () => {
  beforeEach(() => {
    clearSelectedCar();
  });

  afterEach(() => {
    clearSelectedCar();
  });

  describe("getSelectedCar", () => {
    it("returns null initially", () => {
      expect(getSelectedCar()).toBeNull();
    });
  });

  describe("setSelectedCar", () => {
    it("sets and returns the selected car", () => {
      setSelectedCar({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });
      expect(getSelectedCar()).toEqual({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });
    });

    it("replaces a previously set car", () => {
      setSelectedCar({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });
      setSelectedCar({ carIdx: 10, carNumber: "007", carNumberRaw: 7 });
      expect(getSelectedCar()).toEqual({ carIdx: 10, carNumber: "007", carNumberRaw: 7 });
    });
  });

  describe("clearSelectedCar", () => {
    it("sets selected car back to null", () => {
      setSelectedCar({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });
      clearSelectedCar();
      expect(getSelectedCar()).toBeNull();
    });

    it("is a no-op when already null", () => {
      expect(() => clearSelectedCar()).not.toThrow();
      expect(getSelectedCar()).toBeNull();
    });
  });

  describe("onSelectedCarChange", () => {
    it("fires listener when car is set", () => {
      const listener = vi.fn();
      onSelectedCarChange(listener);

      setSelectedCar({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });
    });

    it("fires listener with null when car is cleared", () => {
      const listener = vi.fn();
      setSelectedCar({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });
      onSelectedCarChange(listener);

      clearSelectedCar();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(null);
    });

    it("stops firing after unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = onSelectedCarChange(listener);

      unsubscribe();
      setSelectedCar({ carIdx: 5, carNumber: "042", carNumberRaw: 42 });

      expect(listener).not.toHaveBeenCalled();
    });

    it("supports multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      onSelectedCarChange(listener1);
      onSelectedCarChange(listener2);

      setSelectedCar({ carIdx: 3, carNumber: "003", carNumberRaw: 3 });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it("unsubscribing one listener does not affect others", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsubscribe1 = onSelectedCarChange(listener1);
      onSelectedCarChange(listener2);

      unsubscribe1();
      setSelectedCar({ carIdx: 3, carNumber: "003", carNumberRaw: 3 });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });
});
