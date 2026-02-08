/**
 * @file undoRedoActions.test.ts
 * @description Integration test covering undo/redo for conflict resolver actions.
 */

import type { Page, Locator } from 'playwright';
import {
    clickHistoryUndo,
    clickHistoryRedo,
    waitForResolvedCount,
} from './integrationUtils';
import {
    readTestConfig,
    setupConflictResolver,
} from './testHarness';

type MergeSide = 'base' | 'current' | 'incoming';

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

async function findCellMovePair(page: Page): Promise<{
    side: MergeSide;
    sourceRowId: string;
    targetRowId: string;
}> {
    const rows = page.locator('.merge-row.unmatched-row');
    const count = await rows.count();
    if (count === 0) {
        throw new Error('No unmatched rows available for cell move test');
    }

    const sides: MergeSide[] = ['base', 'current', 'incoming'];
    for (const side of sides) {
        const sources: Array<{ rowId: string; cellCount: number }> = [];
        const targets: Array<{ rowId: string }> = [];

        for (let i = 0; i < count; i++) {
            const row = rows.nth(i);
            const rowId = await row.getAttribute('data-testid');
            if (!rowId) continue;

            const hasBase = await row.locator('.base-column .notebook-cell').count() > 0;
            const hasCurrent = await row.locator('.current-column .notebook-cell').count() > 0;
            const hasIncoming = await row.locator('.incoming-column .notebook-cell').count() > 0;
            const cellCount = (hasBase ? 1 : 0) + (hasCurrent ? 1 : 0) + (hasIncoming ? 1 : 0);

            const hasSideCell = await row.locator(`.${side}-column .notebook-cell`).count() > 0;
            const hasSidePlaceholder = await row.locator(`.${side}-column .cell-placeholder`).count() > 0;

            if (hasSideCell && cellCount >= 1) {
                sources.push({ rowId, cellCount });
            }
            if (hasSidePlaceholder) {
                targets.push({ rowId });
            }
        }

        if (sources.length > 0 && targets.length > 0) {
            const source = sources[0];
            const target = targets.find(t => t.rowId !== source.rowId) || targets[0];
            return { side, sourceRowId: source.rowId, targetRowId: target.rowId };
        }
    }

    throw new Error('Could not find suitable unmatched rows for cell move test');
}

export async function run(): Promise<void> {
    console.log('Starting MergeNB Undo/Redo Actions Integration Test...');

    let browser;
    let page: Page | undefined;

    try {
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
        await page.keyboard.press('Control+Z');
        await firstRow.locator('.resolved-content-input').waitFor({ state: 'detached', timeout: 5000 });

        await page.click('.header-title');
        await page.keyboard.press('Control+Shift+Z');
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

        // Action 5: move unmatched cell + undo/redo
        console.log('\n=== Undo/Redo: Move Unmatched Cell ===');

        const movePair = await findCellMovePair(page);
        const sourceRow = page.locator(`[data-testid="${movePair.sourceRowId}"]`);
        const targetRow = page.locator(`[data-testid="${movePair.targetRowId}"]`);

        await sourceRow.scrollIntoViewIfNeeded();
        await targetRow.scrollIntoViewIfNeeded();

        const sourceCell = sourceRow.locator(`.${movePair.side}-column .notebook-cell`).first();
        const targetPlaceholder = targetRow.locator(`.${movePair.side}-column .cell-placeholder`).first();
        const sourceCellData = await sourceCell.getAttribute('data-cell');
        if (!sourceCellData) {
            throw new Error('Could not read source cell data before move');
        }

        // Use programmatic drag-and-drop via page.evaluate to ensure events fire correctly
        const sourceSelector = `[data-testid="${movePair.sourceRowId}"] .${movePair.side}-column .notebook-cell`;
        const targetSelector = `[data-testid="${movePair.targetRowId}"] .${movePair.side}-column .cell-placeholder`;
        await page.evaluate(({ src, tgt }) => {
            const sourceEl = document.querySelector(src) as HTMLElement;
            const targetEl = document.querySelector(tgt) as HTMLElement;
            if (!sourceEl || !targetEl) {
                throw new Error(`Elements not found: src=${!!sourceEl}, tgt=${!!targetEl}`);
            }

            const dataTransfer = new DataTransfer();
            dataTransfer.effectAllowed = 'move';

            sourceEl.dispatchEvent(new DragEvent('dragstart', {
                bubbles: true, cancelable: true, dataTransfer,
            }));

            targetEl.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer,
            }));

            targetEl.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer,
            }));

            sourceEl.dispatchEvent(new DragEvent('dragend', {
                bubbles: true, cancelable: true,
            }));
        }, { src: sourceSelector, tgt: targetSelector });

        // Wait for React to process the state update
        await page.waitForTimeout(500);

        const movedCell = targetRow.locator(`.${movePair.side}-column .notebook-cell`).first();
        await movedCell.waitFor({ timeout: 5000 });
        const movedCellData = await movedCell.getAttribute('data-cell');
        if (movedCellData !== sourceCellData) {
            throw new Error('Moved cell data did not match source cell data');
        }

        await clickHistoryUndo(page);
        await sourceRow.locator(`.${movePair.side}-column .notebook-cell`).first().waitFor({ timeout: 5000 });
        await targetRow.locator(`.${movePair.side}-column .cell-placeholder`).first().waitFor({ timeout: 5000 });

        await clickHistoryRedo(page);
        await targetRow.locator(`.${movePair.side}-column .notebook-cell`).first().waitFor({ timeout: 5000 });
        console.log('  ✓ Undo/redo restored moved cell');

        // Action 6: reorder rows + undo/redo
        console.log('\n=== Undo/Redo: Reorder Rows ===');
        if (conflictCount < 2) {
            throw new Error('Need at least two conflict rows to test reordering');
        }
        const rowA = conflictRows.nth(0);
        const rowB = conflictRows.nth(1);
        const rowAId = await rowA.getAttribute('data-testid');
        const rowBId = await rowB.getAttribute('data-testid');
        if (!rowAId || !rowBId) {
            throw new Error('Missing data-testid for conflict rows');
        }

        await rowA.scrollIntoViewIfNeeded();
        await rowB.scrollIntoViewIfNeeded();

        // Use programmatic drag events for row reorder (same approach as cell drag)
        const handleSelector = `[data-testid="${rowAId}"] [data-testid="row-drag-handle"]`;
        const rowBSelector = `[data-testid="${rowBId}"]`;
        await page.evaluate(({ src, tgt }) => {
            const sourceEl = document.querySelector(src) as HTMLElement;
            const targetEl = document.querySelector(tgt) as HTMLElement;
            if (!sourceEl || !targetEl) {
                throw new Error(`Elements not found: src=${!!sourceEl}, tgt=${!!targetEl}`);
            }

            const dataTransfer = new DataTransfer();
            dataTransfer.effectAllowed = 'move';
            dataTransfer.setData('text/plain', 'row');

            sourceEl.dispatchEvent(new DragEvent('dragstart', {
                bubbles: true, cancelable: true, dataTransfer,
            }));

            // Drop on the target row's wrapper (parent)
            const targetWrapper = targetEl.parentElement || targetEl;
            targetWrapper.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer,
            }));

            targetWrapper.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer,
            }));

            sourceEl.dispatchEvent(new DragEvent('dragend', {
                bubbles: true, cancelable: true,
            }));
        }, { src: handleSelector, tgt: rowBSelector });

        await page.waitForTimeout(500);

        const newFirstId = await conflictRows.nth(0).getAttribute('data-testid');
        if (newFirstId === rowAId) {
            throw new Error('Row reorder did not change row order');
        }

        await clickHistoryUndo(page);
        const undoFirstId = await conflictRows.nth(0).getAttribute('data-testid');
        if (undoFirstId !== rowAId) {
            throw new Error('Undo did not restore original row order');
        }

        await clickHistoryRedo(page);
        const redoFirstId = await conflictRows.nth(0).getAttribute('data-testid');
        if (redoFirstId !== rowBId) {
            throw new Error('Redo did not reapply row reorder');
        }
        console.log('  ✓ Undo/redo restored row ordering');

        // Action 7: timeline jump from history dropdown
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
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
