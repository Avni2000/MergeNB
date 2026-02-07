/**
 * End-to-end integration test that runs inside VS Code extension host.
 * Verifies that UI content (textareas + unified cell sources) matches the notebook written to disk.
 * 
 * Tests per-cell resolution: resolves each conflict individually using alternating
 * current/incoming choices, with optional deletion, then verifies the written notebook.
 */

import {
    validateNotebookStructure,
} from './testHelpers';
import {
    getColumnCellType,
    ensureCheckboxChecked,
    collectExpectedCellsFromUI,
    clickHistoryUndo,
    clickHistoryRedo,
    getHistoryEntries,
    type ConflictChoice,
} from './integrationUtils';
import {
    readTestConfig,
    setupConflictResolver,
    applyResolutionAndReadNotebook,
    assertNotebookMatches,
} from './testHarness';

export async function run(): Promise<void> {
    console.log('Starting MergeNB VS Code Integration Test...');

    let browser;
    let page;

    try {
        // Setup: Read config and open conflict file
        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;
        const conflictFile = session.conflictFile;

        // Count rows and conflicts
        const allRows = page.locator('.merge-row');
        const rowCount = await allRows.count();
        console.log(`Found ${rowCount} merge rows`);

        const conflictRowElements = page.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRowElements.count();
        console.log(`Found ${conflictCount} conflict rows`);

        if (conflictCount === 0) {
            throw new Error('Should have at least one conflict row');
        }

        const initialHistoryEntries = await getHistoryEntries(page);
        if (initialHistoryEntries.length === 0 || !initialHistoryEntries[0].toLowerCase().includes('initial')) {
            throw new Error('History panel should start with initial state');
        }

        // Count unmatched cells before resolving
        console.log('\n=== Analyzing unmatched cells ===');
        let unmatchedCurrentOnly = 0;  // current exists, base doesn't
        let unmatchedIncomingOnly = 0; // incoming exists, base doesn't
        let unmatchedBoth = 0;         // both current and incoming exist, but base doesn't
        let baseMatched = 0;           // base cell was matched (exists in all or some branches)

        for (let conflictIdx = 0; conflictIdx < conflictCount; conflictIdx++) {
            const row = conflictRowElements.nth(conflictIdx);
            const hasBase = await row.locator('.base-column .notebook-cell').count() > 0;
            const hasCurrent = await row.locator('.current-column .notebook-cell').count() > 0;
            const hasIncoming = await row.locator('.incoming-column .notebook-cell').count() > 0;

            if (hasBase) {
                baseMatched++;
            } else {
                // Unmatched from base perspective
                if (hasCurrent && hasIncoming) {
                    unmatchedBoth++;
                } else if (hasCurrent) {
                    unmatchedCurrentOnly++;
                } else if (hasIncoming) {
                    unmatchedIncomingOnly++;
                }
            }
        }

        console.log(`Unmatched cells (before resolution):`);
        console.log(`  - Base-matched conflicts: ${baseMatched}`);
        console.log(`  - Current-only (unmatched): ${unmatchedCurrentOnly}`);
        console.log(`  - Incoming-only (unmatched): ${unmatchedIncomingOnly}`);
        console.log(`  - Both current & incoming (unmatched from base): ${unmatchedBoth}`);
        console.log(`  - Total unmatched: ${unmatchedCurrentOnly + unmatchedIncomingOnly + unmatchedBoth}`);

        // Track resolution choices for cell type determination
        const resolutionChoices: Map<number, { choice: ConflictChoice; chosenCellType: string }> = new Map();

        // Resolve each conflict
        console.log('\n=== Resolving conflicts ===');
        for (let conflictIdx = 0; conflictIdx < conflictCount; conflictIdx++) {
            const row = conflictRowElements.nth(conflictIdx);
            await row.scrollIntoViewIfNeeded();

            const testId = await row.getAttribute('data-testid') || '';
            const rowIndex = parseInt(testId.replace('conflict-row-', '').replace('row-', ''), 10);

            // Check which cells exist and their types
            const hasBase = await row.locator('.base-column .notebook-cell').count() > 0;
            const hasCurrent = await row.locator('.current-column .notebook-cell').count() > 0;
            const hasIncoming = await row.locator('.incoming-column .notebook-cell').count() > 0;

            // Determine cell types for each branch
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

            if (conflictIdx === 0) {
                const updatedHistory = await getHistoryEntries(page);
                if (updatedHistory.length <= initialHistoryEntries.length) {
                    throw new Error('Expected history panel to record the first resolution action');
                }
                const lastEntry = updatedHistory[updatedHistory.length - 1].toLowerCase();
                if (!lastEntry.includes('resolve conflict 1')) {
                    throw new Error(`Unexpected history entry for first resolution: ${lastEntry}`);
                }

                await clickHistoryUndo(page);
                await row.locator(resolvedSelector).waitFor({ state: 'detached', timeout: 5000 });

                await clickHistoryRedo(page);
                await row.locator(resolvedSelector).waitFor({ timeout: 5000 });
            }

            if (!isDeleteAction) {
                // Modify textarea content to append choice indicator
                const textarea = row.locator('.resolved-content-input');
                const originalContent = await textarea.inputValue();
                let modifiedContent = originalContent;

                if (choice === 'incoming') {
                    modifiedContent = originalContent + '\n(incoming)';
                } else if (choice === 'current') {
                    modifiedContent = originalContent + '\n(current)';
                } else if (choice === 'base') {
                    modifiedContent = originalContent + '\n(base)';
                }

                if (modifiedContent !== originalContent) {
                    await textarea.fill(modifiedContent);
                }
            }

            await new Promise(r => setTimeout(r, 100));
        }

        // Verify checkboxes
        const renumberEnabled = await ensureCheckboxChecked(page, 'Renumber execution counts');

        // Capture expected cells from UI BEFORE clicking apply
        console.log('\n=== Capturing expected cells from UI ===');
        const expectedCells = await collectExpectedCellsFromUI(page, {
            resolveConflictChoice: async (row, conflictIndex, rowIndex) => {
                const resInfo = resolutionChoices.get(conflictIndex);
                if (!resInfo) {
                    console.error(`Missing resolution info for conflict row ${rowIndex}`);
                    throw new Error(`Missing resolution info for conflict row ${rowIndex}`);
                }
                return { choice: resInfo.choice, chosenCellType: resInfo.chosenCellType };
            },
            includeMetadata: true,
            includeOutputs: true,
        });
        console.log(`Captured ${expectedCells.length} cells from UI`);

        // Filter to non-deleted cells (include empty-source cells - they are valid)
        const expectedNonDeletedCells = expectedCells.filter(c => !c.isDeleted);
        console.log(`Expected ${expectedNonDeletedCells.length} cells in final notebook`);

        // Apply resolution and verify notebook
        console.log('\n=== Verifying UI matches disk ===');
        const resolvedNotebook = await applyResolutionAndReadNotebook(page, conflictFile);
        assertNotebookMatches(expectedNonDeletedCells, resolvedNotebook, {
            expectedLabel: 'Expected from UI',
            compareMetadata: true,
            compareExecutionCounts: true,
            renumberEnabled,
        });

        // Verify notebook structure
        validateNotebookStructure(resolvedNotebook);

        console.log('\n=== TEST PASSED ===');
        console.log(`✓ ${expectedNonDeletedCells.length} cells verified`);
        console.log('✓ All sources match');
        console.log('✓ All types match');
        console.log('✓ Notebook structure valid');

    } finally {
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
