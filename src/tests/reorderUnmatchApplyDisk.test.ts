/**
 * @file reorderUnmatchApplyDisk.test.ts
 * @description Integration test for unmatch -> resolve -> apply disk output.
 */

import * as vscode from 'vscode';
import type { Page } from 'playwright';
import {
    verifyAllConflictsMatchSide,
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

function withRowIndex<T extends { rowIndex: number }>(cell: T, rowIndex: number): T {
    return { ...cell, rowIndex };
}

export async function run(): Promise<void> {
    console.log('Starting MergeNB Reorder Unmatch -> Apply Integration Test...');

    let browser;
    let page: Page | undefined;
    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousAutoResolveExecutionCount = mergeNBConfig.get<boolean>('autoResolve.executionCount');
    const previousStripOutputs = mergeNBConfig.get<boolean>('autoResolve.stripOutputs');
    const previousAutoResolveWhitespace = mergeNBConfig.get<boolean>('autoResolve.whitespace');
    const previousShowBaseColumn = mergeNBConfig.get<boolean>('ui.showBaseColumn');

    try {
        await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.whitespace', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('ui.showBaseColumn', true, vscode.ConfigurationTarget.Workspace);

        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        console.log('\n=== Step 1: Verify unmatch is available ===');
        await page.locator('.merge-row').first().waitFor({ timeout: 5000 });
        const initialCounter = await waitForResolvedCount(page, 0, 5000);
        if (initialCounter.total <= 0) {
            throw new Error(`Expected initialized conflict counter, got ${initialCounter.resolved}/${initialCounter.total}`);
        }

        const unmatchButtons = page.locator('[data-testid="unmatch-btn"]');
        await unmatchButtons.first().waitFor({ timeout: 5000 });
        const unmatchBtnCount = await unmatchButtons.count();
        if (unmatchBtnCount <= 0) {
            throw new Error('Expected at least one unmatch button');
        }
        console.log(`  Found ${unmatchBtnCount} unmatch button(s)`);

        console.log('\n=== Step 2: Unmatch one reordered row ===');
        const betaConflictRow = page.locator('.merge-row.conflict-row').filter({ hasText: "print('beta')" });
        const betaUnmatchButton = betaConflictRow.locator('[data-testid="unmatch-btn"]');
        await betaUnmatchButton.waitFor({ timeout: 5000 });
        await betaUnmatchButton.click();
        await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });
        const afterUnmatchCounter = await waitForResolvedCount(page, 0, 5000);
        if (afterUnmatchCounter.total <= initialCounter.total) {
            throw new Error(
                `Expected conflict count to increase after unmatch (before=${initialCounter.total}, after=${afterUnmatchCounter.total})`
            );
        }
        console.log(`  Conflicts after unmatch: ${afterUnmatchCounter.total} (before: ${initialCounter.total})`);

        const remainingUnmatchButtons = await page.locator('[data-testid="unmatch-btn"]').count();
        if (remainingUnmatchButtons !== unmatchBtnCount - 1) {
            throw new Error(
                `Expected remaining reordered rows to stay unmatchable after first split (expected ${unmatchBtnCount - 1}, got ${remainingUnmatchButtons})`
            );
        }

        const allBaseButtonCount = await page.locator('button:has-text("All Base")').count();
        if (allBaseButtonCount !== 1) {
            throw new Error(`Expected global "All Base" button when showBaseColumn=true, got ${allBaseButtonCount}`);
        }

        const userUnmatchedRows = page.locator('.merge-row.user-unmatched-row');
        const unmatchedRowCount = await userUnmatchedRows.count();
        if (unmatchedRowCount !== 2) {
            throw new Error(`Expected 2 user-unmatched rows after splitting Beta, got ${unmatchedRowCount}`);
        }

        const splitRowBaseColumns = await userUnmatchedRows.locator('.base-column').count();
        if (splitRowBaseColumns !== unmatchedRowCount) {
            throw new Error(
                `Expected each split row to keep a visible base column placeholder (expected ${unmatchedRowCount}, got ${splitRowBaseColumns})`
            );
        }

        const splitRowBaseButtons = await userUnmatchedRows.locator('.btn-resolve.btn-base').count();
        if (splitRowBaseButtons !== 0) {
            throw new Error(`Expected split rows to hide "Use Base" despite showBaseColumn=true, got ${splitRowBaseButtons} buttons`);
        }

        const splitRowBasePlaceholders = await userUnmatchedRows.locator('.base-column .placeholder-text').allTextContents();
        if (splitRowBasePlaceholders.length !== unmatchedRowCount) {
            throw new Error(
                `Expected ${unmatchedRowCount} base-column placeholders on split rows, got ${splitRowBasePlaceholders.length}`
            );
        }
        if (splitRowBasePlaceholders.some(text => text.trim() !== '(unmatched cell)')) {
            throw new Error(
                `Expected split-row base placeholders to read "(unmatched cell)", got ${JSON.stringify(splitRowBasePlaceholders)}`
            );
        }

        console.log('\n=== Step 3: Accept all current and capture independent expectation ===');
        const baseFixture = readNotebookFixtureFromRepo('09_reorder_base.ipynb');
        const currentFixture = readNotebookFixtureFromRepo('09_reorder_current.ipynb');
        const baseExpected = buildExpectedCellsFromNotebook(baseFixture);
        const currentExpected = buildExpectedCellsFromNotebook(currentFixture);
        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictRowCount = await conflictRows.count();
        if (conflictRowCount !== 4) {
            throw new Error(`Expected 4 conflict rows after unmatching Beta, got ${conflictRowCount}`);
        }

        await page.locator('button:has-text("All Current")').click();
        const currentAcceptance = await verifyAllConflictsMatchSide(page, 'current');
        if (currentAcceptance.mismatches.length > 0) {
            throw new Error(
                `Expected "All Current" to resolve split rows to current/delete correctly:\n${currentAcceptance.mismatches.join('\n')}`
            );
        }
        if (currentAcceptance.matchCount !== 3 || currentAcceptance.deleteCount !== 1) {
            throw new Error(
                `Expected "All Current" after splitting Beta to resolve 3 rows to current and 1 to delete, got current=${currentAcceptance.matchCount}, delete=${currentAcceptance.deleteCount}`
            );
        }

        const allResolved = await waitForAllConflictsResolved(page, 7000);
        if (allResolved.total <= 0 || allResolved.resolved !== allResolved.total) {
            throw new Error(`Expected all conflicts resolved, got ${allResolved.resolved}/${allResolved.total}`);
        }

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

        console.log('\n=== Step 4: Apply resolution and verify notebook on disk ===');
        const resolvedNotebook = await applyResolutionAndReadNotebook(page, session.conflictFile);
        assertNotebookMatches(expectedCells, resolvedNotebook, {
            expectedLabel: 'Expected All Current sequence after unmatching Beta',
            compareMetadata: true,
            compareExecutionCounts: true,
            renumberEnabled,
        });
        validateNotebookStructure(resolvedNotebook);
        console.log('  \u2713 On-disk notebook matches UI selections after unmatch');

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
