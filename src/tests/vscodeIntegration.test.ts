/**
 * End-to-end integration test that runs inside VS Code extension host.
 * Verifies that UI content (textareas + unified cell sources) matches the notebook written to disk.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { chromium } from 'playwright';

interface HealthResponse {
    status: string;
    port: number;
    activeSessions: number;
    activeConnections: number;
    sessionIds: string[];
}

interface ExpectedCell {
    rowIndex: number;
    source: string;
    cellType: string;
    isConflict: boolean;
    isDeleted: boolean;
    metadata?: Record<string, unknown>;
    hasOutputs?: boolean; // Whether the cell will have outputs after resolution
}

function checkHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 500 }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function getCellSource(cell: any): string {
    if (!cell) return '';
    return Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
}

function parseCellFromAttribute(cellJson: string | null, context: string): any {
    if (!cellJson) {
        console.error(`Missing data-cell attribute for ${context}`);
        throw new Error(`Missing data-cell attribute for ${context}`);
    }
    try {
        return JSON.parse(decodeURIComponent(cellJson));
    } catch (err) {
        console.error(`Failed to parse cell JSON for ${context}`, err);
        throw new Error(`Failed to parse cell JSON for ${context}`);
    }
}

function getHealthInfo(port: number): Promise<HealthResponse | null> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve(null);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

export async function run(): Promise<void> {
    console.log('Starting MergeNB VS Code Integration Test...');
    
    let browser;
    let page;
    
    try {
        // Setup: Read config and open conflict file
        const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
        
        let serverPort = 0;
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                if (fs.existsSync(portFilePath)) {
                    const portStr = fs.readFileSync(portFilePath, 'utf8').trim();
                    serverPort = parseInt(portStr, 10);
                    if (serverPort > 0 && await checkHealth(serverPort)) {
                        break;
                    }
                    serverPort = 0;
                }
            } catch { /* continue polling */ }
        }
        
        if (serverPort === 0) {
            throw new Error('Web server did not start');
        }
        
        // Wait for session
        let sessionId = '';
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            const healthInfo = await getHealthInfo(serverPort);
            if (healthInfo && healthInfo.sessionIds.length > 0) {
                sessionId = healthInfo.sessionIds[0];
                break;
            }
        }
        
        if (!sessionId) {
            throw new Error('No session was created');
        }
        
        // Launch browser and navigate
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();
        
        const sessionUrl = `http://127.0.0.1:${serverPort}/?session=${sessionId}`;
        await page.goto(sessionUrl);
        await new Promise(r => setTimeout(r, 3000));
        
        await page.waitForSelector('.header-title', { timeout: 15000 });
        const title = await page.locator('.header-title').textContent();
        if (title !== 'MergeNB') {
            throw new Error(`Expected header 'MergeNB', got '${title}'`);
        }
        
        await new Promise(r => setTimeout(r, 1000));
        
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
        const resolutionChoices: Map<number, { choice: string; chosenCellType: string }> = new Map();
        
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
            const getColumnCellType = async (column: string): Promise<string> => {
                const cell = row.locator(`.${column}-column .notebook-cell`);
                if (await cell.count() === 0) return 'code';
                const isCode = await cell.evaluate(el => el.classList.contains('code-cell'));
                return isCode ? 'code' : 'markdown';
            };
            
            const baseCellType = hasBase ? await getColumnCellType('base') : 'code';
            const currentCellType = hasCurrent ? await getColumnCellType('current') : 'code';
            const incomingCellType = hasIncoming ? await getColumnCellType('incoming') : 'code';
            
            let buttonToClick: string;
            let choice: string;
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
            
            if (isDeleteAction) {
                await row.locator('.resolved-deleted').waitFor({ timeout: 5000 });
            } else {
                await row.locator('.resolved-content-input').waitFor({ timeout: 5000 });
                
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
        const markAsResolvedCheckbox = page.locator('label:has-text("Mark as resolved") input[type="checkbox"]');
        if (!await markAsResolvedCheckbox.isChecked()) {
            await markAsResolvedCheckbox.check();
        }
        
        const renumberCheckbox = page.locator('label:has-text("Renumber execution counts") input[type="checkbox"]');
        if (!await renumberCheckbox.isChecked()) {
            await renumberCheckbox.check();
        }
        const renumberEnabled = await renumberCheckbox.isChecked();

        const getColumnCell = async (row: import('playwright').Locator, column: 'base' | 'current' | 'incoming', rowIndex: number) => {
            const cellEl = row.locator(`.${column}-column .notebook-cell`);
            if (await cellEl.count() === 0) return null;
            const cellJson = await cellEl.getAttribute('data-cell');
            return parseCellFromAttribute(cellJson, `row ${rowIndex} ${column} cell`);
        };
        
        // Capture expected cells from UI BEFORE clicking apply
        console.log('\n=== Capturing expected cells from UI ===');
        const expectedCells: ExpectedCell[] = [];
        const allRowsForCapture = page.locator('.merge-row');
        const totalRows = await allRowsForCapture.count();
        
        let conflictIdx = 0;
        for (let i = 0; i < totalRows; i++) {
            const row = allRowsForCapture.nth(i);
            const isConflictRow = await row.evaluate(el => el.classList.contains('conflict-row'));
            const isIdenticalRow = await row.evaluate(el => el.classList.contains('identical-row'));
            
            if (isIdenticalRow) {
                const cellJson = await row.getAttribute('data-cell');
                const cellType = await row.getAttribute('data-cell-type') || 'code';
                const cell = parseCellFromAttribute(cellJson, `identical row ${i}`);
                const resolvedCellType = cell.cell_type || cellType;
                // Identical cells retain their original outputs
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
                    isDeleted: false
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
                            isDeleted: true
                        });
                    } else {
                        const textarea = row.locator('.resolved-content-input');
                        if (await textarea.count() > 0) {
                            const textareaValue = await textarea.inputValue();
                            // Get cell type from resolution choice
                            const resInfo = resolutionChoices.get(conflictIdx);
                            if (!resInfo) {
                                console.error(`Missing resolution info for conflict row ${i}`);
                                throw new Error(`Missing resolution info for conflict row ${i}`);
                            }
                            const cellType = resInfo.chosenCellType || 'code';
                            let referenceCell: any | null = null;
                            switch (resInfo.choice) {
                                case 'base':
                                    referenceCell = await getColumnCell(row, 'base', i);
                                    break;
                                case 'current':
                                    referenceCell = await getColumnCell(row, 'current', i);
                                    break;
                                case 'incoming':
                                    referenceCell = await getColumnCell(row, 'incoming', i);
                                    break;
                                case 'both':
                                    referenceCell = await getColumnCell(row, 'current', i)
                                        || await getColumnCell(row, 'incoming', i)
                                        || await getColumnCell(row, 'base', i);
                                    break;
                                case 'delete':
                                    referenceCell = null;
                                    break;
                            }
                            if (!referenceCell) {
                                console.error(`Missing reference cell for conflict row ${i} (${resInfo.choice})`);
                                throw new Error(`Missing reference cell for conflict row ${i} (${resInfo.choice})`);
                            }
                            
                            // Resolved conflict cells have outputs cleared
                            expectedCells.push({
                                rowIndex: i,
                                source: textareaValue,
                                cellType,
                                metadata: referenceCell.metadata || {},
                                hasOutputs: false, // Outputs are always cleared for resolved conflicts
                                isConflict: true,
                                isDeleted: false
                            });
                        }
                    }
                }
                conflictIdx++;
            }
        }
        
        console.log(`Captured ${expectedCells.length} cells from UI`);
        
        // Filter to non-deleted cells (include empty-source cells - they are valid)
        const expectedNonDeletedCells = expectedCells.filter(c => !c.isDeleted);
        console.log(`Expected ${expectedNonDeletedCells.length} cells in final notebook`);
        
        // Apply resolution
        console.log('\n=== Applying resolution ===');
        const applyButton = page.locator('button.btn-primary:has-text("Apply Resolution")');
        await applyButton.waitFor({ timeout: 5000 });
        
        if (await applyButton.isDisabled()) {
            throw new Error('Apply Resolution button is disabled');
        }
        
        await applyButton.click();
        await new Promise(r => setTimeout(r, 3000));
        
        // Wait for file to be written
        let fileWritten = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const stat = fs.statSync(conflictFile);
                if (Date.now() - stat.mtimeMs < 10000) {
                    fileWritten = true;
                    break;
                }
            } catch { /* continue */ }
        }
        
        if (!fileWritten) {
            console.log('Warning: Could not confirm file write, proceeding anyway');
        }
        
        // Verify UI content matches disk
        console.log('\n=== Verifying UI matches disk ===');
        const notebookContent = fs.readFileSync(conflictFile, 'utf8');
        const resolvedNotebook = JSON.parse(notebookContent);
        
        console.log(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
        console.log(`Expected from UI: ${expectedNonDeletedCells.length} cells`);
        
        // Check cell count
        if (resolvedNotebook.cells.length !== expectedNonDeletedCells.length) {
            console.log('Cell count mismatch:');
            console.log('Expected cells:');
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
        
        // Check each cell source, type, metadata, and execution count
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

            // Validate execution counts (renumberExecutionCounts only numbers cells with outputs)
            if (expected.cellType === 'code') {
                const expectedExecutionCount = renumberEnabled
                    ? (expected.hasOutputs ? nextExecutionCount++ : null)
                    : null; // After resolution, all conflict cells have null initially
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
        
        // Verify notebook structure
        if (typeof resolvedNotebook.nbformat !== 'number') {
            throw new Error('Invalid notebook: missing nbformat');
        }
        if (typeof resolvedNotebook.nbformat_minor !== 'number') {
            throw new Error('Invalid notebook: missing nbformat_minor');
        }
        if (!resolvedNotebook.metadata || typeof resolvedNotebook.metadata !== 'object') {
            throw new Error('Invalid notebook: missing metadata');
        }
        if (!Array.isArray(resolvedNotebook.cells)) {
            throw new Error('Invalid notebook: cells not an array');
        }
        
        for (let i = 0; i < resolvedNotebook.cells.length; i++) {
            const cell = resolvedNotebook.cells[i];
            if (!cell.cell_type) throw new Error(`Cell ${i}: missing cell_type`);
            if (cell.source === undefined) throw new Error(`Cell ${i}: missing source`);
            if (!cell.metadata) throw new Error(`Cell ${i}: missing metadata`);
            if (cell.cell_type === 'code' && !Array.isArray(cell.outputs)) {
                throw new Error(`Cell ${i}: code cell missing outputs`);
            }
        }
        
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
