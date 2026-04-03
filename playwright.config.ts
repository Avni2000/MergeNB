/**
 * Playwright Test configuration for MergeNB integration tests.
 *
 * This replaces the custom runIntegrationTest.ts runner with Playwright Test's
 * built-in parallel workers, fixtures, and reporters.
 *
 * Note: VS Code extension host tests (requiresVSCode: true) remain on
 * @vscode/test-electron and run via a separate npm script.
 */

import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';

export default defineConfig({
    // Run tests directly from TypeScript source
    testDir: './packages/web/tests',

    // Match TypeScript test files
    testMatch: '**/*.spec.ts',

    // Run tests in parallel across multiple workers
    fullyParallel: true,

    // Fail the build on CI if you accidentally left test.only in the source code
    forbidOnly: !!process.env.CI,

    // Retry failed tests on CI
    retries: process.env.CI ? 2 : 0,

    // Number of parallel workers (adjust based on machine capabilities)
    workers: process.env.CI ? 2 : 4,

    // Reporter configuration
    reporter: process.env.CI
        ? [['github'], ['html', { open: 'never' }]]
        : [['list'], ['html', { open: 'on-failure' }]],

    // Global setup and teardown for web server lifecycle
    globalSetup: path.resolve(__dirname, 'packages/web/tests/globalSetup.ts'),
    globalTeardown: path.resolve(__dirname, 'packages/web/tests/globalTeardown.ts'),

    // Shared settings for all projects
    use: {
        // Collect trace when retrying a failed test
        trace: 'on-first-retry',

        // Screenshot on failure
        screenshot: 'only-on-failure',

        // Video on retry
        video: 'on-first-retry',

        // Headless by default
        headless: true,

        // Use Chromium
        ...devices['Desktop Chrome'],
    },

    // Test timeout (increase for complex merge operations)
    timeout: 60000,

    // Expect timeout
    expect: {
        timeout: 10000,
    },

    // Projects for different test categories
    projects: [
        {
            name: 'integration',
            testDir: './packages/web/tests',
        },
    ],

    // Output directory for test artifacts
    outputDir: './playwright-test-results',
});
