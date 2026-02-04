/**
 * @file vscodeIntegration.test.ts
 * @description Integration test that runs INSIDE VS Code extension host.
 * 
 * This test:
 * 1. Runs inside VS Code with the extension loaded
 * 2. Opens conflict.ipynb which has Git UU status
 * 3. Executes the merge-nb.findConflicts command
 * 4. Waits for the web server to start
 * 5. Uses Playwright to connect to the browser and capture row data
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { chromium } from 'playwright';

/** Captured row data from the UI */
interface CapturedRow {
    rowIndex: number;
    isConflict: boolean;
    testId: string;
    base: {
        exists: boolean;
        content: string | null;
        cellType: string | null;
    };
    current: {
        exists: boolean;
        content: string | null;
        cellType: string | null;
    };
    incoming: {
        exists: boolean;
        content: string | null;
        cellType: string | null;
    };
}

/** Health response from the server */
interface HealthResponse {
    status: string;
    port: number;
    activeSessions: number;
    activeConnections: number;
    sessionIds: string[];
}

/** Check if a server is running on a port by hitting the health endpoint */
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
    if (!cell) {
        return '';
    }
    return Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
}

/** Get health info including session IDs */
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

/**
 * Main test runner exported for @vscode/test-electron
 */
export async function run(): Promise<void> {
    console.log('Starting MergeNB VS Code Integration Test...');
    
    let browser;
    let page;
    
    try {
        // Read the test config to get workspace path
        const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const workspacePath = config.workspacePath;
        
        console.log(`Test workspace: ${workspacePath}`);
        
        // Open the conflict.ipynb file
        const conflictFile = path.join(workspacePath, 'conflict.ipynb');
        const doc = await vscode.workspace.openTextDocument(conflictFile);
        await vscode.window.showTextDocument(doc);
        
        // Wait a moment for the editor to be ready
        await new Promise(r => setTimeout(r, 1000));
        
        // Delete any existing port file
        const tmpDir = process.env.TMPDIR || process.env.TMP || '/tmp';
        const portFilePath = path.join(tmpDir, 'mergenb-server-port');
        try {
            fs.unlinkSync(portFilePath);
        } catch { /* ignore */ }
        
        // Execute the findConflicts command
        console.log('Executing merge-nb.findConflicts command...');
        
        // Run the command - it will start the web server and open a browser
        // Don't await - let it run in background while we wait for server
        vscode.commands.executeCommand('merge-nb.findConflicts');
        
        // Wait for the server to start by checking the port file
        let serverPort = 0;
        console.log('Waiting for web server to start (checking port file)...');
        
        // Poll until the port file appears (up to 30 seconds)
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 500));
            
            // Check if port file exists
            try {
                if (fs.existsSync(portFilePath)) {
                    const portStr = fs.readFileSync(portFilePath, 'utf8').trim();
                    serverPort = parseInt(portStr, 10);
                    if (serverPort > 0) {
                        console.log(`Found server port from file: ${serverPort}`);
                        // Verify it's actually running
                        const isHealthy = await checkHealth(serverPort);
                        if (isHealthy) {
                            console.log(`Server verified healthy on port ${serverPort}`);
                            break;
                        } else {
                            console.log(`Port ${serverPort} not ready yet...`);
                            serverPort = 0;
                        }
                    }
                }
            } catch {
                // File doesn't exist yet or can't be read
            }
        }
        
        if (serverPort === 0) {
            throw new Error('Web server did not start or could not be found');
        }
        
        // Wait for a session to be registered (the extension opens a session when command runs)
        console.log('Waiting for session to be registered...');
        let sessionId = '';
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            const healthInfo = await getHealthInfo(serverPort);
            if (healthInfo && healthInfo.sessionIds.length > 0) {
                sessionId = healthInfo.sessionIds[0];
                console.log(`Found session: ${sessionId}`);
                break;
            }
        }
        
        if (!sessionId) {
            throw new Error('No session was created by the extension');
        }
        
        // Launch Playwright browser
        console.log('Launching Playwright browser...');
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();
        
        // Enable console logging
        page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
        page.on('pageerror', err => console.error(`[Browser Error] ${err.message}`));
        
        // Navigate to the session URL
        const sessionUrl = `http://127.0.0.1:${serverPort}/?session=${sessionId}`;
        console.log(`Navigating to: ${sessionUrl}`);
        await page.goto(sessionUrl);
        
        // Wait for WebSocket to connect and conflict data to arrive
        console.log('Waiting for conflict data to load...');
        await new Promise(r => setTimeout(r, 3000));
        
        // Wait for UI to render
        await page.waitForSelector('.header-title', { timeout: 15000 });
        const title = await page.locator('.header-title').textContent();
        
        if (title !== 'MergeNB') {
            throw new Error(`Expected header 'MergeNB', got '${title}'`);
        }
        
        // Wait for rows to render
        await new Promise(r => setTimeout(r, 1000));
        
        // Capture all row information
        console.log('\n=== CAPTURING ROW DATA ===\n');
        
        const capturedRows: CapturedRow[] = [];
        const allRows = page.locator('.merge-row');
        const rowCount = await allRows.count();
        console.log(`Found ${rowCount} total merge rows`);
        
        for (let i = 0; i < rowCount; i++) {
            const row = allRows.nth(i);
            const testId = await row.getAttribute('data-testid') || `row-${i}`;
            const isConflict = await row.evaluate(el => el.classList.contains('conflict-row'));
            const isIdentical = await row.evaluate(el => el.classList.contains('identical-row'));
            
            const extractCellData = async (columnClass: string) => {
                const column = row.locator(`.cell-column.${columnClass}`);
                const exists = await column.count() > 0;
                
                if (!exists) {
                    if (isIdentical && columnClass === 'current-column') {
                        const unifiedCell = row.locator('.cell-column .notebook-cell');
                        if (await unifiedCell.count() > 0) {
                            const content = await unifiedCell.locator('.cell-content').textContent();
                            const hasCodeClass = await unifiedCell.evaluate(el => el.classList.contains('code-cell'));
                            return { exists: true, content, cellType: hasCodeClass ? 'code' : 'markdown' };
                        }
                    }
                    return { exists: false, content: null, cellType: null };
                }
                
                const placeholder = column.locator('.cell-placeholder');
                if (await placeholder.count() > 0) {
                    return { exists: false, content: null, cellType: null };
                }
                
                const notebookCell = column.locator('.notebook-cell');
                if (await notebookCell.count() === 0) {
                    return { exists: false, content: null, cellType: null };
                }
                
                let cellType: string | null = null;
                const hasCodeClass = await notebookCell.evaluate(el => el.classList.contains('code-cell'));
                const hasMarkdownClass = await notebookCell.evaluate(el => el.classList.contains('markdown-cell'));
                if (hasCodeClass) cellType = 'code';
                else if (hasMarkdownClass) cellType = 'markdown';
                
                let content: string | null = null;
                const cellContent = notebookCell.locator('.cell-content');
                if (await cellContent.count() > 0) {
                    content = await cellContent.textContent();
                }
                
                return { exists: true, content, cellType };
            };
            
            const capturedRow: CapturedRow = {
                rowIndex: i,
                isConflict,
                testId,
                base: await extractCellData('base-column'),
                current: await extractCellData('current-column'),
                incoming: await extractCellData('incoming-column')
            };
            
            capturedRows.push(capturedRow);
            
            // Log progress
            if (capturedRow.isConflict) {
                console.log(`Row ${i}: CONFLICT (${testId})`);
            }
        }
        
        // Summary
        console.log('\n=== SUMMARY ===\n');
        const conflictCount = capturedRows.filter(r => r.isConflict).length;
        const identicalCount = capturedRows.filter(r => !r.isConflict).length;
        console.log(`Total rows: ${capturedRows.length}`);
        console.log(`Conflict rows: ${conflictCount}`);
        console.log(`Identical rows: ${identicalCount}`);
        
        // Assertions
        if (capturedRows.length === 0) {
            throw new Error('Should capture at least one row');
        }
        if (conflictCount === 0) {
            throw new Error('Should have at least one conflict row');
        }
        
        // Output full captured data
        console.log('\n=== RAW CAPTURED DATA (JSON) ===\n');
        console.log(JSON.stringify(capturedRows, null, 2));
        
        // Now interact with the UI to resolve conflicts
        console.log('\n=== RESOLVING CONFLICTS ===\n');
        
        const conflictRows = capturedRows.filter(r => r.isConflict);
        
        // Track expected resolutions as we go
        const expectedResolutions: Array<{
            conflictIndex: number;
            rowIndex: number;
            expectedContent: string;
            reason: string;
            isDeleted?: boolean;
        }> = [];
        
        for (let i = 0; i < conflictRows.length; i++) {
            const capturedRow = conflictRows[i];
            const rowIndex = capturedRow.rowIndex;
            
            console.log(`Resolving conflict row ${i} (rowIndex ${rowIndex})...`);
            
            try {
                // Find the actual row element
                const rowElement = page.locator(`[data-testid="${capturedRow.testId}"]`);
                await rowElement.waitFor({ timeout: 10000 });
                
                // Scroll the row into view to ensure it's visible
                await rowElement.scrollIntoViewIfNeeded();
                
                // Check which cells exist
                const hasBase = capturedRow.base.exists;
                const hasCurrent = capturedRow.current.exists;
                const hasIncoming = capturedRow.incoming.exists;
                
                console.log(`  -> Cells: base=${hasBase}, current=${hasCurrent}, incoming=${hasIncoming}`);
                
                // Determine which button to click based on row index and what exists
                let buttonToClick: string;
                let reason: string;
                let modifications: string[] = [];
                let isDeleteAction = false;
                
                // Delete cells at row indices divisible by 7 (except 0) to test deletion
                if (rowIndex > 0 && rowIndex % 7 === 0) {
                    buttonToClick = '.btn-delete';
                    reason = 'divisible by 7 -> delete';
                    isDeleteAction = true;
                    console.log(`  -> Clicking "Delete Cell" (divisible by 7)`);
                } else if (rowIndex % 2 === 0) {
                    // Even index: prefer incoming
                    if (hasIncoming) {
                        buttonToClick = '.btn-incoming';
                        reason = 'even index -> incoming';
                        console.log(`  -> Clicking "Use Incoming" (even index)`);
                    } else if (hasCurrent) {
                        buttonToClick = '.btn-current';
                        reason = 'even index -> current (incoming missing)';
                        modifications.push('(incoming doesn\'t exist)');
                        console.log(`  -> Clicking "Use Current" (incoming doesn't exist)`);
                    } else {
                        buttonToClick = '.btn-base';
                        reason = 'even index -> base (both missing)';
                        modifications.push('(neither current nor incoming exist)');
                        console.log(`  -> Clicking "Use Base" (neither current nor incoming exist)`);
                    }
                } else {
                    // Odd index: prefer current
                    if (hasCurrent) {
                        buttonToClick = '.btn-current';
                        reason = 'odd index -> current';
                        console.log(`  -> Clicking "Use Current" (odd index)`);
                    } else if (hasIncoming) {
                        buttonToClick = '.btn-incoming';
                        reason = 'odd index -> incoming (current missing)';
                        modifications.push('(current doesn\'t exist)');
                        console.log(`  -> Clicking "Use Incoming" (current doesn't exist)`);
                    } else {
                        buttonToClick = '.btn-base';
                        reason = 'odd index -> base (both missing)';
                        modifications.push('(neither current nor incoming exist)');
                        console.log(`  -> Clicking "Use Base" (neither current nor incoming exist)`);
                    }
                }
                
                // If row index is divisible by 5, add that note (but not for deletions)
                if (!isDeleteAction && rowIndex % 5 === 0) {
                    modifications.push('(current taken - divisible by 5)');
                    reason += ' + divisible by 5';
                }
                
                // Click the resolution button
                const button = rowElement.locator(buttonToClick);
                await button.waitFor({ timeout: 10000 });
                await button.click();
                
                // For deletions, we don't wait for textarea
                if (isDeleteAction) {
                    // Wait for the resolved-deleted state
                    await rowElement.locator('.resolved-deleted').waitFor({ timeout: 5000 });
                    console.log(`  -> Cell marked for deletion`);
                    
                    // Store expected resolution for later verification
                    expectedResolutions.push({
                        conflictIndex: i,
                        rowIndex,
                        expectedContent: '', // Empty for deletions
                        reason,
                        isDeleted: true
                    });
                } else {
                    // Wait for textarea to appear
                    await rowElement.locator('.resolved-content-input').waitFor({ timeout: 5000 });
                    
                    const textarea = rowElement.locator('.resolved-content-input');
                    
                    // Read the actual content from the textarea (this is the raw markdown source)
                    const initialTextareaContent = await textarea.inputValue();
                    console.log(`  -> Textarea populated with ${initialTextareaContent.length} chars`);
                    
                    // Apply modifications if any
                    let finalExpectedContent = initialTextareaContent;
                    if (modifications.length > 0) {
                        const newValue = initialTextareaContent + '\n' + modifications.join('\n');
                        await textarea.fill(newValue);
                        finalExpectedContent = newValue;
                        console.log(`  -> Modified text with: ${modifications.join(', ')}`);
                    }
                    
                    // Store expected resolution for later verification
                    expectedResolutions.push({
                        conflictIndex: i,
                        rowIndex,
                        expectedContent: finalExpectedContent,
                        reason,
                        isDeleted: false
                    });
                }
                
                // Small delay between rows
                await new Promise(r => setTimeout(r, 200));
            } catch (error: any) {
                console.error(`  -> Failed to resolve row ${i}: ${error.message}`);
                throw error;
            }
        }
        
        console.log('\n=== VERIFYING TEXTAREA CONTENTS BEFORE APPLY ===\n');
        
        // Re-read all textarea values to verify they match our expectations (skip deletions)
        let allTextareasMatch = true;
        for (const expected of expectedResolutions) {
            // Skip deleted rows - they don't have textareas
            if (expected.isDeleted) {
                console.log(`✓ Conflict ${expected.conflictIndex}: skipped (deleted)`);
                continue;
            }
            
            const rowElement = page.locator(`[data-testid="${conflictRows[expected.conflictIndex].testId}"]`);
            const textarea = rowElement.locator('.resolved-content-input');
            const actualContent = await textarea.inputValue();
            
            if (actualContent === expected.expectedContent) {
                console.log(`✓ Conflict ${expected.conflictIndex}: textarea matches expected`);
            } else {
                // Compute a simple line-based diff (LCS) and print it
                const expectedText = expected.expectedContent || '';
                const actualText = actualContent || '';
                const a = expectedText.split('\n');
                const b = actualText.split('\n');
                const n = a.length;
                const m = b.length;
                const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
                for (let i = n - 1; i >= 0; i--) {
                    for (let j = m - 1; j >= 0; j--) {
                        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
                    }
                }
                const rows: { type: string; line: string }[] = [];
                let i = 0, j = 0;
                while (i < n && j < m) {
                    if (a[i] === b[j]) {
                        rows.push({ type: ' ', line: a[i] });
                        i++; j++;
                    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                        rows.push({ type: '-', line: a[i] });
                        i++;
                    } else {
                        rows.push({ type: '+', line: b[j] });
                        j++;
                    }
                }
                while (i < n) { rows.push({ type: '-', line: a[i++] }); }
                while (j < m) { rows.push({ type: '+', line: b[j++] }); }
                console.log(`❌ Conflict ${expected.conflictIndex}: MISMATCH — Showing line diff (expected vs actual)`);
                console.log('--- DIFF ---');
                for (const r of rows) {
                    const prefix = r.type === ' ' ? '   ' : (r.type === '-' ? '-  ' : '+  ');
                    console.log(prefix + r.line);
                }
                console.log('--- END DIFF ---');
                allTextareasMatch = false;
                allTextareasMatch = false;
            }
        }
        
        if (!allTextareasMatch) {
            throw new Error('Some textareas do not match expected content');
        }
        
        console.log('\n=== VERIFYING CHECKBOXES ===\n');
        
        // Ensure "Mark as resolved" checkbox is checked
        const markAsResolvedCheckbox = page.locator('label:has-text("Mark as resolved") input[type="checkbox"]');
        const isMarkAsResolvedChecked = await markAsResolvedCheckbox.isChecked();
        console.log(`Mark as resolved: ${isMarkAsResolvedChecked}`);
        if (!isMarkAsResolvedChecked) {
            console.log('  -> Checking "Mark as resolved"');
            await markAsResolvedCheckbox.check();
        }
        
        // Ensure "Renumber execution counts" checkbox is checked
        const renumberCheckbox = page.locator('label:has-text("Renumber execution counts") input[type="checkbox"]');
        const isRenumberChecked = await renumberCheckbox.isChecked();
        console.log(`Renumber execution counts: ${isRenumberChecked}`);
        if (!isRenumberChecked) {
            console.log('  -> Checking "Renumber execution counts"');
            await renumberCheckbox.check();
        }
        
        console.log('\n=== APPLYING RESOLUTION ===\n');
        
        // Click the "Apply Resolution" button
        const applyButton = page.locator('button.btn-primary:has-text("Apply Resolution")');
        await applyButton.waitFor({ timeout: 5000 });
        
        // Verify button is enabled
        const isDisabled = await applyButton.isDisabled();
        if (isDisabled) {
            throw new Error('Apply Resolution button is disabled - not all conflicts may be resolved');
        }
        
        // =====================================================================
        // CRITICAL: Capture expected cell sources from the UI BEFORE clicking apply
        // This is the source of truth - what's in the UI should be what ends up on disk
        // =====================================================================
        console.log('\n=== CAPTURING EXPECTED CELL SOURCES FROM UI ===\n');
        
        interface ExpectedCell {
            rowIndex: number;
            source: string;
            cellType: string;
            isConflict: boolean;
            isDeleted: boolean;
        }
        
        const expectedCells: ExpectedCell[] = [];
        const allRowsForCapture = page.locator('.merge-row');
        const totalRows = await allRowsForCapture.count();
        
        for (let i = 0; i < totalRows; i++) {
            const row = allRowsForCapture.nth(i);
            const isConflictRow = await row.evaluate(el => el.classList.contains('conflict-row'));
            const isIdenticalRow = await row.evaluate(el => el.classList.contains('identical-row'));
            
            if (isIdenticalRow) {
                // For unified/identical rows, the raw source is in the data-raw-source attribute
                const rawSource = await row.getAttribute('data-raw-source');
                const cellType = await row.getAttribute('data-cell-type') || 'code';
                
                if (rawSource !== null) {
                    expectedCells.push({
                        rowIndex: i,
                        source: rawSource,
                        cellType,
                        isConflict: false,
                        isDeleted: false
                    });
                    console.log(`Row ${i} (identical): captured ${rawSource.length} chars of ${cellType}`);
                } else {
                    // Fallback: try to read from cell-content for code cells
                    const cellContent = row.locator('.cell-column .notebook-cell .cell-content');
                    if (await cellContent.count() > 0) {
                        const textContent = await cellContent.textContent() || '';
                        const hasCodeClass = await row.locator('.notebook-cell').evaluate(el => el.classList.contains('code-cell'));
                        expectedCells.push({
                            rowIndex: i,
                            source: textContent,
                            cellType: hasCodeClass ? 'code' : 'markdown',
                            isConflict: false,
                            isDeleted: false
                        });
                        console.log(`Row ${i} (identical, fallback): captured ${textContent.length} chars`);
                    }
                }
            } else if (isConflictRow) {
                // For conflict rows, check if it's been resolved
                const resolvedCell = row.locator('.resolved-cell');
                const hasResolvedCell = await resolvedCell.count() > 0;
                
                if (hasResolvedCell) {
                    // Check if it's a deletion
                    const isDeleted = await resolvedCell.evaluate(el => el.classList.contains('resolved-deleted'));
                    
                    if (isDeleted) {
                        expectedCells.push({
                            rowIndex: i,
                            source: '',
                            cellType: 'code',
                            isConflict: true,
                            isDeleted: true
                        });
                        console.log(`Row ${i} (conflict): DELETED`);
                    } else {
                        // Get the textarea content - this is the source of truth
                        const textarea = row.locator('.resolved-content-input');
                        if (await textarea.count() > 0) {
                            const textareaValue = await textarea.inputValue();
                            // Determine cell type from the original cells
                            const hasCodeCell = await row.locator('.notebook-cell.code-cell').count() > 0;
                            expectedCells.push({
                                rowIndex: i,
                                source: textareaValue,
                                cellType: hasCodeCell ? 'code' : 'markdown',
                                isConflict: true,
                                isDeleted: false
                            });
                            console.log(`Row ${i} (conflict, resolved): captured ${textareaValue.length} chars`);
                        }
                    }
                } else {
                    console.log(`Row ${i} (conflict): NOT RESOLVED - will fail`);
                }
            }
        }
        
        console.log(`\nCaptured ${expectedCells.length} expected cells from UI`);
        const expectedNonDeletedCells = expectedCells.filter(c => !c.isDeleted && c.source !== '');
        console.log(`Expected ${expectedNonDeletedCells.length} cells in final notebook (excluding deletions)`);
        
        // Now click Apply
        console.log('\nClicking "Apply Resolution"...');
        await applyButton.click();
        
        // Wait for the file to be written
        await new Promise(r => setTimeout(r, 3000));
        
        // Wait for the resolution to complete (file should be updated)
        console.log('Waiting for file to be written...');
        let fileWritten = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const stat = fs.statSync(conflictFile);
                // Check if file was modified recently (within last 10 seconds)
                const mtime = stat.mtimeMs;
                const now = Date.now();
                if (now - mtime < 10000) {
                    fileWritten = true;
                    console.log('File was written recently, proceeding with verification');
                    break;
                }
            } catch {
                // File doesn't exist or can't be read
            }
        }
        
        if (!fileWritten) {
            console.log('Warning: Could not confirm file was written, proceeding anyway');
        }
        
        // =====================================================================
        // VERIFICATION: Compare UI sources directly against notebook on disk
        // =====================================================================
        console.log('\n=== VERIFYING UI CONTENT MATCHES NOTEBOOK ON DISK ===\n');
        
        // Read and parse the resolved notebook from disk
        const notebookContent = fs.readFileSync(conflictFile, 'utf8');
        const resolvedNotebook = JSON.parse(notebookContent);
        
        console.log(`Notebook on disk has ${resolvedNotebook.cells.length} cells`);
        console.log(`Expected ${expectedNonDeletedCells.length} cells from UI`);
        
        // First check: cell count must match
        if (resolvedNotebook.cells.length !== expectedNonDeletedCells.length) {
            console.log('❌ CELL COUNT MISMATCH');
            console.log(`   Expected: ${expectedNonDeletedCells.length}`);
            console.log(`   Actual: ${resolvedNotebook.cells.length}`);
            
            // Log expected cells for debugging
            console.log('\nExpected cells from UI:');
            for (const cell of expectedNonDeletedCells) {
                console.log(`  Row ${cell.rowIndex}: ${cell.cellType}, ${cell.source.length} chars, first 50: "${cell.source.substring(0, 50).replace(/\n/g, '\\n')}..."`);
            }
            
            console.log('\nActual cells on disk:');
            for (let i = 0; i < resolvedNotebook.cells.length; i++) {
                const cellSource = getCellSource(resolvedNotebook.cells[i]);
                console.log(`  Cell ${i}: ${resolvedNotebook.cells[i].cell_type}, ${cellSource.length} chars, first 50: "${cellSource.substring(0, 50).replace(/\n/g, '\\n')}..."`);
            }
            
            throw new Error(`Cell count mismatch: expected ${expectedNonDeletedCells.length}, got ${resolvedNotebook.cells.length}`);
        }
        
        // Second check: compare each cell source
        let mismatchCount = 0;
        const mismatches: Array<{index: number; expected: string; actual: string}> = [];
        
        for (let i = 0; i < expectedNonDeletedCells.length; i++) {
            const expectedCell = expectedNonDeletedCells[i];
            const actualCell = resolvedNotebook.cells[i];
            const actualSource = getCellSource(actualCell);
            
            if (expectedCell.source === actualSource) {
                console.log(`✓ Cell ${i} (from row ${expectedCell.rowIndex}): sources match (${actualSource.length} chars)`);
            } else {
                mismatchCount++;
                mismatches.push({
                    index: i,
                    expected: expectedCell.source,
                    actual: actualSource
                });
                console.log(`❌ Cell ${i} (from row ${expectedCell.rowIndex}): MISMATCH`);
                console.log(`   Expected (${expectedCell.source.length} chars): "${expectedCell.source.substring(0, 100).replace(/\n/g, '\\n')}..."`);
                console.log(`   Actual (${actualSource.length} chars): "${actualSource.substring(0, 100).replace(/\n/g, '\\n')}..."`);
            }
        }
        
        // If there are mismatches, print detailed diffs
        if (mismatches.length > 0) {
            console.log('\n=== DETAILED DIFFS FOR MISMATCHED CELLS ===\n');
            
            for (const mismatch of mismatches) {
                console.log(`--- Cell ${mismatch.index} ---`);
                
                // Simple line-by-line diff
                const expectedLines = mismatch.expected.split('\n');
                const actualLines = mismatch.actual.split('\n');
                
                console.log(`Expected ${expectedLines.length} lines, got ${actualLines.length} lines`);
                
                // LCS-based diff
                const n = expectedLines.length;
                const m = actualLines.length;
                const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
                for (let i = n - 1; i >= 0; i--) {
                    for (let j = m - 1; j >= 0; j--) {
                        dp[i][j] = expectedLines[i] === actualLines[j] 
                            ? dp[i + 1][j + 1] + 1 
                            : Math.max(dp[i + 1][j], dp[i][j + 1]);
                    }
                }
                
                const diffLines: string[] = [];
                let ei = 0, ai = 0;
                while (ei < n && ai < m) {
                    if (expectedLines[ei] === actualLines[ai]) {
                        diffLines.push(`   ${expectedLines[ei]}`);
                        ei++; ai++;
                    } else if (dp[ei + 1][ai] >= dp[ei][ai + 1]) {
                        diffLines.push(`-  ${expectedLines[ei]}`);
                        ei++;
                    } else {
                        diffLines.push(`+  ${actualLines[ai]}`);
                        ai++;
                    }
                }
                while (ei < n) { diffLines.push(`-  ${expectedLines[ei++]}`); }
                while (ai < m) { diffLines.push(`+  ${actualLines[ai++]}`); }
                
                for (const line of diffLines) {
                    console.log(line);
                }
                console.log('');
            }
            
            throw new Error(`${mismatchCount} cells have source mismatches between UI and disk`);
        }
        
        // Third check: verify cell types match
        console.log('\n=== VERIFYING CELL TYPES ===\n');
        let typesMismatchCount = 0;
        
        for (let i = 0; i < expectedNonDeletedCells.length; i++) {
            const expectedCell = expectedNonDeletedCells[i];
            const actualCell = resolvedNotebook.cells[i];
            
            if (expectedCell.cellType === actualCell.cell_type) {
                console.log(`✓ Cell ${i}: type matches (${actualCell.cell_type})`);
            } else {
                typesMismatchCount++;
                console.log(`❌ Cell ${i}: type mismatch - expected ${expectedCell.cellType}, got ${actualCell.cell_type}`);
            }
        }
        
        if (typesMismatchCount > 0) {
            throw new Error(`${typesMismatchCount} cells have type mismatches`);
        }
        
        // Fourth check: verify notebook structure is valid
        console.log('\n=== VERIFYING NOTEBOOK STRUCTURE ===\n');
        
        if (typeof resolvedNotebook.nbformat !== 'number') {
            throw new Error('Invalid notebook: missing nbformat');
        }
        if (typeof resolvedNotebook.nbformat_minor !== 'number') {
            throw new Error('Invalid notebook: missing nbformat_minor');
        }
        if (!resolvedNotebook.metadata || typeof resolvedNotebook.metadata !== 'object') {
            throw new Error('Invalid notebook: missing or invalid metadata');
        }
        if (!Array.isArray(resolvedNotebook.cells)) {
            throw new Error('Invalid notebook: cells is not an array');
        }
        
        console.log(`✓ nbformat: ${resolvedNotebook.nbformat}`);
        console.log(`✓ nbformat_minor: ${resolvedNotebook.nbformat_minor}`);
        console.log(`✓ metadata: valid object`);
        console.log(`✓ cells: valid array with ${resolvedNotebook.cells.length} cells`);
        
        // Verify each cell has required fields
        for (let i = 0; i < resolvedNotebook.cells.length; i++) {
            const cell = resolvedNotebook.cells[i];
            if (!cell.cell_type) {
                throw new Error(`Cell ${i}: missing cell_type`);
            }
            if (cell.source === undefined) {
                throw new Error(`Cell ${i}: missing source`);
            }
            if (!cell.metadata || typeof cell.metadata !== 'object') {
                throw new Error(`Cell ${i}: missing or invalid metadata`);
            }
            if (cell.cell_type === 'code') {
                if (!Array.isArray(cell.outputs)) {
                    throw new Error(`Cell ${i}: code cell missing outputs array`);
                }
            }
        }
        console.log('✓ All cells have required fields');
        
        console.log('\n=== ALL VERIFICATIONS PASSED ===\n');
        console.log('✓ Cell count matches between UI and disk');
        console.log('✓ All cell sources match between UI textareas/data attributes and disk');
        console.log('✓ All cell types match');
        console.log('✓ Notebook structure is valid');
        console.log(`✓ Total: ${expectedNonDeletedCells.length} cells verified`);
        
        console.log('\n=== TEST PASSED ===\n');
        
    } finally {
        // Cleanup
        if (page) {
            await page.close();
        }
        if (browser) {
            await browser.close();
        }
    }
}
