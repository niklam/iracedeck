/**
 * Shared selected-car singleton.
 *
 * Set by the `select-reference-car` button. Camera-controls, race-admin, and
 * replay-control actions read this to target the chosen car independently of
 * which car the camera is currently watching.
 */

export interface SelectedCar {
  /** iRacing driver index (0–63) */
  carIdx: number;
  /** Display car number used in admin chat commands, e.g. "042" */
  carNumber: string;
  /** Raw car number used by the camera API, e.g. 3042 */
  carNumberRaw: number;
}

let selectedCar: SelectedCar | null = null;
const listeners = new Set<(car: SelectedCar | null) => void>();

/**
 * Set the currently selected car. Notifies all subscribers.
 */
export function setSelectedCar(car: SelectedCar): void {
  selectedCar = car;

  for (const listener of listeners) listener(car);
}

/**
 * Get the currently selected car, or null if none is selected.
 */
export function getSelectedCar(): SelectedCar | null {
  return selectedCar;
}

/**
 * Clear the selected car. Notifies all subscribers.
 */
export function clearSelectedCar(): void {
  selectedCar = null;

  for (const listener of listeners) listener(null);
}

/**
 * Subscribe to selected-car changes.
 * @returns A cleanup function that unsubscribes the listener.
 */
export function onSelectedCarChange(listener: (car: SelectedCar | null) => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}
