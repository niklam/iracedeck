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

Stream Deck actions require mocking the SDK and shared utilities. For testable pure functions (icon generation, constants), export them with `@internal` JSDoc:

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

// Mock SDK before importing
vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      createScope: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
  },
  action: () => (target: unknown) => target,
}));

// Mock shared utilities
vi.mock("../shared/index.js", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
  },
  // ... other mocks
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

See `packages/stream-deck-plugin/src/actions/splits-delta-cycle.test.ts` for a complete example.
