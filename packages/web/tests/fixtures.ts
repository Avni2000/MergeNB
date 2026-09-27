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
import * as logger from '../../core/src';
import { createMergeConflictRepo, cleanup as cleanupRepo } from '../../../test-fixtures/shared/repoSetup';
import { type ExpectedCell, getCellSource } from '../../../test-fixtures/shared/testHelpers';
import { ensureCheckboxChecked } from '../../../test-fixtures/shared/integrationUtils';
import { prepareIsolatedConfigPath, cleanupIsolatedConfigPath } from '../../../test-fixtures/shared/testRunnerShared';
import { setupConflictResolverHeadless, type ConflictSession } from '../../../test-fixtures/harness/conflictSession';
import { sleep } from '../../../test-fixtures/harness/browser';

interface NotebookTriplet {
    base: string;
    current: string;
    incoming: string;
}

interface ApplyOptions {
    markResolved?: boolean;
    postClickDelayMs?: number;
    writeTimeoutMs?: number;
}

interface NotebookMatchOptions {
    expectedLabel?: string;
    compareMetadata?: boolean;
    compareExecutionCounts?: boolean;
    renumberEnabled?: boolean;
    logCounts?: boolean;
}

// ─── Helper Functions ───────────────────────────────────────────────────────

async function waitForFileWrite(filePath: string, timeoutMs = 10000, initialMtime = 0): Promise<boolean> {
    const maxAttempts = Math.ceil(timeoutMs / 500);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(500);
        try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs > initialMtime) {
                return true;
            }
        } catch { /* continue */ }
    }
    return false;
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

/**
 * Check "Mark as resolved", click Apply, wait for the file to be written,
 * then read and return the resolved notebook from disk.
 */
export async function applyResolutionAndReadNotebook(
    page: Page,
    conflictFile: string,
    options: ApplyOptions = {}
): Promise<any> {
    if (options.markResolved ?? true) {
        await ensureCheckboxChecked(page, 'Mark as resolved');
    }

    logger.info('\n=== Applying resolution ===');
    const applyButton = page.locator('button.btn-primary:has-text("Apply Resolution")');
    await applyButton.waitFor({ timeout: 5000 });

    if (await applyButton.isDisabled()) {
        throw new Error('Apply Resolution button is disabled');
    }

    const initialMtime = (() => {
        try { return fs.statSync(conflictFile).mtimeMs; } catch { return 0; }
    })();

    await applyButton.click();
    await sleep(options.postClickDelayMs ?? 3000);

    const fileWritten = await waitForFileWrite(conflictFile, options.writeTimeoutMs, initialMtime);
    if (!fileWritten) {
        logger.info('Warning: Could not confirm file write, proceeding anyway');
    }

    const notebookContent = fs.readFileSync(conflictFile, 'utf8');
    return JSON.parse(notebookContent);
}

/**
 * Build an `ExpectedCell[]` directly from a notebook file.
 */
export function buildExpectedCellsFromNotebook(notebook: any): ExpectedCell[] {
    if (!notebook || !Array.isArray(notebook.cells)) {
        return [];
    }
    return notebook.cells.map((cell: any, index: number) => {
        const cellType = cell?.cell_type || 'code';
        const hasOutputs = cellType === 'code' &&
            Array.isArray(cell.outputs) &&
            cell.outputs.length > 0;
        return {
            rowIndex: index,
            source: getCellSource(cell),
            cellType,
            metadata: cell?.metadata || {},
            hasOutputs,
            execution_count: cellType === 'code' ? (cell.execution_count ?? null) : undefined,
        };
    });
}

/**
 * Read a notebook fixture from this repository's `test/` directory.
 */
export function readNotebookFixtureFromRepo(fileName: string): any {
    const fixturePath = path.resolve(__dirname, '../../../test-fixtures', fileName);
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

/**
 * Assert that a resolved notebook on disk matches the expected cell list.
 */
export function assertNotebookMatches(
    expectedCells: ExpectedCell[],
    resolvedNotebook: any,
    options: NotebookMatchOptions = {}
): void {
    const expectedNonDeleted = expectedCells.filter(c => !c.isDeleted);
    const label = options.expectedLabel || 'Expected';
    const logCounts = options.logCounts ?? true;

    if (!resolvedNotebook || !Array.isArray(resolvedNotebook.cells)) {
        throw new Error('Resolved notebook is missing cells');
    }

    if (logCounts) {
        logger.info(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
        logger.info(`${label}: ${expectedNonDeleted.length} cells`);
    }

    if (resolvedNotebook.cells.length !== expectedNonDeleted.length) {
        logger.info('Cell count mismatch:');
        logger.info('Expected cells:');
        for (const cell of expectedNonDeleted) {
            logger.info(`  Row ${cell.rowIndex}: ${cell.cellType}, ${cell.source.length} chars`);
        }
        logger.info('Actual cells:');
        for (let i = 0; i < resolvedNotebook.cells.length; i++) {
            const src = getCellSource(resolvedNotebook.cells[i]);
            logger.info(`  Cell ${i}: ${resolvedNotebook.cells[i].cell_type}, ${src.length} chars`);
        }
        throw new Error(`Cell count mismatch: expected ${expectedNonDeleted.length}, got ${resolvedNotebook.cells.length}`);
    }

    let sourceMismatches = 0;
    let typeMismatches = 0;
    let metadataMismatches = 0;
    let executionMismatches = 0;
    let outputMismatches = 0;
    let nextExecutionCount = 1;

    for (let i = 0; i < expectedNonDeleted.length; i++) {
        const expected = expectedNonDeleted[i];
        const actual = resolvedNotebook.cells[i];
        const actualSource = getCellSource(actual);

        if (expected.source !== actualSource) {
            sourceMismatches++;
            logger.info(`Source mismatch at cell ${i}:`);
            logger.info(`  Expected: "${expected.source.substring(0, 80).replace(/\n/g, '\\n')}..."`);
            logger.info(`  Actual:   "${actualSource.substring(0, 80).replace(/\n/g, '\\n')}..."`);
        }

        if (expected.cellType !== actual.cell_type) {
            typeMismatches++;
            logger.info(`Type mismatch at cell ${i}: expected ${expected.cellType}, got ${actual.cell_type}`);
        }

        if (options.compareMetadata) {
            const expectedMetadata = expected.metadata || {};
            const actualMetadata = actual.metadata || {};
            if (JSON.stringify(expectedMetadata) !== JSON.stringify(actualMetadata)) {
                metadataMismatches++;
                logger.info(`Metadata mismatch at cell ${i}`);
            }
        }

        if (expected.outputs !== undefined) {
            const actualOutputs = (actual as any).outputs || [];
            const stripExecCount = (outs: any[]) =>
                outs.map(o => o.output_type === 'execute_result'
                    ? (({ execution_count: _ec, ...rest }) => rest)(o)
                    : o);
            if (JSON.stringify(stripExecCount(expected.outputs)) !== JSON.stringify(stripExecCount(actualOutputs))) {
                outputMismatches++;
                logger.info(`Outputs mismatch at cell ${i}:`);
                logger.info(`  Expected: ${JSON.stringify(expected.outputs).substring(0, 100)}...`);
                logger.info(`  Actual:   ${JSON.stringify(actualOutputs).substring(0, 100)}...`);
            }
        }

        if (options.compareExecutionCounts && expected.cellType === 'code') {
            const expectedExecutionCount = options.renumberEnabled
                ? (expected.hasOutputs ? nextExecutionCount++ : null)
                : (expected.execution_count ?? null);
            const actualExecutionCount = actual.execution_count ?? null;
            if (expectedExecutionCount !== actualExecutionCount) {
                executionMismatches++;
                logger.info(`Execution count mismatch at cell ${i}: expected ${expectedExecutionCount}, got ${actualExecutionCount}`);
            }
        }
    }

    if (sourceMismatches > 0) {
        throw new Error(`${sourceMismatches} cells have source mismatches`);
    }

    if (typeMismatches > 0) {
        throw new Error(`${typeMismatches} cells have type mismatches`);
    }

    if (metadataMismatches > 0) {
        throw new Error(`${metadataMismatches} cells have metadata mismatches`);
    }

    if (outputMismatches > 0) {
        throw new Error(`${outputMismatches} cells have output mismatches`);
    }

    if (executionMismatches > 0) {
        throw new Error(`${executionMismatches} cells have execution count mismatches`);
    }
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
