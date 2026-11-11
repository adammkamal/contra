import { defineConfig, devices } from "@playwright/test";

// The UI must be opened at localhost (not 127.0.0.1): the API's CORS allow-list matches the exact origin,
// and the browser's EventSource to /api/events is cross-origin.
const API_PORT = 4310;
const UI_PORT = 3310;
const UI = `http://localhost:${UI_PORT}`;

export default defineConfig({
  testDir: "e2e",
  workers: 1, // one API, shared state per workspace
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  // Playwright's bundled Chromium by default. Set PW_CHANNEL=chrome (PowerShell: $env:PW_CHANNEL = "chrome")
  // to use the installed Google Chrome instead, where Windows blocks the bundled one.
  use: { baseURL: UI, ...devices["Desktop Chrome"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), viewport: { width: 1400, height: 900 } },
  webServer: [
    {
      command: "npx tsx e2e/api-harness.ts",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { E2E_API_PORT: String(API_PORT), E2E_UI_ORIGIN: UI },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
    },
    {
      command: `npx next build && npx next start -p ${UI_PORT}`,
      url: UI,
      env: { CONTRA_API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "pipe",
    },
  ],
});
