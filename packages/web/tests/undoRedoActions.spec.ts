/**
 * @file undoRedoActions.spec.ts
 * @description Playwright Test covering undo/redo for conflict resolver actions.
 *
 * Tests keyboard shortcuts (Ctrl+Z, Ctrl+Shift+Z), history panel buttons,
 * content edits, checkbox toggles, and history timeline jumps.
 */

import type { Locator } from 'playwright';
import { test, expect } from './fixtures';
import * as logger from '../../core/src';
import {
    clickHistoryUndo,
    clickHistoryRedo,
    waitForResolvedCount,
    getResolvedEditorValue,
    fillResolvedEditor,
    type MergeSide,
} from '../../../test-fixtures/shared/integrationUtils';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from '../../../apps/vscode-extension/tests/settingsFile';

// ─── Helper Functions ───────────────────────────────────────────────────────

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

async function waitForResolvedEditorText(
    textarea: Locator,
    expected: string,
    timeoutMs = 5000,
    pollMs = 100,
): Promise<string> {
    const start = Date.now();
    let last = await getResolvedEditorValue(textarea);

    while (Date.now() - start < timeoutMs) {
        last = await getResolvedEditorValue(textarea);
        if (last === expected) {
            return last;
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }

    return last;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

test.describe('Undo/Redo Actions', () => {
    test('Undo/redo actions (02 notebooks)', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting MergeNB Undo/Redo Actions Integration Test...');

        const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            // Keep manual undo/redo scenarios deterministic despite auto-resolve defaults.
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            // Create merge conflict repo
            const workspacePath = conflictRepo({
                base: '02_base.ipynb',
                current: '02_current.ipynb',
                incoming: '02_incoming.ipynb',
            });

            // Set up conflict resolver
            const session = await conflictSession(workspacePath);
            const { page } = session;

            const conflictRows = page.locator('.merge-row.conflict-row');
            const conflictCount = await conflictRows.count();
            logger.info(`Found ${conflictCount} conflict rows`);

            expect(conflictCount).toBeGreaterThan(0);

            // Action 1: branch selection + keyboard undo/redo
            logger.info('\n=== Undo/Redo: Branch Selection (Keyboard) ===');
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
            logger.info('  ✓ Keyboard undo/redo toggled branch selection');

            // Action 2: delete selection + header undo/redo
            logger.info('\n=== Undo/Redo: Delete Selection (Header Buttons) ===');
            const deleteRow = conflictRows.nth(conflictCount > 1 ? 1 : 0);
            await deleteRow.scrollIntoViewIfNeeded();
            await deleteRow.locator('.btn-delete').click();
            await deleteRow.locator('.resolved-deleted').waitFor({ timeout: 5000 });

            await clickHistoryUndo(page);
            await deleteRow.locator('.resolved-deleted').waitFor({ state: 'detached', timeout: 5000 });

            await clickHistoryRedo(page);
            await deleteRow.locator('.resolved-deleted').waitFor({ timeout: 5000 });
            logger.info('  ✓ Header undo/redo toggled delete resolution');

            // Action 3: edit content + undo/redo
            logger.info('\n=== Undo/Redo: Content Edit ===');
            await firstRow.scrollIntoViewIfNeeded();
            if (await firstRow.locator('.resolved-content-input').count() === 0) {
                await firstRow.locator(branchChoice.selector).click();
                await firstRow.locator('.resolved-content-input').waitFor({ timeout: 5000 });
            }
            const textarea = firstRow.locator('.resolved-content-input');
            await textarea.waitFor({ timeout: 5000 });
            const original = await getResolvedEditorValue(textarea);
            const edited = `${original}\n(edited)`;
            const historyItemsForEdit = page.locator('[data-testid="history-item"]');
            const historyCountBeforeEdit = await historyItemsForEdit.count();
            await fillResolvedEditor(textarea, edited);
            await textarea.locator('.cm-content').blur();

            const historyCommitStart = Date.now();
            while (Date.now() - historyCommitStart < 5000) {
                if (await historyItemsForEdit.count() > historyCountBeforeEdit) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            await clickHistoryUndo(page);
            const afterUndo = await waitForResolvedEditorText(textarea, original);
            expect(afterUndo).toBe(original);

            await clickHistoryRedo(page);
            const afterRedo = await waitForResolvedEditorText(textarea, edited);
            expect(afterRedo).toBe(edited);
            logger.info('  ✓ Undo/redo restored edited content');

            // Action 4: toggle checkboxes + undo/redo
            logger.info('\n=== Undo/Redo: Toggle Options ===');
            const renumberCheckbox = page.locator('label:has-text("Renumber execution counts") input[type="checkbox"]');
            const markCheckbox = page.locator('label:has-text("Mark as resolved") input[type="checkbox"]');

            const initialRenumber = await renumberCheckbox.isChecked();
            await renumberCheckbox.click();
            const toggledRenumber = await renumberCheckbox.isChecked();
            expect(toggledRenumber).not.toBe(initialRenumber);

            await clickHistoryUndo(page);
            expect(await renumberCheckbox.isChecked()).toBe(initialRenumber);

            await clickHistoryRedo(page);
            expect(await renumberCheckbox.isChecked()).toBe(toggledRenumber);

            const initialMark = await markCheckbox.isChecked();
            await markCheckbox.click();
            const toggledMark = await markCheckbox.isChecked();
            expect(toggledMark).not.toBe(initialMark);

            await clickHistoryUndo(page);
            expect(await markCheckbox.isChecked()).toBe(initialMark);

            await clickHistoryRedo(page);
            expect(await markCheckbox.isChecked()).toBe(toggledMark);
            logger.info('  ✓ Undo/redo restored checkbox states');

            // Action 5: history timeline jump
            logger.info('\n=== History Timeline Jump ===');
            await page.locator('[data-testid="history-toggle"]').click();
            const historyItems = page.locator('[data-testid="history-item"]');
            const historyCount = await historyItems.count();
            expect(historyCount).toBeGreaterThan(0);

            await historyItems.nth(0).click();

            const resolvedAfterJump = await waitForResolvedCount(page, 0, 5000);
            expect(resolvedAfterJump.resolved).toBe(0);
            logger.info('  ✓ History jump restored initial state');

            logger.info('\n=== TEST PASSED ===');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
