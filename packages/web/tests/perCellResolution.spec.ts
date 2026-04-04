/**
 * @file perCellResolution.spec.ts
 * @description Playwright Test for per-cell conflict resolution.
 *
 * Verifies that UI content (textareas + unified cell sources) matches the notebook written to disk.
 * Tests per-cell resolution: resolves each conflict individually using alternating
 * current/incoming choices, with optional deletion, then verifies the written notebook.
 */

import { test, expect } from './fixtures';
import * as logger from '../../core/src';
import {
    validateNotebookStructure,
} from '../../../test-fixtures/shared/testHelpers';
import {
    getColumnCellType,
    ensureCheckboxChecked,
    collectExpectedCellsFromUI,
    clickHistoryUndo,
    clickHistoryRedo,
    getHistoryEntries,
    getResolvedEditorValue,
    fillResolvedEditor,
    type ConflictChoice,
} from '../../../test-fixtures/shared/integrationUtils';
import {
    applyResolutionAndReadNotebook,
    assertNotebookMatches,
} from './fixtures';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from '../../../apps/vscode-extension/tests/settingsFile';

test.describe('Per-Cell Resolution', () => {
    test('Check we correctly write to disk from text areas (02 notebooks)', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting MergeNB VS Code Integration Test...');

        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            // Keep manual-resolution fixtures deterministic despite auto-resolve defaults.
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
            const { page, conflictFile } = session;

            // Count rows and conflicts
            const allRows = page.locator('.merge-row');
            const rowCount = await allRows.count();
            logger.info(`Found ${rowCount} merge rows`);

            const conflictRowElements = page.locator('.merge-row.conflict-row');
            const conflictCount = await conflictRowElements.count();
            logger.info(`Found ${conflictCount} conflict rows`);

            expect(conflictCount).toBeGreaterThan(0);

            const initialHistoryEntries = await getHistoryEntries(page);
            expect(initialHistoryEntries.length).toBeGreaterThan(0);
            expect(initialHistoryEntries[0].toLowerCase()).toContain('initial');

            // Count unmatched cells before resolving
            logger.info('\n=== Analyzing unmatched cells ===');
            let unmatchedCurrentOnly = 0;
            let unmatchedIncomingOnly = 0;
            let unmatchedBoth = 0;
            let baseMatched = 0;

            for (let conflictIdx = 0; conflictIdx < conflictCount; conflictIdx++) {
                const row = conflictRowElements.nth(conflictIdx);
                const hasBase = await row.locator('.base-column .notebook-cell').count() > 0;
                const hasCurrent = await row.locator('.current-column .notebook-cell').count() > 0;
                const hasIncoming = await row.locator('.incoming-column .notebook-cell').count() > 0;

                if (hasBase) {
                    baseMatched++;
                } else {
                    if (hasCurrent && hasIncoming) {
                        unmatchedBoth++;
                    } else if (hasCurrent) {
                        unmatchedCurrentOnly++;
                    } else if (hasIncoming) {
                        unmatchedIncomingOnly++;
                    }
                }
            }

            logger.info(`Unmatched cells (before resolution):`);
            logger.info(`  - Base-matched conflicts: ${baseMatched}`);
            logger.info(`  - Current-only (unmatched): ${unmatchedCurrentOnly}`);
            logger.info(`  - Incoming-only (unmatched): ${unmatchedIncomingOnly}`);
            logger.info(`  - Both current & incoming (unmatched from base): ${unmatchedBoth}`);
            logger.info(`  - Total unmatched: ${unmatchedCurrentOnly + unmatchedIncomingOnly + unmatchedBoth}`);

            // Track resolution choices for cell type determination
            const resolutionChoices: Map<number, { choice: ConflictChoice; chosenCellType: string }> = new Map();

            // Resolve each conflict
            logger.info('\n=== Resolving conflicts ===');
            for (let conflictIdx = 0; conflictIdx < conflictCount; conflictIdx++) {
                const row = conflictRowElements.nth(conflictIdx);
                await row.scrollIntoViewIfNeeded();

                const testId = await row.getAttribute('data-testid') || '';
                const rowIndex = parseInt(testId.replace('conflict-row-', '').replace('row-', ''), 10);

                // Check which cells exist and their types
                const hasBase = await row.locator('.base-column .notebook-cell').count() > 0;
                const hasCurrent = await row.locator('.current-column .notebook-cell').count() > 0;
                const hasIncoming = await row.locator('.incoming-column .notebook-cell').count() > 0;

                const baseCellType = hasBase ? await getColumnCellType(row, 'base') : 'code';
                const currentCellType = hasCurrent ? await getColumnCellType(row, 'current') : 'code';
                const incomingCellType = hasIncoming ? await getColumnCellType(row, 'incoming') : 'code';

                let buttonToClick: string;
                let choice: ConflictChoice;
                let chosenCellType: string;
                let isDeleteAction = false;

                // Delete cells at indices divisible by 7 (except 0)
                if (rowIndex > 0 && rowIndex % 7 === 0) {
                    buttonToClick = '.btn-delete';
                    choice = 'delete';
                    chosenCellType = 'code';
                    isDeleteAction = true;
                } else if (rowIndex % 2 === 0) {
                    // Even: prefer incoming
                    if (hasIncoming) {
                        buttonToClick = '.btn-incoming';
                        choice = 'incoming';
                        chosenCellType = incomingCellType;
                    } else if (hasCurrent) {
                        buttonToClick = '.btn-current';
                        choice = 'current';
                        chosenCellType = currentCellType;
                    } else {
                        buttonToClick = '.btn-base';
                        choice = 'base';
                        chosenCellType = baseCellType;
                    }
                } else {
                    // Odd: prefer current
                    if (hasCurrent) {
                        buttonToClick = '.btn-current';
                        choice = 'current';
                        chosenCellType = currentCellType;
                    } else if (hasIncoming) {
                        buttonToClick = '.btn-incoming';
                        choice = 'incoming';
                        chosenCellType = incomingCellType;
                    } else {
                        buttonToClick = '.btn-base';
                        choice = 'base';
                        chosenCellType = baseCellType;
                    }
                }

                resolutionChoices.set(conflictIdx, { choice, chosenCellType });

                const button = row.locator(buttonToClick);
                await button.waitFor({ timeout: 10000 });
                await button.click();

                const resolvedSelector = isDeleteAction ? '.resolved-deleted' : '.resolved-content-input';
                await row.locator(resolvedSelector).waitFor({ timeout: 5000 });

                // Test undo/redo on first conflict
                if (conflictIdx === 0) {
                    const updatedHistory = await getHistoryEntries(page);
                    expect(updatedHistory.length).toBeGreaterThan(initialHistoryEntries.length);
                    const lastEntry = updatedHistory[updatedHistory.length - 1].toLowerCase();
                    expect(lastEntry).toMatch(/resolve conflict \d+/);

                    await clickHistoryUndo(page);
                    await row.locator(resolvedSelector).waitFor({ state: 'detached', timeout: 5000 });

                    await clickHistoryRedo(page);
                    await row.locator(resolvedSelector).waitFor({ timeout: 5000 });
                }

                // Modify textarea content to append choice indicator
                if (!isDeleteAction) {
                    const textarea = row.locator('.resolved-content-input');
                    const originalContent = await getResolvedEditorValue(textarea);
                    let modifiedContent = originalContent;

                    if (choice === 'incoming') {
                        modifiedContent = originalContent + '\n(incoming)';
                    } else if (choice === 'current') {
                        modifiedContent = originalContent + '\n(current)';
                    } else if (choice === 'base') {
                        modifiedContent = originalContent + '\n(base)';
                    }

                    if (modifiedContent !== originalContent) {
                        await fillResolvedEditor(textarea, modifiedContent);
                    }
                }

                await new Promise(r => setTimeout(r, 100));
            }

            // Verify checkboxes
            const renumberEnabled = await ensureCheckboxChecked(page, 'Renumber execution counts');

            // Capture expected cells from UI BEFORE clicking apply
            logger.info('\n=== Capturing expected cells from UI ===');
            const expectedCells = await collectExpectedCellsFromUI(page, {
                resolveConflictChoice: async (_row, conflictIndex, rowIndex) => {
                    const resInfo = resolutionChoices.get(conflictIndex);
                    if (!resInfo) {
                        throw new Error(`Missing resolution info for conflict row ${rowIndex}`);
                    }
                    return { choice: resInfo.choice, chosenCellType: resInfo.chosenCellType };
                },
                includeMetadata: true,
                includeOutputs: true,
            });
            logger.info(`Captured ${expectedCells.length} cells from UI`);

            // Filter to non-deleted cells
            const expectedNonDeletedCells = expectedCells.filter(c => !c.isDeleted);
            logger.info(`Expected ${expectedNonDeletedCells.length} cells in final notebook`);

            // Apply resolution and verify notebook
            logger.info('\n=== Verifying UI matches disk ===');
            const resolvedNotebook = await applyResolutionAndReadNotebook(page, conflictFile);
            assertNotebookMatches(expectedNonDeletedCells, resolvedNotebook, {
                expectedLabel: 'Expected from UI',
                compareMetadata: true,
                compareExecutionCounts: true,
                renumberEnabled,
            });

            // Verify notebook structure
            validateNotebookStructure(resolvedNotebook);

            logger.info('\n=== TEST PASSED ===');
            logger.info(`✓ ${expectedNonDeletedCells.length} cells verified`);
            logger.info('✓ All sources match');
            logger.info('✓ All types match');
            logger.info('✓ Notebook structure valid');

        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
