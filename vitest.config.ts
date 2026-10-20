import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
