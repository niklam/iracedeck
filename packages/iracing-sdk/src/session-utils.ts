/**
 * Session Info Utilities
 *
 * Functions for extracting driver and car information from iRacing session data.
 */

interface DriverEntry {
  CarIdx: number;
  CarNumber: string;
  CarIsPaceCar?: number;
}

/**
 * Get the car number for a given car index from session info.
 *
 * @param sessionInfo - The iRacing session info object
 * @param carIdx - The car index to look up
 * @returns The numeric car number, or null if not found
 */
export function getCarNumberFromSessionInfo(sessionInfo: unknown, carIdx: number): number | null {
  const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as DriverEntry[] | undefined;

  if (!drivers) return null;

  const driver = drivers.find((d) => d.CarIdx === carIdx);

  if (!driver) return null;

  const num = parseInt(driver.CarNumber, 10);

  return isNaN(num) ? null : num;
}

/**
 * Get all car numbers from session info, optionally excluding the pace car.
 *
 * @param sessionInfo - The iRacing session info object
 * @param excludePaceCar - Whether to exclude the pace car (default: false)
 * @returns Array of { carIdx, carNumber } sorted by car number ascending
 */
export function getAllCarNumbers(
  sessionInfo: unknown,
  excludePaceCar = false,
): Array<{ carIdx: number; carNumber: number }> {
  const driverInfo = (sessionInfo as Record<string, unknown>)?.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as DriverEntry[] | undefined;

  if (!drivers) return [];

  const result: Array<{ carIdx: number; carNumber: number }> = [];

  for (const driver of drivers) {
    if (excludePaceCar && driver.CarIsPaceCar === 1) continue;

    const num = parseInt(driver.CarNumber, 10);

    if (isNaN(num)) continue;

    result.push({ carIdx: driver.CarIdx, carNumber: num });
  }

  result.sort((a, b) => a.carNumber - b.carNumber);

  return result;
}
