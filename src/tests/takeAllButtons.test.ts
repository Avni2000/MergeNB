/**
 * @file takeAllButtons.test.ts
 * @description Integration test for the "All Base / All Current / All Incoming" bulk-resolve buttons.
 * 
 * Runs one of the following tests based on config:
 * 1. "all-base": Clicks "All Base" → verifies textareas → verifies file override
 * 2. "all-current": Clicks "All Current" → verifies textareas → verifies file override
 * 3. "all-incoming": Clicks "All Incoming" → verifies textareas → verifies file override
 * 
 * Config params: { action: 'base' | 'current' | 'incoming' }
 */

import { execFileSync } from 'child_process';
import {
    getCellSource,
    validateNotebookStructure,
} from './testHelpers';
import {
    type MergeSide,
    verifyAllConflictsMatchSide,
    getResolvedCount,
    waitForAllConflictsResolved,
    getColumnCell,
    getColumnCellType,
    collectExpectedCellsFromUI,
} from './integrationUtils';
import {
    readTestConfig,
    setupConflictResolver,
    applyResolutionAndReadNotebook,
    buildExpectedCellsFromNotebook,
    assertNotebookMatches,
} from './testHarness';

function gitShow(cwd: string, ref: string): string {
    return execFileSync('git', ['show', ref], { cwd, encoding: 'utf8' });
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

async function selectManualRows(
    page: import('playwright').Page,
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
    page: import('playwright').Page,
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
            const actualValue = await textarea.inputValue();
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
        const actualValue = await textarea.inputValue();
        if (actualValue !== expectedSource) {
            throw new Error(`Row ${i}: take-all content mismatch for ${action}`);
        }
    }
}

export async function run(): Promise<void> {
    console.log('Starting MergeNB Take-All Buttons Integration Test...');

    let browser;
    let page: import('playwright').Page | undefined;

    try {
        // Setup: Read config and open conflict file
        const config = readTestConfig();

        const action = config.params?.action;
        const mode = config.params?.mode || 'all';
        const manualChoice = config.params?.manualChoice as MergeSide | undefined;
        const manualCount = config.params?.manualCount ?? 2;
        if (action !== 'base' && action !== 'current' && action !== 'incoming') {
            throw new Error(`Invalid or missing action param. Expected 'base'|'current'|'incoming', got '${action}'`);
        }
        console.log(`Running test variant: Take All ${action.toUpperCase()} (${mode})`);

        const workspacePath = config.workspacePath;

        // Load source notebooks from git stages for verification
        console.log('Loading source notebooks from git history...');
        // :1: = Base, :2: = Current, :3: = Incoming
        const baseContent = gitShow(workspacePath, ':1:conflict.ipynb');
        const currentContent = gitShow(workspacePath, ':2:conflict.ipynb');
        const incomingContent = gitShow(workspacePath, ':3:conflict.ipynb');

        const sourceNotebooks = {
            base: JSON.parse(baseContent),
            current: JSON.parse(currentContent),
            incoming: JSON.parse(incomingContent)
        };
        const targetNotebook = sourceNotebooks[action as MergeSide];
        console.log(`Loaded source notebooks. Target ('${action}') has ${targetNotebook.cells.length} cells.`);

        const session = await setupConflictResolver(config);
        browser = session.browser;
        const p = session.page;
        page = p;
        const conflictFile = session.conflictFile;

        // Verify we have conflict rows
        const conflictRowElements = p.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRowElements.count();
        console.log(`Found ${conflictCount} conflict rows`);

        if (conflictCount === 0) {
            throw new Error('Should have at least one conflict row');
        }

        const initial = await getResolvedCount(p);
        console.log(`Initial resolution state: ${initial.resolved}/${initial.total}`);

        // Resolve a few conflicts manually before take-all if in 'unresolved' mode
        let manualSelections: Array<{ index: number; expectedSource: string; expectedCellType: string }> = [];
        if (mode === 'unresolved') {
            const manualSide = manualChoice || 'incoming';
            console.log(`Resolving ${manualCount} conflicts manually to "${manualSide}"...`);
            manualSelections = await selectManualRows(p, manualSide, manualCount);
            console.log(`Manually resolved rows: ${manualSelections.map(m => m.index).join(', ')}`);
        }

        // ============================================================
        // EXECUTE ACTION
        // ============================================================
        const buttonLabel = `All ${action.charAt(0).toUpperCase() + action.slice(1)}`; // e.g., "All Base"
        console.log(`\n=== Clicking "${buttonLabel}" ===`);

        const actionButton = p.locator(`button:has-text("${buttonLabel}")`);
        await actionButton.waitFor({ timeout: 5000 });
        await actionButton.click();

        // Verify resolution count
        const afterAction = await waitForAllConflictsResolved(p);
        console.log(`After "${buttonLabel}": ${afterAction.resolved}/${afterAction.total}`);
        if (afterAction.resolved !== afterAction.total) {
            throw new Error(`Expected all conflicts resolved after "${buttonLabel}", got ${afterAction.resolved}/${afterAction.total}`);
        }

        // Verify textareas match UI columns
        if (mode === 'unresolved') {
            await verifyTakeAllUnresolved(p, action as MergeSide, manualSelections);
            console.log(`  ✓ Take-all respected manual resolutions and applied to unresolved rows only`);
        } else {
            const result = await verifyAllConflictsMatchSide(p, action as MergeSide);
            console.log(`  Matches: ${result.matchCount}, Deletes: ${result.deleteCount}`);
            if (result.mismatches.length > 0) {
                for (const m of result.mismatches) console.error(`  MISMATCH: ${m}`);
                throw new Error(`${result.mismatches.length} mismatches after "${buttonLabel}"`);
            }
            console.log(`  ✓ All resolved cells match ${action}-side content in UI`);
        }

        // Build expected resolved cells from UI before applying
        const expectedCellsFromUI = await collectExpectedCellsFromUI(p, {
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
        const resolvedNotebook = await applyResolutionAndReadNotebook(p, conflictFile);

        // ============================================================
        // Verify notebook on disk
        // ============================================================
        console.log('\n=== Verifying UI matches disk ===');

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

        console.log('\n=== TEST PASSED ===');
        console.log(`✓ "All ${action.toUpperCase()}" action verified end-to-end`);

    } finally {
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
