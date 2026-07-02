import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Tests share the seeded database state and run in order.
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    // Safari's engine: catches WebKit-only behavior like refusing Secure
    // cookies over plain http, which Chromium happily allows on localhost.
    // Runs dark so both color schemes are covered (blueprint 03).
    { name: 'webkit', use: { ...devices['Desktop Safari'], colorScheme: 'dark' } },
  ],
});
