/**
 * Replay Control dial — the display number of a car on the box (#801, #1448):
 * Track Order's camera car and its neighbours, and the camera car in Car #
 * and Position. A view runs every tick and asks for several cars' numbers, so
 * each session info's numbers are built once, by carIdx: the SDK parses a new
 * session info object on every update.
 */
import { getCarNumberFromSessionInfo } from "@iracedeck/iracing-sdk";
import { NO_CAR_IDX } from "@iracedeck/replay-engine";

const carNumbersBySessionInfo = new WeakMap<object, ReadonlyMap<number, string>>();

/** The display number of every car in the session info's driver list, by carIdx; the SDK's lookup, once per car. */
function buildCarNumbers(sessionInfo: object): ReadonlyMap<number, string> {
  const drivers = (sessionInfo as { DriverInfo?: { Drivers?: unknown } }).DriverInfo?.Drivers;
  const numbers = new Map<number, string>();

  if (!Array.isArray(drivers)) return numbers;

  for (const driver of drivers) {
    const carIdx = (driver as { CarIdx?: unknown } | null)?.CarIdx;

    if (typeof carIdx !== "number" || numbers.has(carIdx)) continue;

    const number = getCarNumberFromSessionInfo(sessionInfo, carIdx);

    if (number !== null) numbers.set(carIdx, number);
  }

  return numbers;
}

/** The display number of the car at `carIdx` (`getCarNumberFromSessionInfo`), from the map built for this session info. */
export function carNumberOf(sessionInfo: unknown, carIdx: number): string | null {
  if (typeof sessionInfo !== "object" || sessionInfo === null) return null;

  let numbers = carNumbersBySessionInfo.get(sessionInfo);

  if (numbers === undefined) {
    numbers = buildCarNumbers(sessionInfo);
    carNumbersBySessionInfo.set(sessionInfo, numbers);
  }

  return numbers.get(carIdx) ?? null;
}

/** The camera car's index from a reading: `CamCarIdx` when it names a car, else undefined (none, or the no-car sentinel). */
export function cameraCarIdx(telemetry: { readonly CamCarIdx?: unknown } | null): number | undefined {
  const carIdx = telemetry?.CamCarIdx;

  return typeof carIdx === "number" && carIdx >= 0 && carIdx !== NO_CAR_IDX ? carIdx : undefined;
}
