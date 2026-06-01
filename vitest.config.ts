import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest config for the unit/integration suite (video pipeline + billing +
// env helpers). Kept isolated from Playwright: Vitest only owns tests/unit/**,
// while Playwright (test:e2e) owns tests/e2e/**. CI runs them as separate
// steps so a browser-server requirement never blocks the fast unit suite.
//
// The `@/` alias mirrors tsconfig.json's paths ("@/*" -> "./src/*") so test
// files import application code exactly as the app does.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Node environment — these are server-side libs (crypto, fetch, Supabase
    // service client). No jsdom needed.
    environment: "node",
    globals: false,
    // Only the unit suite. Explicitly exclude the Playwright e2e dir so a
    // `*.spec.ts` there is never double-run by Vitest.
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
    // NOTE: we deliberately do NOT enable clearMocks/restoreMocks globally.
    // Several suites declare `vi.fn().mockResolvedValue(...)` defaults at module
    // load time (the per-channel adapter mocks, etc.); restoreMocks would wipe
    // those defaults after the first test. Each suite instead calls
    // vi.clearAllMocks() in afterEach (clears call history only) and re-seeds
    // its defaults in beforeEach, which is explicit and leak-free.
  },
});
