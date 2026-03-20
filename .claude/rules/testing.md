---
# Testing Conventions

- All new code must include unit tests. Use Vitest with `describe`/`it`/`expect`.
- Test file naming: `foo.ts` → `foo.test.ts`.
- Keep tests focused and fast. Mock external dependencies where appropriate.
- Add CI-friendly commands to `package.json` scripts to run tests non-interactively.

Common commands

```bash
pnpm test
pnpm test:watch
```

## Testing Stream Deck Actions

Stream Deck actions require mocking `@iracedeck/deck-core`. For testable pure functions (icon generation, constants), export them with `@internal` JSDoc:

```typescript
/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAME = "settingKey";

/**
 * @internal Exported for testing
 */
export function generateIconSvg(): string {
  // ...
}
```

### Action Test Structure

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock deck-core before importing
vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };
      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) =>
    b.modifiers?.length ? `${b.modifiers.join("+")}+${b.key}` : b.key),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({})),
  renderIconTemplate: vi.fn((_t: string, data: Record<string, string>) =>
    `<svg>${data.mainLabel || ""}${data.subLabel || ""}</svg>`),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

import { GLOBAL_KEY_NAME, generateIconSvg } from "./my-action.js";

describe("MyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct global key", () => {
      expect(GLOBAL_KEY_NAME).toBe("settingKey");
    });
  });

  describe("generateIconSvg", () => {
    it("should generate valid SVG data URI", () => {
      const result = generateIconSvg();
      expect(result).toContain("data:image/svg+xml");
    });
  });
});
```

### Reference Implementation

See `packages/actions/src/actions/splits-delta-cycle.test.ts` for a complete example.
