
import { type Page, type Locator } from 'playwright';
import { getCellSource, parseCellFromAttribute } from './testHelpers';

export type MergeSide = 'base' | 'current' | 'incoming';

/** Get a cell reference from a column in a conflict row */
export async function getColumnCell(row: Locator, column: MergeSide, rowIndex: number) {
    const cellEl = row.locator(`.${column}-column .notebook-cell`);
    if (await cellEl.count() === 0) return null;
    const cellJson = await cellEl.getAttribute('data-cell');
    return parseCellFromAttribute(cellJson, `row ${rowIndex} ${column} cell`);
}

/** Get the cell type from a notebook cell element */
export async function getColumnCellType(row: Locator, column: MergeSide): Promise<string> {
    const cell = row.locator(`.${column}-column .notebook-cell`);
    if (await cell.count() === 0) return 'code';
    const isCode = await cell.evaluate(el => el.classList.contains('code-cell'));
    return isCode ? 'code' : 'markdown';
}

/**
 * Verify that every conflict row's textarea matches the expected side's content.
 * Returns the collected textarea values for further verification.
 */
export async function verifyAllConflictsMatchSide(
    page: Page,
    side: MergeSide,
): Promise<{ matchCount: number; deleteCount: number; mismatches: string[] }> {
    const conflictRows = page.locator('.merge-row.conflict-row');
    const count = await conflictRows.count();
    const mismatches: string[] = [];
    let matchCount = 0;
    let deleteCount = 0;

    for (let i = 0; i < count; i++) {
        const row = conflictRows.nth(i);

        // Check if the chosen side has a cell
        const hasSideCell = await row.locator(`.${side}-column .notebook-cell`).count() > 0;

        if (!hasSideCell) {
            // No cell on chosen side → expect "resolved-deleted"
            const isDeleted = await row.locator('.resolved-cell.resolved-deleted').count() > 0;
            if (isDeleted) {
                deleteCount++;
            } else {
                mismatches.push(`Row ${i}: expected deleted (no ${side} cell), but not marked deleted`);
            }
            continue;
        }

        // Get the reference cell source from the chosen side
        const refCell = await getColumnCell(row, side, i);
        if (!refCell) {
            mismatches.push(`Row ${i}: could not read ${side} cell data`);
            continue;
        }
        const expectedSource = getCellSource(refCell);

        // Check textarea value
        const textarea = row.locator('.resolved-content-input');
        if (await textarea.count() === 0) {
            mismatches.push(`Row ${i}: no textarea found`);
            continue;
        }

        const actualValue = await textarea.inputValue();
        if (actualValue !== expectedSource) {
            mismatches.push(
                `Row ${i}: textarea mismatch\n` +
                `  Expected (${side}): "${expectedSource.substring(0, 60).replace(/\n/g, '\\n')}..."\n` +
                `  Actual:            "${actualValue.substring(0, 60).replace(/\n/g, '\\n')}..."`
            );
        } else {
            matchCount++;
        }
    }

    return { matchCount, deleteCount, mismatches };
}

/** Ensure a checkbox with the given label text is checked. Returns final state. */
export async function ensureCheckboxChecked(page: Page, labelText: string): Promise<boolean> {
    const checkbox = page.locator(`label:has-text("${labelText}") input[type="checkbox"]`);
    await checkbox.waitFor({ timeout: 5000 });
    if (!await checkbox.isChecked()) {
        await checkbox.check();
    }
    return checkbox.isChecked();
}

/** 
 * Reads the conflict counter from the UI
 */
export async function getResolvedCount(page: Page): Promise<{ resolved: number; total: number }> {
    const counterText = await page.locator('.conflict-counter').textContent() || '';
    const match = counterText.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return { resolved: 0, total: 0 };
    return { resolved: parseInt(match[1], 10), total: parseInt(match[2], 10) };
}

/** Wait until all conflicts are resolved (resolved === total) or timeout. */
export async function waitForAllConflictsResolved(
    page: Page,
    timeoutMs = 5000,
    pollMs = 200,
): Promise<{ resolved: number; total: number }> {
    const start = Date.now();
    let last = await getResolvedCount(page);
    while (Date.now() - start < timeoutMs) {
        last = await getResolvedCount(page);
        if (last.total > 0 && last.resolved === last.total) {
            return last;
        }
        await new Promise(r => setTimeout(r, pollMs));
    }
    return last;
}
