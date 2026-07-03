import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Tests share the seeded database state and run in order.
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    // NOTE on the slice-7 service worker: requests from SW-controlled pages
    // bypass page.route() in WebKit, so the app skips SW registration under
    // automation (navigator.webdriver gate in PwaSetup) and the slice-5
    // interception tests neuter registration as a belt. Playwright's
    // serviceWorkers:'block' option is NOT usable instead: under it WebKit's
    // second-and-later contexts hang on their first navigation.
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    // Safari's engine: catches WebKit-only behavior like refusing Secure
    // cookies over plain http, which Chromium happily allows on localhost.
    // Runs dark so both color schemes are covered (blueprint 03).
    //
    // WebKit stability: after ~55–65 tests in one browser process, a fresh
    // page's first goto() intermittently hangs without ever completing while
    // the server sits idle (traced repeatedly; victim roams across whatever
    // test runs at that point; never chromium). Two mitigations: slice 7
    // runs as its own project — projects get their own worker, i.e. a FRESH
    // browser, keeping every webkit browser's lifetime under the wedge
    // threshold — and retries:1, since a retry also starts a new worker
    // (a real regression still fails twice and reports red).
    {
      name: 'webkit',
      retries: 1,
      testIgnore: /slice7/,
      use: { ...devices['Desktop Safari'], colorScheme: 'dark' },
    },
    {
      name: 'webkit-slice7',
      retries: 1,
      testMatch: /slice7/,
      use: { ...devices['Desktop Safari'], colorScheme: 'dark' },
    },
  ],
});
