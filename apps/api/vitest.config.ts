import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    // Each test file gets its own module registry so vi.mock calls don't bleed between files
    isolate: true,
    // Suppress noisy console.error output from deliberate error-path tests
    silent: false,
  },
});
