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

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright';
import {
    type TestConfig,
    getCellSource,
    waitForServer,
    waitForSession,
    waitForFileWrite,
    validateNotebookStructure,
} from './testHelpers';
import {
    type MergeSide,
    verifyAllConflictsMatchSide,
    getResolvedCount,
    ensureCheckboxChecked,
    waitForAllConflictsResolved,
    getColumnCell,
    getColumnCellType,
} from './integrationUtils';

function gitShow(cwd: string, ref: string): string {
    return execFileSync('git', ['show', ref], { cwd, encoding: 'utf8' });
}

function normalizeCell(cell: any): { source: string; cellType: string; metadata: Record<string, unknown> } {
    return {
        source: getCellSource(cell),
        cellType: cell?.cell_type || 'code',
        metadata: cell?.metadata || {},
    };
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

async function buildExpectedCellsFromUI(
    page: import('playwright').Page
): Promise<Array<{ source: string; cellType: string }>> {
    const rows = page.locator('.merge-row');
    const count = await rows.count();
    const expected: Array<{ source: string; cellType: string }> = [];

    for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const className = await row.getAttribute('class') || '';
        const isConflict = className.includes('conflict-row');
        const isIdentical = className.includes('identical-row');

        if (isIdentical) {
            const rawSource = await row.getAttribute('data-raw-source') || '';
            const cellType = await row.getAttribute('data-cell-type') || 'code';
            expected.push({ source: rawSource, cellType });
            continue;
        }

        if (isConflict) {
            const isDeleted = await row.locator('.resolved-cell.resolved-deleted').count() > 0;
            if (isDeleted) continue;

            const textarea = row.locator('.resolved-content-input');
            if (await textarea.count() === 0) {
                throw new Error(`Row ${i}: missing resolved content input`);
            }
            const resolvedContent = await textarea.inputValue();

            const selectedButton = row.locator('.btn-resolve.selected');
            const selectedText = (await selectedButton.textContent()) || '';
            const normalized = selectedText.toLowerCase();
            let side: MergeSide | null = null;
            if (normalized.includes('base')) side = 'base';
            else if (normalized.includes('current')) side = 'current';
            else if (normalized.includes('incoming')) side = 'incoming';

            const cellType = side ? await getColumnCellType(row, side) : 'code';
            expected.push({ source: resolvedContent, cellType });
            continue;
        }
    }

    return expected;
}

export async function run(): Promise<void> {
    console.log('Starting MergeNB Take-All Buttons Integration Test...');

    let browser;
    let page: import('playwright').Page | undefined;

    try {
        // Setup: Read config and open conflict file
        const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');
        const config: TestConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        const action = config.params?.action;
        const mode = config.params?.mode || 'all';
        const manualChoice = config.params?.manualChoice as MergeSide | undefined;
        const manualCount = config.params?.manualCount ?? 2;
        if (action !== 'base' && action !== 'current' && action !== 'incoming') {
            throw new Error(`Invalid or missing action param. Expected 'base'|'current'|'incoming', got '${action}'`);
        }
        console.log(`Running test variant: Take All ${action.toUpperCase()} (${mode})`);

        const workspacePath = config.workspacePath;
        const conflictFile = path.join(workspacePath, 'conflict.ipynb');

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

        const doc = await vscode.workspace.openTextDocument(conflictFile);
        await vscode.window.showTextDocument(doc);
        await new Promise(r => setTimeout(r, 1000));

        // Clean up any existing port file
        const tmpDir = process.env.TMPDIR || process.env.TMP || '/tmp';
        const portFilePath = path.join(tmpDir, 'mergenb-server-port');
        try { fs.unlinkSync(portFilePath); } catch { /* ignore */ }

        // Execute command and wait for server
        console.log('Executing merge-nb.findConflicts command...');
        vscode.commands.executeCommand('merge-nb.findConflicts');

        const serverPort = await waitForServer(portFilePath, fs);
        console.log(`Server started on port ${serverPort}`);

        const sessionId = await waitForSession(serverPort);
        console.log(`Session created: ${sessionId}`);

        // Launch browser
        browser = await chromium.launch({ headless: true });
        const p = await browser.newPage();
        page = p;

        const sessionUrl = `http://127.0.0.1:${serverPort}/?session=${sessionId}`;
        await p.goto(sessionUrl);
        await new Promise(r => setTimeout(r, 3000));

        await p.waitForSelector('.header-title', { timeout: 15000 });
        const title = await p.locator('.header-title').textContent();
        if (title !== 'MergeNB') {
            throw new Error(`Expected header 'MergeNB', got '${title}'`);
        }

        await new Promise(r => setTimeout(r, 1000));

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
        const expectedCellsFromUI = await buildExpectedCellsFromUI(p);

        // ============================================================
        // Apply Resolution
        // ============================================================
        await ensureCheckboxChecked(p, 'Mark as resolved');

        console.log('\n=== Applying resolution ===');
        const applyButton = p.locator('button.btn-primary:has-text("Apply Resolution")');
        await applyButton.waitFor({ timeout: 5000 });

        if (await applyButton.isDisabled()) {
            throw new Error('Apply Resolution button is disabled');
        }

        await applyButton.click();
        await new Promise(r => setTimeout(r, 3000));

        // Wait for file write
        const fileWritten = await waitForFileWrite(conflictFile, fs);
        if (!fileWritten) {
            console.log('Warning: Could not confirm file write, proceeding anyway');
        }

        // ============================================================
        // Verify notebook on disk
        // ============================================================
        console.log('\n=== Verifying UI matches disk ===');
        const notebookContent = fs.readFileSync(conflictFile, 'utf8');
        const resolvedNotebook = JSON.parse(notebookContent);

        if (mode === 'unresolved') {
            console.log(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
            console.log(`Expected from UI: ${expectedCellsFromUI.length} cells`);

            if (resolvedNotebook.cells.length !== expectedCellsFromUI.length) {
                throw new Error(`Cell count mismatch: expected ${expectedCellsFromUI.length}, got ${resolvedNotebook.cells.length}`);
            }

            let sourceMismatches = 0;
            let typeMismatches = 0;

            for (let i = 0; i < expectedCellsFromUI.length; i++) {
                const expected = expectedCellsFromUI[i];
                const actual = normalizeCell(resolvedNotebook.cells[i]);

                if (expected.source !== actual.source) {
                    sourceMismatches++;
                    console.log(`Source mismatch at cell ${i}:`);
                    console.log(`  Expected: "${expected.source.substring(0, 80).replace(/\\n/g, '\\\\n')}..."`);
                    console.log(`  Actual:   "${actual.source.substring(0, 80).replace(/\\n/g, '\\\\n')}..."`);
                }
                if (expected.cellType !== actual.cellType) {
                    typeMismatches++;
                    console.log(`Type mismatch at cell ${i}: expected ${expected.cellType}, got ${actual.cellType}`);
                }
            }

            if (sourceMismatches > 0) {
                throw new Error(`${sourceMismatches} cells have source mismatches`);
            }
            if (typeMismatches > 0) {
                throw new Error(`${typeMismatches} cells have type mismatches`);
            }
        } else {
            console.log(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
            console.log(`Expected from "${action}": ${targetNotebook.cells.length} cells`);

            if (resolvedNotebook.cells.length !== targetNotebook.cells.length) {
                throw new Error(`Cell count mismatch: expected ${targetNotebook.cells.length}, got ${resolvedNotebook.cells.length}`);
            }

            let sourceMismatches = 0;
            let typeMismatches = 0;
            let metadataMismatches = 0;

            for (let i = 0; i < targetNotebook.cells.length; i++) {
                const expected = normalizeCell(targetNotebook.cells[i]);
                const actual = normalizeCell(resolvedNotebook.cells[i]);

                if (expected.source !== actual.source) {
                    sourceMismatches++;
                    console.log(`Source mismatch at cell ${i}:`);
                    console.log(`  Expected: "${expected.source.substring(0, 80).replace(/\\n/g, '\\\\n')}..."`);
                    console.log(`  Actual:   "${actual.source.substring(0, 80).replace(/\\n/g, '\\\\n')}..."`);
                }
                if (expected.cellType !== actual.cellType) {
                    typeMismatches++;
                    console.log(`Type mismatch at cell ${i}: expected ${expected.cellType}, got ${actual.cellType}`);
                }
                if (JSON.stringify(expected.metadata) !== JSON.stringify(actual.metadata)) {
                    metadataMismatches++;
                    console.log(`Metadata mismatch at cell ${i}`);
                }
            }

            if (sourceMismatches > 0) {
                throw new Error(`${sourceMismatches} cells have source mismatches`);
            }
            if (typeMismatches > 0) {
                throw new Error(`${typeMismatches} cells have type mismatches`);
            }
            if (metadataMismatches > 0) {
                throw new Error(`${metadataMismatches} cells have metadata mismatches`);
            }
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
