/**
 * @file reorderUnmatch.test.ts
 * @description Integration test for reordered cell detection, unmatch/rematch, and undo/redo.
 */

import * as vscode from 'vscode';
import type { Page } from 'playwright';
import {
    clickHistoryUndo,
    clickHistoryRedo,
    waitForAllConflictsResolved,
    waitForResolvedCount,
} from './integrationUtils';
import {
    applyResolutionAndReadNotebook,
    assertNotebookMatches,
    buildExpectedCellsFromNotebook,
    readTestConfig,
    readNotebookFixtureFromRepo,
    setupConflictResolver,
} from './testHarness';
import { validateNotebookStructure } from './testHelpers';

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

export async function run(): Promise<void> {
    console.log('Starting MergeNB Reorder Unmatch/Rematch Integration Test...');

    let browser;
    let page: Page | undefined;
    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousAutoResolveExecutionCount = mergeNBConfig.get<boolean>('autoResolve.executionCount');
    const previousStripOutputs = mergeNBConfig.get<boolean>('autoResolve.stripOutputs');
    const previousAutoResolveWhitespace = mergeNBConfig.get<boolean>('autoResolve.whitespace');
    const previousShowBaseColumn = mergeNBConfig.get<boolean>('ui.showBaseColumn');

    try {
        // Disable auto-resolve for deterministic results
        await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.whitespace', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('ui.showBaseColumn', false, vscode.ConfigurationTarget.Workspace);

        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        // === Step 1: Verify reorder indicators appear ===
        console.log('\n=== Step 1: Verify reorder indicators ===');
        await page.locator('.merge-row').first().waitFor({ timeout: 5000 });
        const reorderIndicators = page.locator('[data-testid="reorder-indicator"]');
        await reorderIndicators.first().waitFor({ timeout: 5000 });
        const indicatorCount = await reorderIndicators.count();
        console.log(`  Found ${indicatorCount} reorder indicator(s)`);
        if (indicatorCount === 0) {
            throw new Error('Expected at least one reorder indicator for reordered cells');
        }

        // Verify reordered-row class is present
        const reorderedRows = page.locator('.merge-row.reordered-row');
        await reorderedRows.first().waitFor({ timeout: 5000 });
        const reorderedCount = await reorderedRows.count();
        console.log(`  Found ${reorderedCount} reordered row(s)`);
        if (reorderedCount === 0) {
            throw new Error('Expected at least one .reordered-row');
        }

        // Verify unmatch buttons are present
        const unmatchButtons = page.locator('[data-testid="unmatch-btn"]');
        await unmatchButtons.first().waitFor({ timeout: 5000 });
        const unmatchBtnCount = await unmatchButtons.count();
        console.log(`  Found ${unmatchBtnCount} unmatch button(s)`);
        if (unmatchBtnCount === 0) {
            throw new Error('Expected at least one unmatch button');
        }
        console.log('  \u2713 Reorder indicators and unmatch buttons present');

        // === Step 2: Get conflict count before unmatch ===
        console.log('\n=== Step 2: Count conflicts before unmatch ===');
        const conflictCounterBefore = await waitForResolvedCount(page, 0, 5000);
        assertResolvedCount(conflictCounterBefore, 0, 'before unmatch');
        const totalBefore = conflictCounterBefore.total;
        console.log(`  Conflicts before unmatch: ${totalBefore}`);

        // === Step 3: Click Unmatch on first reordered row ===
        console.log('\n=== Step 3: Click Unmatch ===');
        const firstUnmatchBtn = unmatchButtons.first();
        await firstUnmatchBtn.scrollIntoViewIfNeeded();
        await firstUnmatchBtn.click();

        // Wait for user-unmatched rows to appear
        await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });

        const userUnmatchedRows = page.locator('.merge-row.user-unmatched-row');
        const unmatchedRowCount = await userUnmatchedRows.count();
        console.log(`  User-unmatched rows after unmatch: ${unmatchedRowCount}`);
        if (unmatchedRowCount === 0) {
            throw new Error('Expected user-unmatched rows after clicking Unmatch');
        }

        const remainingUnmatchButtons = await page.locator('[data-testid="unmatch-btn"]').count();
        if (remainingUnmatchButtons !== unmatchBtnCount - 1) {
            throw new Error(
                `Expected remaining reordered rows to stay unmatchable after first split (expected ${unmatchBtnCount - 1}, got ${remainingUnmatchButtons})`
            );
        }

        // Verify rematch buttons appear
        const rematchButtons = page.locator('[data-testid="rematch-btn"]');
        const rematchBtnCount = await rematchButtons.count();
        console.log(`  Rematch buttons visible: ${rematchBtnCount}`);
        if (rematchBtnCount === 0) {
            throw new Error('Expected rematch buttons on unmatched rows');
        }

        // Unmatch should only produce current-only and incoming-only rows —
        // no base-only rows should appear (base is reference context, not a
        // side the user resolves independently).
        const unmatchedBaseButtons = userUnmatchedRows.locator('.btn-resolve.btn-base');
        const baseButtonCount = await unmatchedBaseButtons.count();
        const baseColumnCount = await userUnmatchedRows.locator('.base-column').count();
        if (baseButtonCount !== 0 || baseColumnCount !== 0) {
            throw new Error(
                `Expected no base involvement in unmatched rows (baseButtons=${baseButtonCount}, baseColumns=${baseColumnCount})`
            );
        }

        // Verify conflict count increased
        const conflictCounterAfterUnmatch = await waitForResolvedCount(page, 0, 5000);
        assertResolvedCount(conflictCounterAfterUnmatch, 0, 'after unmatch');
        const totalAfterUnmatch = conflictCounterAfterUnmatch.total;
        console.log(`  Conflicts after unmatch: ${totalAfterUnmatch} (was ${totalBefore})`);
        if (totalAfterUnmatch <= totalBefore) {
            throw new Error(`Expected conflict count to increase after unmatch (was ${totalBefore}, now ${totalAfterUnmatch})`);
        }
        console.log('  \u2713 Unmatch created split rows with rematch buttons');

        // === Step 4: Resolve one split row ===
        console.log('\n=== Step 4: Resolve a split row ===');
        const firstSplitRow = userUnmatchedRows.first();
        await firstSplitRow.scrollIntoViewIfNeeded();

        // Find which button is available (the split row only has one side)
        const availableBtn = firstSplitRow.locator('.btn-resolve').first();
        await availableBtn.click();
        await firstSplitRow.locator('.resolved-cell').waitFor({ timeout: 5000 });
        console.log('  \u2713 Split row resolved');

        // === Step 5: Undo — verify unmatch is reverted ===
        console.log('\n=== Step 5: Undo unmatch ===');

        // Undo the resolution we just made
        await clickHistoryUndo(page);
        // Undo the unmatch itself
        await clickHistoryUndo(page);

        // Wait for unmatched rows to disappear
        const startWait = Date.now();
        while (Date.now() - startWait < 5000) {
            const remaining = await page.locator('.merge-row.user-unmatched-row').count();
            if (remaining === 0) break;
            await new Promise(r => setTimeout(r, 100));
        }

        const unmatchedAfterUndo = await page.locator('.merge-row.user-unmatched-row').count();
        if (unmatchedAfterUndo !== 0) {
            throw new Error(`Expected 0 user-unmatched rows after undo, got ${unmatchedAfterUndo}`);
        }

        // Verify conflict count went back
        const conflictCounterAfterUndo = await waitForResolvedCount(page, 0, 5000);
        assertResolvedCount(conflictCounterAfterUndo, 0, 'after undo');
        console.log(`  Conflicts after undo: ${conflictCounterAfterUndo.total} (original: ${totalBefore})`);
        if (conflictCounterAfterUndo.total !== totalBefore) {
            throw new Error(`Expected conflict count to revert to ${totalBefore} after undo, got ${conflictCounterAfterUndo.total}`);
        }
        console.log('  \u2713 Undo reverted unmatch');

        // === Step 6: Redo — verify unmatch is re-applied ===
        console.log('\n=== Step 6: Redo unmatch ===');
        await clickHistoryRedo(page);

        // Wait for user-unmatched rows to reappear
        await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });
        const unmatchedAfterRedo = await page.locator('.merge-row.user-unmatched-row').count();
        if (unmatchedAfterRedo === 0) {
            throw new Error('Expected user-unmatched rows after redo');
        }
        console.log('  \u2713 Redo re-applied unmatch');

        // === Step 7: Click Rematch ===
        console.log('\n=== Step 7: Click Rematch ===');
        const rematchBtn = page.locator('[data-testid="rematch-btn"]').first();
        await rematchBtn.scrollIntoViewIfNeeded();
        await rematchBtn.click();

        // Wait for user-unmatched rows to disappear
        const rematchWait = Date.now();
        while (Date.now() - rematchWait < 5000) {
            const remaining = await page.locator('.merge-row.user-unmatched-row').count();
            if (remaining === 0) break;
            await new Promise(r => setTimeout(r, 100));
        }

        const unmatchedAfterRematch = await page.locator('.merge-row.user-unmatched-row').count();
        if (unmatchedAfterRematch !== 0) {
            throw new Error(`Expected 0 user-unmatched rows after rematch, got ${unmatchedAfterRematch}`);
        }

        // Verify conflict count went back
        const conflictCounterAfterRematch = await waitForResolvedCount(page, 0, 5000);
        assertResolvedCount(conflictCounterAfterRematch, 0, 'after rematch');
        console.log(`  Conflicts after rematch: ${conflictCounterAfterRematch.total} (original: ${totalBefore})`);
        if (conflictCounterAfterRematch.total !== totalBefore) {
            throw new Error(`Expected conflict count to revert to ${totalBefore} after rematch, got ${conflictCounterAfterRematch.total}`);
        }
        console.log('  \u2713 Rematch restored original row');

        // === Step 8: Resolve with explicit mixed choices + verify notebook written to disk ===
        console.log('\n=== Step 8: Resolve with explicit mixed choices + verify disk output ===');
        const baseFixture = readNotebookFixtureFromRepo('09_reorder_base.ipynb');
        const currentFixture = readNotebookFixtureFromRepo('09_reorder_current.ipynb');
        const incomingFixture = readNotebookFixtureFromRepo('09_reorder_incoming.ipynb');
        const baseExpected = buildExpectedCellsFromNotebook(baseFixture);
        const currentExpected = buildExpectedCellsFromNotebook(currentFixture);
        const incomingExpected = buildExpectedCellsFromNotebook(incomingFixture);

        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictRowCount = await conflictRows.count();
        if (conflictRowCount !== 3) {
            throw new Error(`Expected 3 conflict rows after rematch, got ${conflictRowCount}`);
        }

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
        if (allResolved.total <= 0 || allResolved.resolved !== allResolved.total) {
            throw new Error(`Expected all conflicts resolved before apply, got ${allResolved.resolved}/${allResolved.total}`);
        }

        const renumberEnabled = await page
            .locator('label:has-text("Renumber execution counts") input[type="checkbox"]')
            .isChecked();
        const expectedCells = [
            withRowIndex(baseExpected[0], 0),
            withRowIndex(currentExpected[2], 1),
            withRowIndex(incomingExpected[3], 2),
            withRowIndex(currentExpected[3], 3),
            withRowIndex(baseExpected[4], 4),
        ];

        const resolvedNotebook = await applyResolutionAndReadNotebook(page, session.conflictFile);
        assertNotebookMatches(expectedCells, resolvedNotebook, {
            expectedLabel: 'Expected explicit sequence after rematch',
            compareMetadata: true,
            compareExecutionCounts: true,
            renumberEnabled,
        });
        validateNotebookStructure(resolvedNotebook);
        console.log('  \u2713 On-disk notebook matches UI selections after rematch');

        console.log('\n=== TEST PASSED ===');
    } finally {
        await mergeNBConfig.update(
            'autoResolve.executionCount',
            previousAutoResolveExecutionCount,
            vscode.ConfigurationTarget.Workspace
        );
        await mergeNBConfig.update(
            'autoResolve.stripOutputs',
            previousStripOutputs,
            vscode.ConfigurationTarget.Workspace
        );
        await mergeNBConfig.update(
            'autoResolve.whitespace',
            previousAutoResolveWhitespace,
            vscode.ConfigurationTarget.Workspace
        );
        await mergeNBConfig.update(
            'ui.showBaseColumn',
            previousShowBaseColumn,
            vscode.ConfigurationTarget.Workspace
        );
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
