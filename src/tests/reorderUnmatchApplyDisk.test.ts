/**
 * @file reorderUnmatchApplyDisk.test.ts
 * @description Integration test for unmatch -> resolve -> apply disk output.
 */

import * as vscode from 'vscode';
import type { Page } from 'playwright';
import {
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

    try {
        await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.whitespace', false, vscode.ConfigurationTarget.Workspace);

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
        await unmatchButtons.nth(1).click();
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

        console.log('\n=== Step 3: Resolve explicit mixed choices and capture independent expectation ===');
        const baseFixture = readNotebookFixtureFromRepo('09_reorder_base.ipynb');
        const currentFixture = readNotebookFixtureFromRepo('09_reorder_current.ipynb');
        const incomingFixture = readNotebookFixtureFromRepo('09_reorder_incoming.ipynb');
        const baseExpected = buildExpectedCellsFromNotebook(baseFixture);
        const currentExpected = buildExpectedCellsFromNotebook(currentFixture);
        const incomingExpected = buildExpectedCellsFromNotebook(incomingFixture);
        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictRowCount = await conflictRows.count();
        if (conflictRowCount !== 4) {
            throw new Error(`Expected 4 conflict rows after unmatching Beta, got ${conflictRowCount}`);
        }

        const selectors: Array<'.btn-resolve.btn-current' | '.btn-resolve.btn-incoming' | '.btn-resolve.btn-delete'> = [
            '.btn-resolve.btn-current',  // current-only Beta
            '.btn-resolve.btn-current',  // Alpha row
            '.btn-resolve.btn-incoming', // Gamma row
            '.btn-resolve.btn-delete',   // incoming-only Beta
        ];

        for (let i = 0; i < selectors.length; i++) {
            const row = conflictRows.nth(i);
            await row.locator(selectors[i]).click();
            await row.locator('.resolved-cell').waitFor({ timeout: 5000 });
        }

        const allResolved = await waitForAllConflictsResolved(page, 7000);
        if (allResolved.total <= 0 || allResolved.resolved !== allResolved.total) {
            throw new Error(`Expected all conflicts resolved, got ${allResolved.resolved}/${allResolved.total}`);
        }

        const renumberEnabled = await page
            .locator('label:has-text("Renumber execution counts") input[type="checkbox"]')
            .isChecked();
        const expectedCells = [
            withRowIndex(baseExpected[0], 0),
            withRowIndex(currentExpected[1], 1),
            withRowIndex(currentExpected[2], 2),
            withRowIndex(incomingExpected[2], 3),
            withRowIndex(baseExpected[4], 4),
        ];

        console.log('\n=== Step 4: Apply resolution and verify notebook on disk ===');
        const resolvedNotebook = await applyResolutionAndReadNotebook(page, session.conflictFile);
        assertNotebookMatches(expectedCells, resolvedNotebook, {
            expectedLabel: 'Expected explicit sequence after unmatching Beta',
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
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
