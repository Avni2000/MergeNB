/**
 * @file reorderUnmatch.test.ts
 * @description Integration test for reordered cell detection, unmatch/rematch, and undo/redo.
 */

import * as vscode from 'vscode';
import type { Page } from 'playwright';
import {
    clickHistoryUndo,
    clickHistoryRedo,
    waitForResolvedCount,
} from './integrationUtils';
import {
    readTestConfig,
    setupConflictResolver,
} from './testHarness';

export async function run(): Promise<void> {
    console.log('Starting MergeNB Reorder Unmatch/Rematch Integration Test...');

    let browser;
    let page: Page | undefined;
    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousAutoResolveExecutionCount = mergeNBConfig.get<boolean>('autoResolve.executionCount');
    const previousStripOutputs = mergeNBConfig.get<boolean>('autoResolve.stripOutputs');
    const previousAutoResolveWhitespace = mergeNBConfig.get<boolean>('autoResolve.whitespace');

    try {
        // Disable auto-resolve for deterministic results
        await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.whitespace', false, vscode.ConfigurationTarget.Workspace);

        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        // === Step 1: Verify reorder indicators appear ===
        console.log('\n=== Step 1: Verify reorder indicators ===');
        const reorderIndicators = page.locator('[data-testid="reorder-indicator"]');
        const indicatorCount = await reorderIndicators.count();
        console.log(`  Found ${indicatorCount} reorder indicator(s)`);
        if (indicatorCount === 0) {
            throw new Error('Expected at least one reorder indicator for reordered cells');
        }

        // Verify reordered-row class is present
        const reorderedRows = page.locator('.merge-row.reordered-row');
        const reorderedCount = await reorderedRows.count();
        console.log(`  Found ${reorderedCount} reordered row(s)`);
        if (reorderedCount === 0) {
            throw new Error('Expected at least one .reordered-row');
        }

        // Verify unmatch buttons are present
        const unmatchButtons = page.locator('[data-testid="unmatch-btn"]');
        const unmatchBtnCount = await unmatchButtons.count();
        console.log(`  Found ${unmatchBtnCount} unmatch button(s)`);
        if (unmatchBtnCount === 0) {
            throw new Error('Expected at least one unmatch button');
        }
        console.log('  \u2713 Reorder indicators and unmatch buttons present');

        // === Step 2: Get conflict count before unmatch ===
        console.log('\n=== Step 2: Count conflicts before unmatch ===');
        const conflictCounterBefore = await waitForResolvedCount(page, 0, 5000);
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

        // Verify rematch buttons appear
        const rematchButtons = page.locator('[data-testid="rematch-btn"]');
        const rematchBtnCount = await rematchButtons.count();
        console.log(`  Rematch buttons visible: ${rematchBtnCount}`);
        if (rematchBtnCount === 0) {
            throw new Error('Expected rematch buttons on unmatched rows');
        }

        // Verify conflict count increased
        const conflictCounterAfterUnmatch = await waitForResolvedCount(page, 0, 5000);
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
        console.log(`  Conflicts after rematch: ${conflictCounterAfterRematch.total} (original: ${totalBefore})`);
        if (conflictCounterAfterRematch.total !== totalBefore) {
            throw new Error(`Expected conflict count to revert to ${totalBefore} after rematch, got ${conflictCounterAfterRematch.total}`);
        }
        console.log('  \u2713 Rematch restored original row');

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
