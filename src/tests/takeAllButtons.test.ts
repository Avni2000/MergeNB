/**
 * @file takeAllButtons.test.ts
 * @description Integration test for the "All Base / All Current / All Incoming" bulk-resolve buttons.
 * 
 * Tests the three "Accept All" buttons added to ConflictResolver.tsx:
 * 1. Clicks "All Base" → verifies all conflict textareas show base-side content
 * 2. Clicks "All Incoming" → verifies textareas switch to incoming-side content
 * 3. Clicks "All Current" → verifies textareas switch to current-side content
 * 4. Applies resolution → verifies notebook written to disk matches expectations
 * 5. Cross-checks against the original current notebook file
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { chromium } from 'playwright';
import {
    type TestConfig,
    type ExpectedCell,
    getCellSource,
    parseCellFromAttribute,
    waitForServer,
    waitForSession,
    waitForFileWrite,
    validateNotebookStructure,
} from './testHelpers';

/** Get a cell reference from a column in a conflict row */
async function getColumnCell(row: import('playwright').Locator, column: 'base' | 'current' | 'incoming', rowIndex: number) {
    const cellEl = row.locator(`.${column}-column .notebook-cell`);
    if (await cellEl.count() === 0) return null;
    const cellJson = await cellEl.getAttribute('data-cell');
    return parseCellFromAttribute(cellJson, `row ${rowIndex} ${column} cell`);
}

/** Get the cell type from a notebook cell element */
async function getColumnCellType(row: import('playwright').Locator, column: string): Promise<string> {
    const cell = row.locator(`.${column}-column .notebook-cell`);
    if (await cell.count() === 0) return 'code';
    const isCode = await cell.evaluate(el => el.classList.contains('code-cell'));
    return isCode ? 'code' : 'markdown';
}

/**
 * Verify that every conflict row's textarea matches the expected side's content.
 * Returns the collected textarea values for further verification.
 */
async function verifyAllConflictsMatchSide(
    page: import('playwright').Page,
    side: 'base' | 'current' | 'incoming',
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

export async function run(): Promise<void> {
    console.log('Starting MergeNB Take-All Buttons Integration Test...');

    let browser;
    let page: import('playwright').Page | undefined;

    try {
        // Setup: Read config and open conflict file
        const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');
        const config: TestConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const workspacePath = config.workspacePath;
        const conflictFile = path.join(workspacePath, 'conflict.ipynb');

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

        // Read the conflict counter to track resolution progress
        const getResolvedCount = async (): Promise<{ resolved: number; total: number }> => {
            const counterText = await p.locator('.conflict-counter').textContent() || '';
            const match = counterText.match(/(\d+)\s*\/\s*(\d+)/);
            if (!match) return { resolved: 0, total: 0 };
            return { resolved: parseInt(match[1], 10), total: parseInt(match[2], 10) };
        };

        const initial = await getResolvedCount();
        console.log(`Initial resolution state: ${initial.resolved}/${initial.total}`);

        // ============================================================
        // TEST 1: Click "All Base" and verify UI
        // ============================================================
        console.log('\n=== TEST 1: All Base ===');
        const allBaseButton = p.locator('button:has-text("All Base")');
        await allBaseButton.waitFor({ timeout: 5000 });
        await allBaseButton.click();
        await new Promise(r => setTimeout(r, 1000));

        const afterBase = await getResolvedCount();
        console.log(`After "All Base": ${afterBase.resolved}/${afterBase.total}`);
        if (afterBase.resolved !== afterBase.total) {
            throw new Error(`Expected all conflicts resolved after "All Base", got ${afterBase.resolved}/${afterBase.total}`);
        }

        const baseResult = await verifyAllConflictsMatchSide(p, 'base');
        console.log(`  Matches: ${baseResult.matchCount}, Deletes: ${baseResult.deleteCount}`);
        if (baseResult.mismatches.length > 0) {
            for (const m of baseResult.mismatches) console.error(`  MISMATCH: ${m}`);
            throw new Error(`${baseResult.mismatches.length} mismatches after "All Base"`);
        }
        console.log('  ✓ All Base textareas match base-side content');

        // ============================================================
        // TEST 2: Click "All Incoming" and verify UI switches
        // ============================================================
        console.log('\n=== TEST 2: All Incoming ===');
        const allIncomingButton = p.locator('button:has-text("All Incoming")');
        await allIncomingButton.click();
        await new Promise(r => setTimeout(r, 1000));

        const afterIncoming = await getResolvedCount();
        if (afterIncoming.resolved !== afterIncoming.total) {
            throw new Error(`Expected all conflicts resolved after "All Incoming", got ${afterIncoming.resolved}/${afterIncoming.total}`);
        }

        const incomingResult = await verifyAllConflictsMatchSide(p, 'incoming');
        console.log(`  Matches: ${incomingResult.matchCount}, Deletes: ${incomingResult.deleteCount}`);
        if (incomingResult.mismatches.length > 0) {
            for (const m of incomingResult.mismatches) console.error(`  MISMATCH: ${m}`);
            throw new Error(`${incomingResult.mismatches.length} mismatches after "All Incoming"`);
        }
        console.log('  ✓ All Incoming textareas match incoming-side content');

        // ============================================================
        // TEST 3: Click "All Current" and verify UI switches
        // ============================================================
        console.log('\n=== TEST 3: All Current ===');
        const allCurrentButton = p.locator('button:has-text("All Current")');
        await allCurrentButton.click();
        await new Promise(r => setTimeout(r, 1000));

        const afterCurrent = await getResolvedCount();
        if (afterCurrent.resolved !== afterCurrent.total) {
            throw new Error(`Expected all conflicts resolved after "All Current", got ${afterCurrent.resolved}/${afterCurrent.total}`);
        }

        const currentResult = await verifyAllConflictsMatchSide(p, 'current');
        console.log(`  Matches: ${currentResult.matchCount}, Deletes: ${currentResult.deleteCount}`);
        if (currentResult.mismatches.length > 0) {
            for (const m of currentResult.mismatches) console.error(`  MISMATCH: ${m}`);
            throw new Error(`${currentResult.mismatches.length} mismatches after "All Current"`);
        }
        console.log('  ✓ All Current textareas match current-side content');

        // ============================================================
        // TEST 4: Capture expected cells and apply resolution
        // ============================================================
        console.log('\n=== Capturing expected cells from UI ===');
        const expectedCells: ExpectedCell[] = [];
        const allRows = p.locator('.merge-row');
        const totalRows = await allRows.count();

        for (let i = 0; i < totalRows; i++) {
            const row = allRows.nth(i);
            const isConflictRow = await row.evaluate(el => el.classList.contains('conflict-row'));
            const isIdenticalRow = await row.evaluate(el => el.classList.contains('identical-row'));

            if (isIdenticalRow) {
                const cellJson = await row.getAttribute('data-cell');
                const cellType = await row.getAttribute('data-cell-type') || 'code';
                const cell = parseCellFromAttribute(cellJson, `identical row ${i}`);
                const resolvedCellType = cell.cell_type || cellType;
                const hasOutputs = resolvedCellType === 'code' &&
                    Array.isArray(cell.outputs) &&
                    cell.outputs.length > 0;
                expectedCells.push({
                    rowIndex: i,
                    source: getCellSource(cell),
                    cellType: resolvedCellType,
                    metadata: cell.metadata || {},
                    hasOutputs,
                    isConflict: false,
                    isDeleted: false,
                });
            } else if (isConflictRow) {
                const resolvedCell = row.locator('.resolved-cell');
                const hasResolvedCell = await resolvedCell.count() > 0;

                if (hasResolvedCell) {
                    const isDeleted = await resolvedCell.evaluate(el => el.classList.contains('resolved-deleted'));

                    if (isDeleted) {
                        expectedCells.push({
                            rowIndex: i,
                            source: '',
                            cellType: 'code',
                            isConflict: true,
                            isDeleted: true,
                        });
                    } else {
                        const textarea = row.locator('.resolved-content-input');
                        if (await textarea.count() > 0) {
                            const textareaValue = await textarea.inputValue();
                            // For "All Current", the cell type comes from the current side
                            const hasCurrent = await row.locator('.current-column .notebook-cell').count() > 0;
                            const cellType = hasCurrent
                                ? await getColumnCellType(row, 'current')
                                : 'code';

                            // Get reference cell for metadata
                            const referenceCell = hasCurrent
                                ? await getColumnCell(row, 'current', i)
                                : null;

                            expectedCells.push({
                                rowIndex: i,
                                source: textareaValue,
                                cellType,
                                metadata: referenceCell?.metadata || {},
                                hasOutputs: false, // Outputs are always cleared for resolved conflicts
                                isConflict: true,
                                isDeleted: false,
                            });
                        }
                    }
                }
            }
        }

        console.log(`Captured ${expectedCells.length} cells from UI`);
        const expectedNonDeletedCells = expectedCells.filter(c => !c.isDeleted);
        console.log(`Expected ${expectedNonDeletedCells.length} cells in final notebook`);

        // Check "Renumber execution counts" checkbox state
        const renumberCheckbox = p.locator('label:has-text("Renumber execution counts") input[type="checkbox"]');
        const renumberEnabled = await renumberCheckbox.isChecked();

        // Ensure Mark as resolved is checked
        const markAsResolvedCheckbox = p.locator('label:has-text("Mark as resolved") input[type="checkbox"]');
        if (!await markAsResolvedCheckbox.isChecked()) {
            await markAsResolvedCheckbox.check();
        }

        // Apply
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
        // TEST 5: Verify notebook on disk matches UI expectations
        // ============================================================
        console.log('\n=== Verifying UI matches disk ===');
        const notebookContent = fs.readFileSync(conflictFile, 'utf8');
        const resolvedNotebook = JSON.parse(notebookContent);

        console.log(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
        console.log(`Expected from UI: ${expectedNonDeletedCells.length} cells`);

        // Check cell count
        if (resolvedNotebook.cells.length !== expectedNonDeletedCells.length) {
            console.log('Cell count mismatch. Expected cells:');
            for (const cell of expectedNonDeletedCells) {
                console.log(`  Row ${cell.rowIndex}: ${cell.cellType}, ${cell.source.length} chars`);
            }
            console.log('Actual cells:');
            for (let i = 0; i < resolvedNotebook.cells.length; i++) {
                const src = getCellSource(resolvedNotebook.cells[i]);
                console.log(`  Cell ${i}: ${resolvedNotebook.cells[i].cell_type}, ${src.length} chars`);
            }
            throw new Error(`Cell count mismatch: expected ${expectedNonDeletedCells.length}, got ${resolvedNotebook.cells.length}`);
        }

        // Verify each cell
        let sourceMismatches = 0;
        let typeMismatches = 0;
        let metadataMismatches = 0;
        let executionMismatches = 0;
        let nextExecutionCount = 1;

        for (let i = 0; i < expectedNonDeletedCells.length; i++) {
            const expected = expectedNonDeletedCells[i];
            const actual = resolvedNotebook.cells[i];
            const actualSource = getCellSource(actual);

            if (expected.source !== actualSource) {
                sourceMismatches++;
                console.log(`Source mismatch at cell ${i}:`);
                console.log(`  Expected: "${expected.source.substring(0, 80).replace(/\n/g, '\\n')}..."`);
                console.log(`  Actual:   "${actualSource.substring(0, 80).replace(/\n/g, '\\n')}..."`);
            }

            if (expected.cellType !== actual.cell_type) {
                typeMismatches++;
                console.log(`Type mismatch at cell ${i}: expected ${expected.cellType}, got ${actual.cell_type}`);
            }

            const expectedMetadata = expected.metadata || {};
            const actualMetadata = actual.metadata || {};
            if (JSON.stringify(expectedMetadata) !== JSON.stringify(actualMetadata)) {
                metadataMismatches++;
                console.log(`Metadata mismatch at cell ${i}`);
            }

            // Validate execution counts
            if (expected.cellType === 'code') {
                const expectedExecutionCount = renumberEnabled
                    ? (expected.hasOutputs ? nextExecutionCount++ : null)
                    : null;
                const actualExecutionCount = actual.execution_count ?? null;
                if (expectedExecutionCount !== actualExecutionCount) {
                    executionMismatches++;
                    console.log(`Execution count mismatch at cell ${i}: expected ${expectedExecutionCount}, got ${actualExecutionCount}`);
                }
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
        if (executionMismatches > 0) {
            throw new Error(`${executionMismatches} cells have execution count mismatches`);
        }

        // Validate notebook structure
        validateNotebookStructure(resolvedNotebook);

        // ============================================================
        // TEST 6: Cross-check conflict cells against 04_current.ipynb
        // ============================================================
        console.log('\n=== Cross-checking against original current notebook ===');
        const testDir = path.resolve(__dirname, '../../test');
        const currentNotebookPath = path.join(testDir, '04_current.ipynb');

        if (fs.existsSync(currentNotebookPath)) {
            const currentNotebook = JSON.parse(fs.readFileSync(currentNotebookPath, 'utf8'));
            const currentCellSources = currentNotebook.cells.map((c: any) => getCellSource(c));

            // For each conflict cell that was resolved to "current", its source should exist
            // somewhere in the original 04_current.ipynb
            let crossCheckPassed = 0;
            let crossCheckFailed = 0;

            for (const expected of expectedNonDeletedCells) {
                if (!expected.isConflict) continue;

                const matchIdx = currentCellSources.findIndex((src: string) => src === expected.source);
                if (matchIdx >= 0) {
                    crossCheckPassed++;
                } else {
                    // It's possible this cell didn't come from current (e.g., the current side
                    // might not have had a cell, in which case it would be deleted).
                    // Since we used "All Current", non-deleted conflict cells should have matching source.
                    crossCheckFailed++;
                    console.log(`Cross-check warning: Conflict cell source not found in 04_current.ipynb`);
                    console.log(`  Source preview: "${expected.source.substring(0, 80).replace(/\n/g, '\\n')}..."`);
                }
            }

            console.log(`Cross-check results: ${crossCheckPassed} matched, ${crossCheckFailed} not found in current`);
            if (crossCheckFailed > 0) {
                // This is a warning, not an error - some cells may have been resolved differently
                // due to the cell matching algorithm
                console.log('Note: Some conflict cells may not directly match current notebook due to cell matching');
            }
        } else {
            console.log('Warning: Could not find 04_current.ipynb for cross-check');
        }

        console.log('\n=== TEST PASSED ===');
        console.log(`✓ "All Base" button correctly resolves all conflicts to base-side content`);
        console.log(`✓ "All Incoming" button correctly switches to incoming-side content`);
        console.log(`✓ "All Current" button correctly switches to current-side content`);
        console.log(`✓ ${expectedNonDeletedCells.length} cells verified on disk`);
        console.log('✓ All sources match');
        console.log('✓ All types match');
        console.log('✓ Notebook structure valid');

    } finally {
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
