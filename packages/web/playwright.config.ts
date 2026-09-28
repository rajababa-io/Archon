import { defineConfig, devices } from '@playwright/test';

/**
 * Browser suite for the console.
 *
 * Everything the other checks cover is static: types, lint, unit tests under
 * jsdom. None of them loads the bundle, so none of them can tell a working
 * console from a blank page. This project does, and it is the only one here
 * that needs a browser.
 *
 * `testMatch` is `*.e2e.ts` rather than the Playwright default of
 * `*.spec.ts`/`*.test.ts`, because those two names belong to the repository's
 * Bun suite: `scripts/test-inventory.test.ts` requires every tracked file with
 * either name to be selected by `bun run test`, and `bun test` cannot run a
 * Playwright spec. A distinct extension keeps the two runners from claiming
 * each other's files, and this directory glob is this suite's inventory — a new
 * `e2e/*.e2e.ts` file runs by having been written.
 */

/**
 * Extra Chromium flags, supplied by the environment rather than written here.
 *
 * The Archon dev container needs `--single-process`; a CI runner does not, and
 * hardcoding it would make every other machine pay for one machine's sandbox.
 * See `e2e/README.md` for the local command.
 */
const chromiumArgs = (process.env.ARCHON_E2E_CHROMIUM_ARGS ?? '')
  .split(' ')
  .filter(arg => arg.length > 0);

/** The mobile shell's suite, which runs under the phone profiles only. */
const MOBILE_SUITE = '**/mobile.e2e.ts';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // One worker, no retries: the suite serves fixed fixtures to a local browser,
  // so a flake here is a defect to read rather than a run to repeat.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  // `test.only` left in a file would silently shrink the suite in CI.
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  use: {
    // Wide enough for the rail: the console hides it below Tailwind's `md`
    // breakpoint (768px) behind a menu button, and a suite that asserted the
    // rail at 640px would be asserting the mobile layout by accident.
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: MOBILE_SUITE,
      use: { ...devices['Desktop Chrome'], launchOptions: { args: chromiumArgs } },
    },
    // The mobile shell, at a phone's size, pixel density, user agent and touch
    // input. Both run in Chromium: CI installs Chromium alone, and what these
    // assert is the layout and the flows, not an engine's quirks. What only a
    // real iPhone can show — the keyboard, Safari's viewport — is on the
    // real-device checklist instead.
    {
      name: 'iphone',
      testMatch: MOBILE_SUITE,
      use: {
        ...devices['iPhone 15'],
        browserName: 'chromium',
        launchOptions: { args: chromiumArgs },
      },
    },
    {
      name: 'pixel',
      testMatch: MOBILE_SUITE,
      use: { ...devices['Pixel 7'], launchOptions: { args: chromiumArgs } },
    },
  ],
});
