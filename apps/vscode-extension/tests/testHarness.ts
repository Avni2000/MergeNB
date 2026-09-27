/**
 * @file testHarness.ts
 * @description VS Code extension host lifecycle helpers for integration tests.
 *
 * Runs inside the `@vscode/test-electron` extension host. Provides:
 * - `readTestConfig`  — reads the JSON config written by the runner before launch
 * - `setupConflictResolver` — opens the conflict file, starts the web server,
 *   and connects a Playwright browser to the live session UI
 * - `applyResolutionAndReadNotebook` — clicks Apply and reads the resolved notebook
 * - `assertNotebookMatches` — compares the resolved notebook against expected cells
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as logger from '../../../packages/core/src';
import { configContext } from '../settings';
import {
    type TestConfig, waitForServer, waitForSessionUrl,
} from '../../../test-fixtures/shared/testHelpers';
export { applyResolutionAndReadNotebook, assertNotebookMatches } from '../../../test-fixtures/harness/notebook';
import { setupConflictResolverHeadless, type ConflictSession as SharedConflictSession } from '../../../test-fixtures/harness/conflictSession';
import { openConflictResolverPage, sleep } from '../../../test-fixtures/harness/browser';

// Optional vscode import for headless test support.
let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless mode (tests) - vscode not available
}

interface ConflictSession extends SharedConflictSession {
    config: TestConfig;
}

interface SetupOptions {
    headless?: boolean;
    serverTimeoutMs?: number;
    sessionTimeoutMs?: number;
    afterNavigateDelayMs?: number;
    postHeaderDelayMs?: number;
}

/** Read the test config JSON written to disk by the runner before VS Code launched. */
export function readTestConfig(): TestConfig {
    const ctx = configContext.getStore();
    const override = ctx?.testConfigPath ?? process.env.MERGENB_TEST_CONFIG_PATH;
    const configPath = override && override.trim()
        ? path.resolve(override.trim())
        : path.join(os.tmpdir(), 'mergenb-test-config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Open the conflict notebook, run `merge-nb.findConflicts`, wait for the web
 * server, and connect a Playwright browser to the session UI.
 *
 * Returns a `ConflictSession` with the `page` ready for UI interactions.
 * Closes the browser and rethrows if navigation or header verification fails.
 */
export async function setupConflictResolver(
    config: TestConfig,
    options: SetupOptions = {}
): Promise<ConflictSession> {
    if (!vscode) {
        const session = await setupConflictResolverHeadless(
            config.workspacePath, path.resolve(__dirname, '../../../..'), options
        );
        return { ...session, config };
    }

    const workspacePath = config.workspacePath;
    const conflictFile = path.join(workspacePath, 'conflict.ipynb');

    const doc = await vscode.workspace.openTextDocument(conflictFile);
    await vscode.window.showTextDocument(doc);
    await sleep(1000);

    logger.info('[TestHarness] Executing merge-nb.findConflicts command...');
    await vscode.commands.executeCommand('merge-nb.findConflicts');
    logger.info('[TestHarness] merge-nb.findConflicts command executed');

    logger.info('[TestHarness] Waiting for server to start...');
    const serverPort = await waitForServer(
        () => Promise.resolve(vscode.commands.executeCommand<number>('merge-nb.getWebServerPort')),
        options.serverTimeoutMs
    );
    logger.info(`[TestHarness] Server started on port ${serverPort}`);

    const sessionUrl = await waitForSessionUrl(
        () => Promise.resolve(vscode.commands.executeCommand<string>('merge-nb.getLatestWebSessionUrl')),
        options.sessionTimeoutMs
    );
    const sessionId = new URL(sessionUrl).searchParams.get('session') || 'unknown';
    logger.info(`Session created: ${sessionId}`);

    const { browser, page } = await openConflictResolverPage(sessionUrl, options);
    return { config, workspacePath, conflictFile, serverPort, sessionId, sessionUrl, browser, page };
}
