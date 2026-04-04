/**
 * @file reorderUnmatch.spec.ts
 * @description Playwright Test for reordered cell detection, unmatch/rematch, and undo/redo.
 */

import type { Page } from 'playwright';
import { test, expect } from './fixtures';
import * as logger from '../../core/src';
import {
    clickHistoryUndo,
    clickHistoryRedo,
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

function assertResolvedCount(
    count: { resolved: number; total: number },
    expectedResolved: number,
    stage: string
): void {
    if (count.total <= 0) {
        throw new Error(`Expected conflict counter to be initialized ${stage}, got ${count.resolved}/${count.total}`);
    }
    if (count.resolved !== expectedResolved) {
        throw new Error(`Expected resolved count ${expectedResolved} ${stage}, got ${count.resolved}/${count.total}`);
    }
}

function withRowIndex<T extends { rowIndex: number }>(cell: T, rowIndex: number): T {
    return { ...cell, rowIndex };
}

async function waitForUserUnmatchedRowsToDisappear(page: Page, timeoutMs = 5000): Promise<void> {
    const startWait = Date.now();
    while (Date.now() - startWait < timeoutMs) {
        const remaining = await page.locator('.merge-row.user-unmatched-row').count();
        if (remaining === 0) {
            return;
        }
        await new Promise(r => setTimeout(r, 100));
    }

    const remaining = await page.locator('.merge-row.user-unmatched-row').count();
    if (remaining !== 0) {
        throw new Error(`Expected 0 user-unmatched rows after waiting, got ${remaining}`);
    }
}

// ─── Test Definitions ───────────────────────────────────────────────────────

test.describe('Reorder Unmatch/Rematch', () => {
    test('Unmatch/rematch reordered cells with undo/redo + disk verification', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting MergeNB Reorder Unmatch/Rematch Integration Test...');

        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            // Disable auto-resolve for deterministic results
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
                'ui.showBaseColumn': false,
            });

            const workspacePath = conflictRepo({
                base: '09_reorder_base.ipynb',
                current: '09_reorder_current.ipynb',
                incoming: '09_reorder_incoming.ipynb',
            });

            const session = await conflictSession(workspacePath);
            const { page, conflictFile } = session;

            // === Step 1: Verify reorder indicators appear ===
            logger.info('\n=== Step 1: Verify reorder indicators ===');
            await page.locator('.merge-row').first().waitFor({ timeout: 5000 });
            const reorderIndicators = page.locator('[data-testid="reorder-indicator"]');
            await reorderIndicators.first().waitFor({ timeout: 5000 });
            const indicatorCount = await reorderIndicators.count();
            logger.info(`  Found ${indicatorCount} reorder indicator(s)`);
            expect(indicatorCount).toBeGreaterThan(0);

            // Verify reordered-row class is present
            const reorderedRows = page.locator('.merge-row.reordered-row');
            await reorderedRows.first().waitFor({ timeout: 5000 });
            const reorderedCount = await reorderedRows.count();
            logger.info(`  Found ${reorderedCount} reordered row(s)`);
            expect(reorderedCount).toBeGreaterThan(0);

            // Verify unmatch buttons are present
            const unmatchButtons = page.locator('[data-testid="unmatch-btn"]');
            await unmatchButtons.first().waitFor({ timeout: 5000 });
            const unmatchBtnCount = await unmatchButtons.count();
            logger.info(`  Found ${unmatchBtnCount} unmatch button(s)`);
            expect(unmatchBtnCount).toBeGreaterThan(0);
            logger.info('  \u2713 Reorder indicators and unmatch buttons present');

            // === Step 2: Get conflict count before unmatch ===
            logger.info('\n=== Step 2: Count conflicts before unmatch ===');
            const conflictCounterBefore = await waitForResolvedCount(page, 0, 5000);
            assertResolvedCount(conflictCounterBefore, 0, 'before unmatch');
            const totalBefore = conflictCounterBefore.total;
            logger.info(`  Conflicts before unmatch: ${totalBefore}`);

            // === Step 3: Click Unmatch on first reordered row ===
            logger.info('\n=== Step 3: Click Unmatch ===');
            const alphaConflictRow = page.locator('.merge-row.conflict-row').filter({ hasText: 'alpha modified' });
            await alphaConflictRow.waitFor({ timeout: 5000 });
            const alphaUnmatchBtn = alphaConflictRow.locator('[data-testid="unmatch-btn"]');
            await alphaUnmatchBtn.scrollIntoViewIfNeeded();
            await alphaUnmatchBtn.click();

            // Wait for user-unmatched rows to appear
            await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });

            const userUnmatchedRows = page.locator('.merge-row.user-unmatched-row');
            const unmatchedRowCount = await userUnmatchedRows.count();
            logger.info(`  User-unmatched rows after unmatch: ${unmatchedRowCount}`);
            expect(unmatchedRowCount).toBeGreaterThan(0);

            const remainingUnmatchButtons = await page.locator('[data-testid="unmatch-btn"]').count();
            expect(remainingUnmatchButtons).toBe(unmatchBtnCount - 1);

            // Verify rematch buttons appear
            const rematchButtons = page.locator('[data-testid="rematch-btn"]');
            const rematchBtnCount = await rematchButtons.count();
            logger.info(`  Rematch buttons visible: ${rematchBtnCount}`);
            expect(rematchBtnCount).toBeGreaterThan(0);

            // Unmatch should only produce current-only and incoming-only rows
            const unmatchedBaseButtons = userUnmatchedRows.locator('.btn-resolve.btn-base');
            const baseButtonCount = await unmatchedBaseButtons.count();
            const baseColumnCount = await userUnmatchedRows.locator('.base-column').count();
            expect(baseButtonCount).toBe(0);
            expect(baseColumnCount).toBe(0);

            // Verify conflict count increased
            const conflictCounterAfterUnmatch = await waitForResolvedCount(page, 0, 5000);
            assertResolvedCount(conflictCounterAfterUnmatch, 0, 'after unmatch');
            const totalAfterUnmatch = conflictCounterAfterUnmatch.total;
            logger.info(`  Conflicts after unmatch: ${totalAfterUnmatch} (was ${totalBefore})`);
            expect(totalAfterUnmatch).toBeGreaterThan(totalBefore);
            logger.info('  \u2713 Unmatch created split rows with rematch buttons');

            // === Step 4: Resolve one split row ===
            logger.info('\n=== Step 4: Resolve a split row ===');
            const firstSplitRow = userUnmatchedRows.first();
            await firstSplitRow.scrollIntoViewIfNeeded();

            // Find which button is available (the split row only has one side)
            const availableBtn = firstSplitRow.locator('.btn-resolve').first();
            await availableBtn.click();
            await firstSplitRow.locator('.resolved-cell').waitFor({ timeout: 5000 });
            logger.info('  \u2713 Split row resolved');

            // === Step 5: Undo — verify unmatch is reverted ===
            logger.info('\n=== Step 5: Undo unmatch ===');

            // Undo the resolution we just made
            await clickHistoryUndo(page);
            // Undo the unmatch itself
            await clickHistoryUndo(page);

            // Wait for unmatched rows to disappear
            await waitForUserUnmatchedRowsToDisappear(page);

            // Verify conflict count went back
            const conflictCounterAfterUndo = await waitForResolvedCount(page, 0, 5000);
            assertResolvedCount(conflictCounterAfterUndo, 0, 'after undo');
            logger.info(`  Conflicts after undo: ${conflictCounterAfterUndo.total} (original: ${totalBefore})`);
            expect(conflictCounterAfterUndo.total).toBe(totalBefore);
            logger.info('  \u2713 Undo reverted unmatch');

            // === Step 6: Redo — verify unmatch is re-applied ===
            logger.info('\n=== Step 6: Redo unmatch ===');
            await clickHistoryRedo(page);

            // Wait for user-unmatched rows to reappear
            await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });
            const unmatchedAfterRedo = await page.locator('.merge-row.user-unmatched-row').count();
            expect(unmatchedAfterRedo).toBeGreaterThan(0);
            logger.info('  \u2713 Redo re-applied unmatch');

            // === Step 7: Click Rematch ===
            logger.info('\n=== Step 7: Click Rematch ===');
            const rematchBtn = page.locator('[data-testid="rematch-btn"]').first();
            await rematchBtn.scrollIntoViewIfNeeded();
            await rematchBtn.click();

            // Wait for user-unmatched rows to disappear
            await waitForUserUnmatchedRowsToDisappear(page);

            // Verify conflict count went back
            const conflictCounterAfterRematch = await waitForResolvedCount(page, 0, 5000);
            assertResolvedCount(conflictCounterAfterRematch, 0, 'after rematch');
            logger.info(`  Conflicts after rematch: ${conflictCounterAfterRematch.total} (original: ${totalBefore})`);
            expect(conflictCounterAfterRematch.total).toBe(totalBefore);
            logger.info('  \u2713 Rematch restored original row');

            // === Step 7b: Unmatch the restored Alpha row again ===
            logger.info('\n=== Step 7b: Unmatch restored row again ===');
            const restoredAlphaRow = page.locator('.merge-row.conflict-row').filter({ hasText: 'alpha modified' });
            const restoredAlphaUnmatchBtn = restoredAlphaRow.locator('[data-testid="unmatch-btn"]');
            await restoredAlphaUnmatchBtn.waitFor({ timeout: 5000 });
            await restoredAlphaUnmatchBtn.scrollIntoViewIfNeeded();
            await restoredAlphaUnmatchBtn.click();
            await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });

            const unmatchedAfterSecondUnmatch = await page.locator('.merge-row.user-unmatched-row').count();
            expect(unmatchedAfterSecondUnmatch).toBe(unmatchedRowCount);

            const rematchAfterSecondUnmatch = page.locator('[data-testid="rematch-btn"]').first();
            await rematchAfterSecondUnmatch.scrollIntoViewIfNeeded();
            await rematchAfterSecondUnmatch.click();
            await waitForUserUnmatchedRowsToDisappear(page);

            const conflictCounterAfterSecondRematch = await waitForResolvedCount(page, 0, 5000);
            assertResolvedCount(conflictCounterAfterSecondRematch, 0, 'after second rematch');
            expect(conflictCounterAfterSecondRematch.total).toBe(totalBefore);
            logger.info('  \u2713 Restored row stayed unmatchable after rematch');

            // === Step 8: Resolve with explicit mixed choices + verify notebook written to disk ===
            logger.info('\n=== Step 8: Resolve with explicit mixed choices + verify disk output ===');
            const baseFixture = readNotebookFixtureFromRepo('09_reorder_base.ipynb');
            const currentFixture = readNotebookFixtureFromRepo('09_reorder_current.ipynb');
            const incomingFixture = readNotebookFixtureFromRepo('09_reorder_incoming.ipynb');
            const baseExpected = buildExpectedCellsFromNotebook(baseFixture);
            const currentExpected = buildExpectedCellsFromNotebook(currentFixture);
            const incomingExpected = buildExpectedCellsFromNotebook(incomingFixture);

            const conflictRows = page.locator('.merge-row.conflict-row');
            const conflictRowCount = await conflictRows.count();
            expect(conflictRowCount).toBe(3);

            const selectors: Array<'.btn-resolve.btn-current' | '.btn-resolve.btn-incoming'> = [
                '.btn-resolve.btn-current',  // Alpha row
                '.btn-resolve.btn-incoming', // Beta row
                '.btn-resolve.btn-current',  // Gamma row
            ];

            for (let i = 0; i < selectors.length; i++) {
                const row = conflictRows.nth(i);
                await row.locator(selectors[i]).click();
                await row.locator('.resolved-cell').waitFor({ timeout: 5000 });
            }

            const allResolved = await waitForAllConflictsResolved(page, 7000);
            expect(allResolved.total).toBeGreaterThan(0);
            expect(allResolved.resolved).toBe(allResolved.total);

            const renumberEnabled = await page
                .locator('label:has-text("Renumber execution counts") input[type="checkbox"]')
                .isChecked();

            // Fixture layout:
            //   base:     [intro, alpha, beta, gamma, outro]
            //   current:  [intro, beta, alpha(modified), gamma, outro]
            //   incoming: [intro, alpha, gamma, beta, outro]
            const expectedCells = [
                withRowIndex(baseExpected[0], 0),      // intro
                withRowIndex(currentExpected[2], 1),   // alpha from current (modified)
                withRowIndex(incomingExpected[3], 2),  // beta from incoming
                withRowIndex(currentExpected[3], 3),   // gamma from current
                withRowIndex(baseExpected[4], 4),      // outro
            ];

            const resolvedNotebook = await applyResolutionAndReadNotebook(page, conflictFile);
            assertNotebookMatches(expectedCells, resolvedNotebook, {
                expectedLabel: 'Expected explicit sequence after rematch',
                compareMetadata: true,
                compareExecutionCounts: true,
                renumberEnabled,
            });
            validateNotebookStructure(resolvedNotebook);
            logger.info('  \u2713 On-disk notebook matches UI selections after rematch');

            logger.info('\n=== TEST PASSED ===');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
