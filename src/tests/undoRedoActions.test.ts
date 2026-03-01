/**
 * @file undoRedoActions.test.ts
 * @description Integration test covering undo/redo for conflict resolver actions.
 */

import * as vscode from 'vscode';
import type { Page, Locator } from 'playwright';
import {
    clickHistoryUndo,
    clickHistoryRedo,
    waitForResolvedCount,
    type MergeSide,
} from './integrationUtils';
import {
    readTestConfig,
    setupConflictResolver,
} from './testHarness';

async function pickBranchButton(row: Locator): Promise<{ selector: string; side: MergeSide }> {
    const options: Array<{ selector: string; side: MergeSide }> = [
        { selector: '.btn-current', side: 'current' },
        { selector: '.btn-incoming', side: 'incoming' },
        { selector: '.btn-base', side: 'base' },
    ];

    for (const option of options) {
        if (await row.locator(option.selector).count() > 0) {
            return option;
        }
    }

    throw new Error('No branch selection buttons found for conflict row');
}



export async function run(): Promise<void> {
    console.log('Starting MergeNB Undo/Redo Actions Integration Test...');

    let browser;
    let page: Page | undefined;
    const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousAutoResolveExecutionCount = mergeNBConfig.get<boolean>('autoResolve.executionCount');
    const previousStripOutputs = mergeNBConfig.get<boolean>('autoResolve.stripOutputs');
    const previousAutoResolveWhitespace = mergeNBConfig.get<boolean>('autoResolve.whitespace');

    try {
        // Keep manual undo/redo scenarios deterministic despite auto-resolve defaults.
        await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.whitespace', false, vscode.ConfigurationTarget.Workspace);

        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRows.count();
        console.log(`Found ${conflictCount} conflict rows`);

        if (conflictCount === 0) {
            throw new Error('Expected at least one conflict row');
        }

        // Action 1: branch selection + keyboard undo/redo
        console.log('\n=== Undo/Redo: Branch Selection (Keyboard) ===');
        const firstRow = conflictRows.nth(0);
        await firstRow.scrollIntoViewIfNeeded();
        const branchChoice = await pickBranchButton(firstRow);
        await firstRow.locator(branchChoice.selector).click();
        await firstRow.locator('.resolved-content-input').waitFor({ timeout: 5000 });

        await page.click('.header-title');
        await page.keyboard.press(`${primaryModifier}+Z`);
        await firstRow.locator('.resolved-content-input').waitFor({ state: 'detached', timeout: 5000 });

        await page.click('.header-title');
        await page.keyboard.press(`${primaryModifier}+Shift+Z`);
        await firstRow.locator('.resolved-content-input').waitFor({ timeout: 5000 });
        console.log('  ✓ Keyboard undo/redo toggled branch selection');

        // Action 2: delete selection + header undo/redo
        console.log('\n=== Undo/Redo: Delete Selection (Header Buttons) ===');
        const deleteRow = conflictRows.nth(conflictCount > 1 ? 1 : 0);
        await deleteRow.scrollIntoViewIfNeeded();
        await deleteRow.locator('.btn-delete').click();
        await deleteRow.locator('.resolved-deleted').waitFor({ timeout: 5000 });

        await clickHistoryUndo(page);
        await deleteRow.locator('.resolved-deleted').waitFor({ state: 'detached', timeout: 5000 });

        await clickHistoryRedo(page);
        await deleteRow.locator('.resolved-deleted').waitFor({ timeout: 5000 });
        console.log('  ✓ Header undo/redo toggled delete resolution');

        // Action 3: edit content + undo/redo
        console.log('\n=== Undo/Redo: Content Edit ===');
        await firstRow.scrollIntoViewIfNeeded();
        if (await firstRow.locator('.resolved-content-input').count() === 0) {
            await firstRow.locator(branchChoice.selector).click();
            await firstRow.locator('.resolved-content-input').waitFor({ timeout: 5000 });
        }
        const textarea = firstRow.locator('.resolved-content-input');
        await textarea.waitFor({ timeout: 5000 });
        const original = await textarea.inputValue();
        const edited = `${original}\n(edited)`;
        await textarea.fill(edited);
        await textarea.blur();

        await clickHistoryUndo(page);
        const afterUndo = await textarea.inputValue();
        if (afterUndo !== original) {
            throw new Error('Undo did not restore original content after edit');
        }

        await clickHistoryRedo(page);
        const afterRedo = await textarea.inputValue();
        if (afterRedo !== edited) {
            throw new Error('Redo did not restore edited content after edit');
        }
        console.log('  ✓ Undo/redo restored edited content');

        // Action 4: toggle checkboxes + undo/redo
        console.log('\n=== Undo/Redo: Toggle Options ===');
        const renumberCheckbox = page.locator('label:has-text("Renumber execution counts") input[type="checkbox"]');
        const markCheckbox = page.locator('label:has-text("Mark as resolved") input[type="checkbox"]');

        const initialRenumber = await renumberCheckbox.isChecked();
        await renumberCheckbox.click();
        const toggledRenumber = await renumberCheckbox.isChecked();
        if (toggledRenumber === initialRenumber) {
            throw new Error('Renumber checkbox did not toggle');
        }
        await clickHistoryUndo(page);
        if (await renumberCheckbox.isChecked() !== initialRenumber) {
            throw new Error('Undo did not revert renumber checkbox');
        }
        await clickHistoryRedo(page);
        if (await renumberCheckbox.isChecked() !== toggledRenumber) {
            throw new Error('Redo did not reapply renumber checkbox');
        }

        const initialMark = await markCheckbox.isChecked();
        await markCheckbox.click();
        const toggledMark = await markCheckbox.isChecked();
        if (toggledMark === initialMark) {
            throw new Error('Mark-as-resolved checkbox did not toggle');
        }
        await clickHistoryUndo(page);
        if (await markCheckbox.isChecked() !== initialMark) {
            throw new Error('Undo did not revert mark-as-resolved checkbox');
        }
        await clickHistoryRedo(page);
        if (await markCheckbox.isChecked() !== toggledMark) {
            throw new Error('Redo did not reapply mark-as-resolved checkbox');
        }
        console.log('  ✓ Undo/redo restored checkbox states');


        console.log('\n=== History Timeline Jump ===');
        await page.locator('[data-testid="history-toggle"]').click();
        const historyItems = page.locator('[data-testid="history-item"]');
        const historyCount = await historyItems.count();
        if (historyCount === 0) {
            throw new Error('History list is empty');
        }
        await historyItems.nth(0).click();

        const resolvedAfterJump = await waitForResolvedCount(page, 0, 5000);
        if (resolvedAfterJump.resolved !== 0) {
            throw new Error(`Expected 0 resolved after jumping to initial history, got ${resolvedAfterJump.resolved}`);
        }
        console.log('  ✓ History jump restored initial state');

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
