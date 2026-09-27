/**
 * @file fixtures.ts
 * @description Playwright Test fixtures for MergeNB integration tests.
 *
 * Provides reusable fixtures for:
 * - Creating merge conflict repos from notebook triplets
 * - Setting up the conflict resolver UI session
 * - Applying resolutions and verifying notebooks
 *
 * These fixtures replace the manual setup/teardown patterns from the
 * old testHarness.ts `run()` export pattern.
 */

import { test as base, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createMergeConflictRepo, cleanup as cleanupRepo } from '../../../test-fixtures/shared/repoSetup';
import { type ExpectedCell } from '../../../test-fixtures/shared/testHelpers';
import { prepareIsolatedConfigPath, cleanupIsolatedConfigPath } from '../../../test-fixtures/shared/testRunnerShared';
import { setupConflictResolverHeadless, type ConflictSession } from '../../../test-fixtures/harness/conflictSession';
import { applyResolutionAndReadNotebook, assertNotebookMatches, type ApplyOptions, type NotebookMatchOptions } from '../../../test-fixtures/harness/notebook';
export { applyResolutionAndReadNotebook, assertNotebookMatches, buildExpectedCellsFromNotebook, readNotebookFixtureFromRepo } from '../../../test-fixtures/harness/notebook';

interface NotebookTriplet {
    base: string;
    current: string;
    incoming: string;
}

// ─── Core Fixture Functions ─────────────────────────────────────────────────

/**
 * Create a merge conflict repository from a notebook triplet.
 * Returns the workspace path for use in tests.
 */
function createConflictRepo(notebooks: NotebookTriplet): string {
    const testDir = path.resolve(__dirname, '../../../test-fixtures');
    const baseFile = path.resolve(testDir, notebooks.base);
    const currentFile = path.resolve(testDir, notebooks.current);
    const incomingFile = path.resolve(testDir, notebooks.incoming);

    // Validate all files exist
    for (const f of [baseFile, currentFile, incomingFile]) {
        if (!fs.existsSync(f)) {
            throw new Error(`Notebook not found: ${f}`);
        }
    }

    return createMergeConflictRepo(baseFile, currentFile, incomingFile);
}

// ─── Playwright Test Extension ──────────────────────────────────────────────

interface MergeNBFixtures {
    /**
     * Isolated MergeNB config file path (auto fixture).
     * Matches `runIntegrationTest.ts` setting `MERGENB_CONFIG_PATH` per test so
     * `writeSettingsFile` / `getSettings()` do not race on the global config file
     * or pick up a user `ui.showBaseColumn: true` while a test expects `false`.
     */
    mergeNBIsolatedConfig: string;
    /** Create a merge conflict repository from notebook files */
    conflictRepo: (notebooks: NotebookTriplet) => string;
    /** Set up the conflict resolver UI and return a session */
    conflictSession: (
        workspacePath: string,
        options?: { headless?: boolean }
    ) => Promise<ConflictSession>;
    /** Apply resolution and read the resulting notebook */
    applyAndReadNotebook: (
        page: Page,
        conflictFile: string,
        options?: ApplyOptions
    ) => Promise<any>;
    /** Assert notebook matches expected cells */
    assertMatches: (
        expectedCells: ExpectedCell[],
        resolvedNotebook: any,
        options?: NotebookMatchOptions
    ) => void;
}

/**
 * Extended Playwright test with MergeNB fixtures.
 * 
 * Usage:
 * ```ts
 * import { test, expect } from './fixtures';
 * 
 * test('my test', async ({ conflictRepo, conflictSession }) => {
 *     const workspacePath = conflictRepo({
 *         base: 'general/conflict_2/base.ipynb',
 *         current: 'general/conflict_2/current.ipynb',
 *         incoming: 'general/conflict_2/incoming.ipynb',
 *     });
 *     const session = await conflictSession(workspacePath);
 *     // ... test code
 * });
 * ```
 */
export const test = base.extend<MergeNBFixtures>({
    mergeNBIsolatedConfig: [
        async ({}, use) => {
            const { configRoot, configPath } = prepareIsolatedConfigPath(`pw-${randomUUID()}`);
            const previous = process.env.MERGENB_CONFIG_PATH;
            process.env.MERGENB_CONFIG_PATH = configPath;
            await use(configPath);
            if (previous === undefined) {
                delete process.env.MERGENB_CONFIG_PATH;
            } else {
                process.env.MERGENB_CONFIG_PATH = previous;
            }
            cleanupIsolatedConfigPath(configRoot);
        },
        { auto: true },
    ],

    conflictRepo: async ({}, use) => {
        const createdRepos: string[] = [];

        const createRepo = (notebooks: NotebookTriplet): string => {
            const repo = createConflictRepo(notebooks);
            createdRepos.push(repo);
            return repo;
        };

        await use(createRepo);

        // Cleanup all created repos after test
        for (const repo of createdRepos) {
            cleanupRepo(repo);
        }
    },

    conflictSession: async ({}, use) => {
        const sessions: ConflictSession[] = [];

        const createSession = async (
            workspacePath: string,
            options?: { headless?: boolean }
        ): Promise<ConflictSession> => {
            const session = await setupConflictResolverHeadless(workspacePath, path.resolve(__dirname, '../../..'), options);
            sessions.push(session);
            return session;
        };

        await use(createSession);

        // Cleanup all sessions after test
        for (const session of sessions) {
            try {
                await session.page.close();
            } catch { /* ignore */ }
            try {
                await session.browser.close();
            } catch { /* ignore */ }
        }
    },

    applyAndReadNotebook: async ({}, use) => {
        await use(applyResolutionAndReadNotebook);
    },

    assertMatches: async ({}, use) => {
        await use(assertNotebookMatches);
    },
});

export { expect } from '@playwright/test';
