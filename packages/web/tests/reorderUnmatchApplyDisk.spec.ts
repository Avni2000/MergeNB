/**
 * @file reorderUnmatchApplyDisk.spec.ts
 * @description Playwright Test for unmatch -> resolve -> apply disk output.
 */

import { test, expect } from './fixtures';
import * as logger from '../../core/src';
import {
    verifyAllConflictsMatchSide,
    waitForAllConflictsResolved,
    waitForResolvedCount,
} from '../../../test-fixtures/shared/integrationUtils';
import {
    applyResolutionAndReadNotebook,
    assertNotebookMatches,
    buildExpectedCellsFromNotebook,
    readNotebookFixtureFromRepo,
} from './fixtures';
import { validateNotebookStructure } from '../../../test-fixtures/shared/testHelpers';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from '../../../apps/vscode-extension/tests/settingsFile';

// ─── Helper Functions ───────────────────────────────────────────────────────

function withRowIndex<T extends { rowIndex: number }>(cell: T, rowIndex: number): T {
    return { ...cell, rowIndex };
}

// ─── Test Definitions ───────────────────────────────────────────────────────

test.describe('Reorder Unmatch Apply Disk', () => {
    test('Unmatch reordered cells, resolve, and verify notebook written to disk', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting MergeNB Reorder Unmatch -> Apply Integration Test...');

        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
                'ui.showBaseColumn': true,
            });

            const workspacePath = conflictRepo({
                base: '09_reorder_base.ipynb',
                current: '09_reorder_current.ipynb',
                incoming: '09_reorder_incoming.ipynb',
            });

            const session = await conflictSession(workspacePath);
            const { page, conflictFile } = session;

            logger.info('\n=== Step 1: Verify unmatch is available ===');
            await page.locator('.merge-row').first().waitFor({ timeout: 5000 });
            const initialCounter = await waitForResolvedCount(page, 0, 5000);
            expect(initialCounter.total).toBeGreaterThan(0);

            const unmatchButtons = page.locator('[data-testid="unmatch-btn"]');
            await unmatchButtons.first().waitFor({ timeout: 5000 });
            const unmatchBtnCount = await unmatchButtons.count();
            expect(unmatchBtnCount).toBeGreaterThan(0);
            logger.info(`  Found ${unmatchBtnCount} unmatch button(s)`);

            logger.info('\n=== Step 2: Unmatch one reordered row ===');
            const betaConflictRow = page.locator('.merge-row.conflict-row').filter({ hasText: "print('beta')" });
            const betaUnmatchButton = betaConflictRow.locator('[data-testid="unmatch-btn"]');
            await betaUnmatchButton.waitFor({ timeout: 5000 });
            await betaUnmatchButton.scrollIntoViewIfNeeded();
            await betaUnmatchButton.click();
            await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });
            const afterUnmatchCounter = await waitForResolvedCount(page, 0, 5000);
            expect(afterUnmatchCounter.total).toBeGreaterThan(initialCounter.total);
            logger.info(`  Conflicts after unmatch: ${afterUnmatchCounter.total} (before: ${initialCounter.total})`);

            const remainingUnmatchButtons = await page.locator('[data-testid="unmatch-btn"]').count();
            expect(remainingUnmatchButtons).toBe(unmatchBtnCount - 1);

            const allBaseButtonCount = await page.locator('button:has-text("All Base")').count();
            expect(allBaseButtonCount).toBe(1);

            const userUnmatchedRows = page.locator('.merge-row.user-unmatched-row');
            const unmatchedRowCount = await userUnmatchedRows.count();
            expect(unmatchedRowCount).toBe(2);

            const splitRowBaseColumns = await userUnmatchedRows.locator('.base-column').count();
            expect(splitRowBaseColumns).toBe(unmatchedRowCount);

            const splitRowBaseButtons = await userUnmatchedRows.locator('.btn-resolve.btn-base').count();
            expect(splitRowBaseButtons).toBe(0);

            const splitRowBasePlaceholders = await userUnmatchedRows.locator('.base-column .placeholder-text').allTextContents();
            expect(splitRowBasePlaceholders.length).toBe(unmatchedRowCount);
            expect(splitRowBasePlaceholders.every(text => text.trim() === '(unmatched cell)')).toBe(true);

            logger.info('\n=== Step 3: Accept all current and capture independent expectation ===');
            const baseFixture = readNotebookFixtureFromRepo('09_reorder_base.ipynb');
            const currentFixture = readNotebookFixtureFromRepo('09_reorder_current.ipynb');
            const baseExpected = buildExpectedCellsFromNotebook(baseFixture);
            const currentExpected = buildExpectedCellsFromNotebook(currentFixture);
            const conflictRows = page.locator('.merge-row.conflict-row');
            const conflictRowCount = await conflictRows.count();
            expect(conflictRowCount).toBe(4);

            await page.locator('button:has-text("All Current")').click();
            const currentAcceptance = await verifyAllConflictsMatchSide(page, 'current');
            expect(currentAcceptance.mismatches.length).toBe(0);
            expect(currentAcceptance.matchCount).toBe(3);
            expect(currentAcceptance.deleteCount).toBe(1);

            const allResolved = await waitForAllConflictsResolved(page, 7000);
            expect(allResolved.total).toBeGreaterThan(0);
            expect(allResolved.resolved).toBe(allResolved.total);

            const renumberEnabled = await page
                .locator('label:has-text("Renumber execution counts") input[type="checkbox"]')
                .isChecked();

            // Fixture layout:
            //   base:    [intro, alpha, beta, gamma, outro]
            //   current: [intro, beta, alpha(modified), gamma, outro]
            const expectedCells = [
                withRowIndex(baseExpected[0], 0),     // intro
                withRowIndex(currentExpected[1], 1),  // beta from current
                withRowIndex(currentExpected[2], 2),  // alpha from current (modified)
                withRowIndex(currentExpected[3], 3),  // gamma from current
                withRowIndex(baseExpected[4], 4),     // outro
            ];

            logger.info('\n=== Step 4: Apply resolution and verify notebook on disk ===');
            const resolvedNotebook = await applyResolutionAndReadNotebook(page, conflictFile);
            assertNotebookMatches(expectedCells, resolvedNotebook, {
                expectedLabel: 'Expected All Current sequence after unmatching Beta',
                compareMetadata: true,
                compareExecutionCounts: true,
                renumberEnabled,
            });
            validateNotebookStructure(resolvedNotebook);
            logger.info('  \u2713 On-disk notebook matches UI selections after unmatch');

            logger.info('\n=== TEST PASSED ===');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
