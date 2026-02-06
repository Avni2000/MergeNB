
import { type Page, type Locator } from 'playwright';
import { type ExpectedCell, getCellSource, parseCellFromAttribute } from './testHelpers';

export type MergeSide = 'base' | 'current' | 'incoming';
export type ConflictChoice = MergeSide | 'delete';

export interface ConflictChoiceInfo {
    choice: ConflictChoice;
    chosenCellType?: string;
}

export type ConflictChoiceResolver = (
    row: Locator,
    conflictIndex: number,
    rowIndex: number,
) => Promise<ConflictChoiceInfo>;

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

export async function collectExpectedCellsFromUI(
    page: Page,
    options: {
        resolveConflictChoice: ConflictChoiceResolver;
        includeMetadata?: boolean;
        includeOutputs?: boolean;
    }
): Promise<ExpectedCell[]> {
    const rows = page.locator('.merge-row');
    const count = await rows.count();
    const expected: ExpectedCell[] = [];
    const includeMetadata = options.includeMetadata ?? false;
    const includeOutputs = options.includeOutputs ?? false;

    let conflictIdx = 0;
    for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const className = await row.getAttribute('class') || '';
        const isConflict = className.includes('conflict-row');
        const isIdentical = className.includes('identical-row');

        if (isIdentical) {
            const cellJson = await row.getAttribute('data-cell');
            const cellTypeAttr = await row.getAttribute('data-cell-type') || 'code';
            const cell = parseCellFromAttribute(cellJson, `identical row ${i}`);
            const resolvedCellType = cell.cell_type || cellTypeAttr;
            const hasOutputs = includeOutputs &&
                resolvedCellType === 'code' &&
                Array.isArray(cell.outputs) &&
                cell.outputs.length > 0;
            expected.push({
                rowIndex: i,
                source: getCellSource(cell),
                cellType: resolvedCellType,
                metadata: includeMetadata ? (cell.metadata || {}) : undefined,
                hasOutputs: includeOutputs ? hasOutputs : undefined,
                isConflict: false,
                isDeleted: false,
            });
            continue;
        }

        if (isConflict) {
            const resolvedCell = row.locator('.resolved-cell');
            const hasResolvedCell = await resolvedCell.count() > 0;

            if (!hasResolvedCell) {
                conflictIdx++;
                continue;
            }

            const isDeleted = await resolvedCell.evaluate(el => el.classList.contains('resolved-deleted'));
            if (isDeleted) {
                expected.push({
                    rowIndex: i,
                    source: '',
                    cellType: 'code',
                    isConflict: true,
                    isDeleted: true,
                });
                conflictIdx++;
                continue;
            }

            const textarea = row.locator('.resolved-content-input');
            if (await textarea.count() === 0) {
                throw new Error(`Row ${i}: missing resolved content input`);
            }
            const resolvedContent = await textarea.inputValue();

            const choiceInfo = await options.resolveConflictChoice(row, conflictIdx, i);
            const choice = choiceInfo.choice;
            let cellType = choiceInfo.chosenCellType;

            if (!cellType && (choice === 'base' || choice === 'current' || choice === 'incoming')) {
                cellType = await getColumnCellType(row, choice);
            }
            if (!cellType) {
                cellType = 'code';
            }

            let metadata: Record<string, unknown> | undefined;
            if (includeMetadata && (choice === 'base' || choice === 'current' || choice === 'incoming')) {
                const referenceCell = await getColumnCell(row, choice, i);
                if (!referenceCell) {
                    throw new Error(`Row ${i}: could not read ${choice} cell data`);
                }
                metadata = referenceCell.metadata || {};
            }

            expected.push({
                rowIndex: i,
                source: resolvedContent,
                cellType,
                metadata,
                hasOutputs: includeOutputs ? false : undefined,
                isConflict: true,
                isDeleted: false,
            });
            conflictIdx++;
        }
    }

    return expected;
}
