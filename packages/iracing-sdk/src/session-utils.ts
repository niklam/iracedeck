/**
 * Session Info Utilities
 *
 * Functions for extracting driver and car information from iRacing session data.
 */

interface DriverEntry {
  CarIdx: number;
  CarNumber: string;
  CarNumberRaw: number;
  CarIsPaceCar?: number;
  IsSpectator?: number;
  UserName?: string;
  CarClassShortName?: string;
}

/**
 * A session car entry with driver and class details.
 * Returned by {@link getActiveSessionCars}.
 */
export interface ActiveSessionCar {
  /** iRacing car index (0–63). Used for all targeting commands. */
  carIdx: number;
  /** Display car number string (e.g. "042"), preserving leading zeros. */
  carNumber: string;
  /** Raw car number used by the iRacing camera API (e.g. 3042). */
  carNumberRaw: number;
  /** Driver display name. Empty string when not available. */
  driverName: string;
  /** Car class short name (e.g. "GT3"). Empty string when not available. */
  carClass: string;
}

/**
 * Get all non-pace-car, non-spectator session cars from session info.
 *
 * Returns a sorted list of every valid driver: numeric car numbers come first
 * (sorted ascending), followed by any non-numeric car numbers (sorted
 * alphabetically). The sort is stable for the same input so the list can be
 * diffed incrementally.
 *
 * Unlike {@link getAllCarNumbers}, this function:
 * - Excludes spectators
 * - Includes cars with non-numeric car numbers (sorted at the end)
 * - Returns driver name and car class
 *
 * @param sessionInfo - The iRacing session info object
 * @returns Sorted array of active session cars
 */
export function getActiveSessionCars(sessionInfo: unknown): ActiveSessionCar[] {
  const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as DriverEntry[] | undefined;

  if (!drivers) return [];

  const result: ActiveSessionCar[] = [];

  for (const driver of drivers) {
    if (driver.CarIsPaceCar === 1) continue;

    if (driver.IsSpectator === 1) continue;

    const cleaned = driver.CarNumber.replace(/[^0-9]/g, "");
    // If cleaning strips everything (fully non-numeric like "ABC"), keep the
    // original string so it is sortable alphabetically below numeric cars.
    const carNumber = cleaned.length > 0 ? cleaned : driver.CarNumber;

    result.push({
      carIdx: driver.CarIdx,
      carNumber,
      carNumberRaw: driver.CarNumberRaw,
      driverName: driver.UserName ?? "",
      carClass: driver.CarClassShortName ?? "",
    });
  }

  result.sort((a, b) => {
    const aNum = Number(a.carNumber);
    const bNum = Number(b.carNumber);
    const aIsNum = a.carNumber !== "" && !Number.isNaN(aNum);
    const bIsNum = b.carNumber !== "" && !Number.isNaN(bNum);

    if (aIsNum && bIsNum) return aNum - bNum;

    if (aIsNum) return -1;

    if (bIsNum) return 1;

    // Both non-numeric: alphabetical
    return a.carNumber.localeCompare(b.carNumber);
  });

  return result;
}

/**
 * Get the display car number for a given car index from session info.
 *
 * Returns the string representation (e.g., "042") preserving leading zeros.
 * Use this for chat commands where the exact string matters.
 *
 * @param sessionInfo - The iRacing session info object
 * @param carIdx - The car index to look up
 * @returns The car number string (preserving leading zeros), or null if not found
 */
export function getCarNumberFromSessionInfo(sessionInfo: unknown, carIdx: number): string | null {
  const driver = findDriver(sessionInfo, carIdx);

  if (!driver) return null;

  const cleaned = driver.CarNumber.replace(/[^0-9]/g, "");

  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Get the raw car number for a given car index from session info.
 *
 * Returns the CarNumberRaw value used by iRacing's camera API
 * (e.g., 3042 for display number "042").
 *
 * @param sessionInfo - The iRacing session info object
 * @param carIdx - The car index to look up
 * @returns The raw car number for camera API calls, or null if not found
 */
export function getCarNumberRawFromSessionInfo(sessionInfo: unknown, carIdx: number): number | null {
  const driver = findDriver(sessionInfo, carIdx);

  if (!driver) return null;

  return driver.CarNumberRaw ?? null;
}

/**
 * Get all car numbers from session info, optionally excluding the pace car.
 *
 * @param sessionInfo - The iRacing session info object
 * @param excludePaceCar - Whether to exclude the pace car (default: false)
 * @returns Array of { carIdx, carNumber, carNumberRaw } sorted by car number ascending
 */
export function getAllCarNumbers(
  sessionInfo: unknown,
  excludePaceCar = false,
): Array<{ carIdx: number; carNumber: string; carNumberRaw: number }> {
  const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as DriverEntry[] | undefined;

  if (!drivers) return [];

  const result: Array<{ carIdx: number; carNumber: string; carNumberRaw: number }> = [];

  for (const driver of drivers) {
    if (excludePaceCar && driver.CarIsPaceCar === 1) continue;

    const cleaned = driver.CarNumber.replace(/[^0-9]/g, "");

    if (cleaned.length === 0) continue;

    result.push({ carIdx: driver.CarIdx, carNumber: cleaned, carNumberRaw: driver.CarNumberRaw });
  }

  result.sort((a, b) => Number(a.carNumber) - Number(b.carNumber));

  return result;
}

export interface CameraGroup {
  groupNum: number;
  groupName: string;
}

/**
 * Get camera groups from iRacing session info.
 *
 * Extracts the list of available camera groups from CameraInfo.Groups[].
 *
 * @param sessionInfo - The iRacing session info object
 * @returns Array of camera groups with group number and name
 */
export function getCameraGroupsFromSessionInfo(sessionInfo: unknown): CameraGroup[] {
  const cameraInfo = (sessionInfo as Record<string, unknown>)?.CameraInfo as Record<string, unknown> | undefined;
  const groups = cameraInfo?.Groups as Array<{ GroupNum: number; GroupName: string }> | undefined;

  if (!groups) return [];

  return groups.map((g) => ({ groupNum: g.GroupNum, groupName: g.GroupName }));
}

/**
 * Find a driver entry by car index from session info.
 */
function findDriver(sessionInfo: unknown, carIdx: number): DriverEntry | null {
  const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as DriverEntry[] | undefined;

  if (!drivers) return null;

  return drivers.find((d) => d.CarIdx === carIdx) ?? null;
}
