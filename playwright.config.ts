import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4318",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    url: "http://127.0.0.1:4318/api/config",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
