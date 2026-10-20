import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "journey.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "/tmp/opencode/zimreaper-e2e",
  use: {
    headless: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
