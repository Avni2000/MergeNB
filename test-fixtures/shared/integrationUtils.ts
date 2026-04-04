/**
 * @file integrationUtils.ts
 * @description Playwright helpers for driving the MergeNB conflict resolution UI.
 *
 * Provides utilities for:
 * - Reading cell data from merge row columns
 * - Verifying textarea content matches a chosen side
 * - Polling conflict counters
 * - Interacting with the undo/redo history panel
 * - Building the expected cell list from the live UI before applying a resolution
 */

import { type Page, type Locator } from 'playwright';
import { type ExpectedCell, getCellSource, parseCellFromAttribute } from './testHelpers';

export type MergeSide = 'base' | 'current' | 'incoming';
export type ConflictChoice = MergeSide | 'delete';

interface ConflictChoiceInfo {
    choice: ConflictChoice;
    chosenCellType?: string;
}

type ConflictChoiceResolver = (
    row: Locator,
    conflictIndex: number,
    rowIndex: number,
) => Promise<ConflictChoiceInfo>;

/**
 * Read the full text content of a CodeMirror `.resolved-content-input` editor.
 *
 * Prefer CodeMirror state when available to avoid viewport-only DOM text.
 * Fall back to `.cm-content.textContent` if the internal view handle is unavailable.
 */
export async function getResolvedEditorValue(editorLocator: Locator): Promise<string> {
    return await editorLocator.evaluate(el => {
        type CodeMirrorDoc = { toString: () => string };
        type CodeMirrorViewState = { doc?: CodeMirrorDoc };
        type CodeMirrorView = { state?: CodeMirrorViewState };
        type CodeMirrorTile = { root?: { view?: CodeMirrorView } };
        type CodeMirrorInternal = HTMLElement & {
            cmTile?: CodeMirrorTile;
            cmView?: { view?: CodeMirrorView };
        };

        const editorRoot = (el.classList.contains('cm-editor') ? el : el.querySelector('.cm-editor')) as HTMLElement | null;
        if (!editorRoot) {
            return '';
        }

        const content = editorRoot.querySelector('.cm-content') as CodeMirrorInternal | null;
        const maybeInternal = editorRoot as CodeMirrorInternal;
        const doc =
            content?.cmTile?.root?.view?.state?.doc ??
            content?.cmView?.view?.state?.doc ??
            maybeInternal.cmTile?.root?.view?.state?.doc ??
            maybeInternal.cmView?.view?.state?.doc;
        if (doc && typeof doc.toString === 'function') {
            return doc.toString();
        }

        if (content) {
            const lines = Array.from(content.querySelectorAll('.cm-line')).map(line => line.textContent ?? '');
            if (lines.length > 0) {
                return lines.join('\n');
            }
            return content.textContent ?? '';
        }

        return '';
    });
}

/**
 * Replace the content of a CodeMirror `.resolved-content-input` editor.
 * `.fill()` cannot be used because CodeMirror manages a `contenteditable` div, not a `<textarea>`.
 */
export async function fillResolvedEditor(editorLocator: Locator, value: string): Promise<void> {
    const page = editorLocator.page();
    const content = editorLocator.locator('.cm-content');
    await content.click();
    await page.keyboard.press('ControlOrMeta+A');  
    await page.keyboard.insertText(value);
}

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

        const actualValue = await getResolvedEditorValue(textarea);
        if (actualValue !== expectedSource) {
            // Show full comparison for better debugging
            const expectedLen = expectedSource.length;
            const actualLen = actualValue.length;
            let firstDiffIndex = -1;
            for (let j = 0; j < Math.max(expectedLen, actualLen); j++) {
                if (expectedSource[j] !== actualValue[j]) {
                    firstDiffIndex = j;
                    break;
                }
            }
            
            const diffContext = firstDiffIndex !== -1 
                ? `\n    First diff at index ${firstDiffIndex}:\n` +
                  `    Expected char code: ${expectedSource.charCodeAt(firstDiffIndex)} (${JSON.stringify(expectedSource[firstDiffIndex])})\n` +
                  `    Actual char code:   ${actualValue.charCodeAt(firstDiffIndex)} (${JSON.stringify(actualValue[firstDiffIndex])})\n` +
                  `    Context (expected): ${JSON.stringify(expectedSource.substring(Math.max(0, firstDiffIndex - 10), firstDiffIndex + 20))}\n` +
                  `    Context (actual):   ${JSON.stringify(actualValue.substring(Math.max(0, firstDiffIndex - 10), firstDiffIndex + 20))}`
                : '';
            
            mismatches.push(
                `Row ${i}: textarea mismatch (len: expected=${expectedLen}, actual=${actualLen})\n` +
                `  Expected (${side}): "${expectedSource.substring(0, 100).replace(/\n/g, '\\n')}${expectedLen > 100 ? '...' : ''}"\n` +
                `  Actual:            "${actualValue.substring(0, 100).replace(/\n/g, '\\n')}${actualLen > 100 ? '...' : ''}"` +
                diffContext
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

/** Wait until the resolved count reaches `expectedResolved` or timeout. */
export async function waitForResolvedCount(
    page: Page,
    expectedResolved: number,
    timeoutMs = 5000,
    pollMs = 200,
): Promise<{ resolved: number; total: number }> {
    const start = Date.now();
    let last = await getResolvedCount(page);
    while (Date.now() - start < timeoutMs) {
        last = await getResolvedCount(page);
        if (last.resolved === expectedResolved) {
            return last;
        }
        await new Promise(r => setTimeout(r, pollMs));
    }
    return last;
}

/** Click the undo button in the history panel. */
export async function clickHistoryUndo(page: Page): Promise<void> {
    const button = page.locator('[data-testid="history-undo"]');
    await button.waitFor({ timeout: 5000 });
    await button.click();
}

/** Click the redo button in the history panel. */
export async function clickHistoryRedo(page: Page): Promise<void> {
    const button = page.locator('[data-testid="history-redo"]');
    await button.waitFor({ timeout: 5000 });
    await button.click();
}

/** Return the text of every entry in the history panel, in order. */
export async function getHistoryEntries(page: Page): Promise<string[]> {
    const items = page.locator('[data-testid="history-item"]');
    const count = await items.count();
    const entries: string[] = [];
    for (let i = 0; i < count; i++) {
        entries.push((await items.nth(i).textContent())?.trim() || '');
    }
    return entries;
}

/**
 * Walk all merge rows in the UI and build the list of cells we expect to find
 * on disk after the resolution is applied.
 *
 * For **identical rows** the cell data is read directly from the DOM attribute.
 * For **conflict rows** the `resolveConflictChoice` callback is invoked so the
 * caller can drive the UI (click a side, delete, etc.) and return which choice
 * was made. The resolved textarea value is then captured as the expected source.
 *
 * Call this *before* clicking Apply so the UI state is still intact.
 */
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
            const normalizedOutputs = includeOutputs && hasOutputs
                ? JSON.parse(JSON.stringify(cell.outputs))
                : undefined;
            expected.push({
                rowIndex: i,
                source: getCellSource(cell),
                cellType: resolvedCellType,
                metadata: includeMetadata ? (cell.metadata || {}) : undefined,
                hasOutputs: includeOutputs ? hasOutputs : undefined,
                outputs: normalizedOutputs,
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

            const choiceInfo = await options.resolveConflictChoice(row, conflictIdx, i);
            const choice = choiceInfo.choice;

            const textarea = row.locator('.resolved-content-input');
            if (await textarea.count() === 0) {
                throw new Error(`Row ${i}: missing resolved content input`);
            }
            const resolvedContent = await getResolvedEditorValue(textarea);
            let cellType = choiceInfo.chosenCellType;

            if (!cellType && (choice === 'base' || choice === 'current' || choice === 'incoming')) {
                cellType = await getColumnCellType(row, choice);
            }
            if (!cellType) {
                cellType = 'code';
            }

            let metadata: Record<string, unknown> | undefined;
            let hasOutputs = false;
            let normalizedOutputs: Array<Record<string, unknown>> | undefined;
            if ((includeMetadata || includeOutputs) && (choice === 'base' || choice === 'current' || choice === 'incoming')) {
                const referenceCell = await getColumnCell(row, choice, i);
                if (!referenceCell) {
                    throw new Error(`Row ${i}: could not read ${choice} cell data`);
                }
                if (includeMetadata) {
                    metadata = referenceCell.metadata || {};
                }
                if (includeOutputs) {
                    hasOutputs = cellType === 'code' &&
                        Array.isArray((referenceCell as any).outputs) &&
                        (referenceCell as any).outputs.length > 0;
                    if (hasOutputs) {
                        normalizedOutputs = JSON.parse(JSON.stringify((referenceCell as any).outputs));
                    }
                }
            }

            expected.push({
                rowIndex: i,
                source: resolvedContent,
                cellType,
                metadata,
                hasOutputs: includeOutputs ? hasOutputs : undefined,
                outputs: normalizedOutputs,
                isConflict: true,
                isDeleted: false,
            });
            conflictIdx++;
        }
    }

    return expected;
}
