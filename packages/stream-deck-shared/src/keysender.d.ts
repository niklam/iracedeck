/**
 * Type shim for the `keysender` package.
 *
 * Used when the actual `keysender` package is not installed (e.g., on macOS).
 * When `keysender` is installed, its own type declarations take precedence.
 */
declare module "keysender" {
  export type KeyboardButton = string;
  export interface Keyboard {
    sendKey(key: KeyboardButton | KeyboardButton[]): Promise<void>;
    toggleKey(
      key: KeyboardButton | KeyboardButton[],
      state: boolean,
    ): Promise<void>;
  }
  export class Hardware {
    keyboard: Keyboard;
  }
}
