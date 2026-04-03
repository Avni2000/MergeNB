/**
 * @file takeAllButtons.spec.ts
 * @description Playwright Test suite for "All Base / All Current / All Incoming" bulk-resolve buttons.
 *
 * Replaces the old takeAllButtons.test.ts with proper Playwright Test structure.
 * Each test variant (base/current/incoming) is parameterized.
 */

import { execFileSync } from 'child_process';
import { test, expect } from './fixtures';
import * as logger from '../../core/src';
import {
    getCellSource,
    validateNotebookStructure,
} from '../../../test-fixtures/shared/testHelpers';
import {
    type MergeSide,
    verifyAllConflictsMatchSide,
    getResolvedCount,
    waitForAllConflictsResolved,
    waitForResolvedCount,
    getColumnCell,
    getColumnCellType,
    collectExpectedCellsFromUI,
    clickHistoryUndo,
    clickHistoryRedo,
    getResolvedEditorValue,
} from '../../../test-fixtures/shared/integrationUtils';
import {
    buildExpectedCellsFromNotebook,
    assertNotebookMatches,
    applyResolutionAndReadNotebook,
} from './fixtures';
import type { Page } from 'playwright';

// ─── Test Variants ──────────────────────────────────────────────────────────

interface TakeAllTestVariant {
    id: string;
    description: string;
    notebooks: [string, string, string];
    action: MergeSide;
    mode?: 'all' | 'unresolved';
    manualChoice?: MergeSide;
    manualCount?: number;
    undoRedo?: boolean;
}

const takeAllVariants: TakeAllTestVariant[] = [
    {
        id: 'takeAll_base',
        description: 'Take All Base',
        notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
        action: 'base',
    },
    {
        id: 'takeAll_current',
        description: 'Take All Current',
        notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
        action: 'current',
    },
    {
        id: 'takeAll_current_single_conflict',
        description: 'Take All Current (single-conflict notebook)',
        notebooks: ['06_base.ipynb', '06_current.ipynb', '06_incoming.ipynb'],
        action: 'current',
    },
    {
        id: 'takeAll_incoming',
        description: 'Take All Incoming',
        notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
        action: 'incoming',
    },
    {
        id: 'takeAll_current_undoRedo',
        description: 'Take All Current + undo/redo',
        notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
        action: 'current',
        undoRedo: true,
    },
    {
        id: 'takeAll_unresolved_current',
        description: 'Take All Current (Checks manual choices are respected)',
        notebooks: ['04_base.ipynb', '04_current.ipynb', '04_incoming.ipynb'],
        action: 'current',
        mode: 'unresolved',
        manualChoice: 'incoming',
        manualCount: 2,
    },
];

// ─── Helper Functions ───────────────────────────────────────────────────────

function gitShow(cwd: string, ref: string): string {
    return execFileSync('git', ['show', ref], { cwd, encoding: 'utf8' });
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

async function selectManualRows(
    page: Page,
    manualChoice: MergeSide,
    manualCount: number
): Promise<Array<{ index: number; expectedSource: string; expectedCellType: string }>> {
    const rows = page.locator('.merge-row.conflict-row');
    const count = await rows.count();
    const selected: Array<{ index: number; expectedSource: string; expectedCellType: string }> = [];
    const buttonLabel = `Use ${capitalize(manualChoice)}`;

    for (let i = 0; i < count && selected.length < manualCount; i++) {
        const row = rows.nth(i);
        const button = row.locator(`button:has-text("${buttonLabel}")`);
        if (await button.count() === 0) continue;

        const cell = await getColumnCell(row, manualChoice, i);
        if (!cell) continue;
        const expectedSource = getCellSource(cell);
        const expectedCellType = await getColumnCellType(row, manualChoice);

        await button.click();
        await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });

        selected.push({ index: i, expectedSource, expectedCellType });
    }

    if (selected.length < manualCount) {
        throw new Error(`Could not find ${manualCount} conflict rows with "${buttonLabel}"`);
    }

    return selected;
}

async function verifyTakeAllUnresolved(
    page: Page,
    action: MergeSide,
    manualRows: Array<{ index: number; expectedSource: string }>
): Promise<void> {
    const rows = page.locator('.merge-row.conflict-row');
    const count = await rows.count();
    const manualIndex = new Map(manualRows.map(r => [r.index, r]));

    for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const manual = manualIndex.get(i);

        if (manual) {
            const textarea = row.locator('.resolved-content-input');
            if (await textarea.count() === 0) {
                throw new Error(`Row ${i}: expected resolved content for manual choice`);
            }
            const actualValue = await getResolvedEditorValue(textarea);
            if (actualValue !== manual.expectedSource) {
                throw new Error(`Row ${i}: manual choice overwritten by take-all`);
            }
            continue;
        }

        const hasSideCell = await row.locator(`.${action}-column .notebook-cell`).count() > 0;
        if (!hasSideCell) {
            const isDeleted = await row.locator('.resolved-cell.resolved-deleted').count() > 0;
            if (!isDeleted) {
                throw new Error(`Row ${i}: expected delete for missing ${action} cell`);
            }
            continue;
        }

        const expectedCell = await getColumnCell(row, action, i);
        if (!expectedCell) {
            throw new Error(`Row ${i}: could not read ${action} cell data`);
        }
        const expectedSource = getCellSource(expectedCell);
        const textarea = row.locator('.resolved-content-input');
        if (await textarea.count() === 0) {
            throw new Error(`Row ${i}: expected resolved content after take-all`);
        }
        const actualValue = await getResolvedEditorValue(textarea);
        if (actualValue !== expectedSource) {
            throw new Error(`Row ${i}: take-all content mismatch for ${action}`);
        }
    }
}

async function verifyManualSelectionsAfterUndo(
    page: Page,
    manualRows: Array<{ index: number; expectedSource: string }>
): Promise<void> {
    const rows = page.locator('.merge-row.conflict-row');
    const count = await rows.count();
    const manualIndex = new Map(manualRows.map(r => [r.index, r]));

    for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const manual = manualIndex.get(i);
        const textarea = row.locator('.resolved-content-input');
        const deleted = row.locator('.resolved-cell.resolved-deleted');

        if (manual) {
            if (await textarea.count() === 0) {
                throw new Error(`Row ${i}: expected manual resolution after undo`);
            }
            const actualValue = await getResolvedEditorValue(textarea);
            if (actualValue !== manual.expectedSource) {
                throw new Error(`Row ${i}: manual resolution mismatch after undo`);
            }
            continue;
        }

        if (await textarea.count() > 0 || await deleted.count() > 0) {
            throw new Error(`Row ${i}: expected unresolved state after undo`);
        }
    }
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

test.describe('Take All Buttons', () => {
    for (const variant of takeAllVariants) {
        test(variant.description, async ({ conflictRepo, conflictSession }) => {
            const { action, mode = 'all', manualChoice, manualCount = 2, undoRedo = false } = variant;

            logger.info('Starting MergeNB Take-All Buttons Integration Test...');

            // Create merge conflict repo
            const workspacePath = conflictRepo({
                base: variant.notebooks[0],
                current: variant.notebooks[1],
                incoming: variant.notebooks[2],
            });

            logger.info(`Running test variant: Take All ${action.toUpperCase()} (${mode})`);

            // Load source notebooks from git stages for verification
            logger.info('Loading source notebooks from git history...');
            const baseContent = gitShow(workspacePath, ':1:conflict.ipynb');
            const currentContent = gitShow(workspacePath, ':2:conflict.ipynb');
            const incomingContent = gitShow(workspacePath, ':3:conflict.ipynb');

            const sourceNotebooks = {
                base: JSON.parse(baseContent),
                current: JSON.parse(currentContent),
                incoming: JSON.parse(incomingContent),
            };
            const targetNotebook = sourceNotebooks[action];
            logger.info(`Loaded source notebooks. Target ('${action}') has ${targetNotebook.cells.length} cells.`);

            // Set up conflict resolver
            const session = await conflictSession(workspacePath);
            const { page, conflictFile } = session;

            // Verify we have conflict rows
            const conflictRowElements = page.locator('.merge-row.conflict-row');
            const conflictCount = await conflictRowElements.count();
            logger.info(`Found ${conflictCount} conflict rows`);

            expect(conflictCount).toBeGreaterThan(0);

            const initial = await getResolvedCount(page);
            logger.info(`Initial resolution state: ${initial.resolved}/${initial.total}`);

            // Resolve a few conflicts manually before take-all if in 'unresolved' mode
            let manualSelections: Array<{ index: number; expectedSource: string; expectedCellType: string }> = [];
            if (mode === 'unresolved') {
                const manualSide = manualChoice || 'incoming';
                logger.info(`Resolving ${manualCount} conflicts manually to "${manualSide}"...`);
                manualSelections = await selectManualRows(page, manualSide, manualCount);
                logger.info(`Manually resolved rows: ${manualSelections.map(m => m.index).join(', ')}`);
            }

            // ============================================================
            // EXECUTE ACTION
            // ============================================================
            const buttonLabel = `All ${capitalize(action)}`;
            logger.info(`\n=== Clicking "${buttonLabel}" ===`);

            const actionButton = page.locator(`button:has-text("${buttonLabel}")`);
            await actionButton.waitFor({ timeout: 5000 });
            await actionButton.click();

            // Verify resolution count
            const afterAction = await waitForAllConflictsResolved(page);
            logger.info(`After "${buttonLabel}": ${afterAction.resolved}/${afterAction.total}`);
            expect(afterAction.resolved).toBe(afterAction.total);

            // Verify textareas match UI columns
            if (mode === 'unresolved') {
                await verifyTakeAllUnresolved(page, action, manualSelections);
                logger.info(`  ✓ Take-all respected manual resolutions and applied to unresolved rows only`);
            } else {
                const result = await verifyAllConflictsMatchSide(page, action);
                logger.info(`  Matches: ${result.matchCount}, Deletes: ${result.deleteCount}`);
                expect(result.mismatches).toHaveLength(0);
                logger.info(`  ✓ All resolved cells match ${action}-side content in UI`);
            }

            // Undo/Redo verification
            if (undoRedo) {
                logger.info('\n=== Undo/Redo Take-All ===');
                const expectedResolvedBefore = mode === 'unresolved' ? manualSelections.length : initial.resolved;

                await clickHistoryUndo(page);
                const afterUndo = await waitForResolvedCount(page, expectedResolvedBefore, 7000);
                expect(afterUndo.resolved).toBe(expectedResolvedBefore);

                if (mode === 'unresolved') {
                    await verifyManualSelectionsAfterUndo(page, manualSelections.map(m => ({
                        index: m.index,
                        expectedSource: m.expectedSource,
                    })));
                }

                await clickHistoryRedo(page);
                await waitForAllConflictsResolved(page, 7000);

                if (mode === 'unresolved') {
                    await verifyTakeAllUnresolved(page, action, manualSelections);
                } else {
                    const redoResult = await verifyAllConflictsMatchSide(page, action);
                    expect(redoResult.mismatches).toHaveLength(0);
                }
            }

            // Build expected resolved cells from UI before applying
            const expectedCellsFromUI = await collectExpectedCellsFromUI(page, {
                resolveConflictChoice: async (row, _conflictIndex, rowIndex) => {
                    const selectedButton = row.locator('.btn-resolve.selected');
                    const selectedText = (await selectedButton.textContent()) || '';
                    const normalized = selectedText.toLowerCase();
                    if (normalized.includes('base')) return { choice: 'base' };
                    if (normalized.includes('current')) return { choice: 'current' };
                    if (normalized.includes('incoming')) return { choice: 'incoming' };
                    throw new Error(`Row ${rowIndex}: could not determine selected side`);
                },
                includeMetadata: false,
                includeOutputs: false,
            });

            // ============================================================
            // Apply Resolution
            // ============================================================
            const resolvedNotebook = await applyResolutionAndReadNotebook(page, conflictFile);

            // ============================================================
            // Verify notebook on disk
            // ============================================================
            logger.info('\n=== Verifying UI matches disk ===');

            if (mode === 'unresolved') {
                assertNotebookMatches(expectedCellsFromUI, resolvedNotebook, {
                    expectedLabel: 'Expected from UI',
                    compareMetadata: true,
                });
            } else {
                const expectedFromTarget = buildExpectedCellsFromNotebook(targetNotebook);
                assertNotebookMatches(expectedFromTarget, resolvedNotebook, {
                    expectedLabel: `Expected from "${action}"`,
                    compareMetadata: true,
                });
            }

            // Validate structure
            validateNotebookStructure(resolvedNotebook);

            logger.info('\n=== TEST PASSED ===');
            logger.info(`✓ "All ${action.toUpperCase()}" action verified end-to-end`);
        });
    }
});
