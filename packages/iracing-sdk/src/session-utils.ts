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
