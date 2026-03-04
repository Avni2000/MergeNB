/**
 * @file reorderUnmatchApplyDisk.test.ts
 * @description Integration test for unmatch -> resolve -> apply disk output.
 */

import * as vscode from 'vscode';
import type { Page } from 'playwright';
import {
    collectExpectedCellsFromUI,
    waitForAllConflictsResolved,
    waitForResolvedCount,
} from './integrationUtils';
import {
    applyResolutionAndReadNotebook,
    assertNotebookMatches,
    readTestConfig,
    setupConflictResolver,
} from './testHarness';
import { validateNotebookStructure } from './testHelpers';

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
        await unmatchButtons.first().click();
        await page.locator('.merge-row.user-unmatched-row').first().waitFor({ timeout: 5000 });
        const afterUnmatchCounter = await waitForResolvedCount(page, 0, 5000);
        if (afterUnmatchCounter.total <= initialCounter.total) {
            throw new Error(
                `Expected conflict count to increase after unmatch (before=${initialCounter.total}, after=${afterUnmatchCounter.total})`
            );
        }
        console.log(`  Conflicts after unmatch: ${afterUnmatchCounter.total} (before: ${initialCounter.total})`);

        console.log('\n=== Step 3: Resolve all and capture expected UI output ===');
        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictRowCount = await conflictRows.count();
        const selectedChoices = new Map<number, 'current' | 'incoming' | 'delete'>();

        for (let i = 0; i < conflictRowCount; i++) {
            const row = conflictRows.nth(i);
            const hasCurrent = await row.locator('.btn-resolve.btn-current').count() > 0;
            const hasIncoming = await row.locator('.btn-resolve.btn-incoming').count() > 0;
            const preferIncoming = i % 2 === 0;

            const choice: 'current' | 'incoming' | 'delete' = preferIncoming
                ? (hasIncoming ? 'incoming' : hasCurrent ? 'current' : 'delete')
                : (hasCurrent ? 'current' : hasIncoming ? 'incoming' : 'delete');

            const selector = choice === 'current'
                ? '.btn-resolve.btn-current'
                : choice === 'incoming'
                    ? '.btn-resolve.btn-incoming'
                    : '.btn-resolve.btn-delete';
            await row.locator(selector).click();
            await row.locator('.resolved-cell').waitFor({ timeout: 5000 });
            selectedChoices.set(i, choice);
        }

        const allResolved = await waitForAllConflictsResolved(page, 7000);
        if (allResolved.total <= 0 || allResolved.resolved !== allResolved.total) {
            throw new Error(`Expected all conflicts resolved, got ${allResolved.resolved}/${allResolved.total}`);
        }

        const renumberEnabled = await page
            .locator('label:has-text("Renumber execution counts") input[type="checkbox"]')
            .isChecked();

        const expectedCells = await collectExpectedCellsFromUI(page, {
            resolveConflictChoice: async (_row, conflictIndex, rowIndex) => {
                const choice = selectedChoices.get(conflictIndex);
                if (!choice) {
                    throw new Error(`Row ${rowIndex}: missing stored choice for conflict index ${conflictIndex}`);
                }
                return { choice };
            },
            includeMetadata: true,
            includeOutputs: true,
        });
        const expectedNonDeleted = expectedCells.filter(c => !c.isDeleted);

        console.log('\n=== Step 4: Apply resolution and verify notebook on disk ===');
        const resolvedNotebook = await applyResolutionAndReadNotebook(page, session.conflictFile);
        assertNotebookMatches(expectedNonDeleted, resolvedNotebook, {
            expectedLabel: 'Expected from UI after unmatch',
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
