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

interface ResolvedConflictDetails {
    uri: string;
    resolvedNotebook: any;
    resolvedRows?: Array<{ resolution?: { choice: string; resolvedContent: string } }>;
    markAsResolved: boolean;
    renumberExecutionCounts: boolean;
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

async function waitForResolutionDetails(timeoutMs: number = 20000): Promise<ResolvedConflictDetails> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const details = await vscode.commands.executeCommand<ResolvedConflictDetails | undefined>(
            'merge-nb.getLastResolutionDetails'
        );
        if (details?.resolvedNotebook) {
            return details;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Timed out waiting for resolution details event');
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
                
                if (rowIndex % 2 === 0) {
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
                
                // If row index is divisible by 5, add that note
                if (rowIndex % 5 === 0) {
                    modifications.push('(current taken - divisible by 5)');
                    reason += ' + divisible by 5';
                }
                
                // Click the resolution button
                const button = rowElement.locator(buttonToClick);
                await button.waitFor({ timeout: 10000 });
                await button.click();
                
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
                    reason
                });
                
                // Small delay between rows
                await new Promise(r => setTimeout(r, 200));
            } catch (error: any) {
                console.error(`  -> Failed to resolve row ${i}: ${error.message}`);
                throw error;
            }
        }
        
        console.log('\n=== VERIFYING TEXTAREA CONTENTS BEFORE APPLY ===\n');
        
        // Re-read all textarea values to verify they match our expectations
        let allTextareasMatch = true;
        for (const expected of expectedResolutions) {
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
        
        console.log('Clicking "Apply Resolution"...');
        await applyButton.click();
        
        // Wait a moment for the resolution to be sent to the extension
        await new Promise(r => setTimeout(r, 2000));

        const resolutionDetails = await waitForResolutionDetails();
        
        console.log('\n=== VERIFYING RESOLVED NOTEBOOK ===\n');
        
        // Read the resolved conflict.ipynb file
        const resolvedNotebook = JSON.parse(fs.readFileSync(conflictFile, 'utf8'));
        console.log(`Resolved notebook has ${resolvedNotebook.cells.length} cells`);

        const serializedFromEvent = JSON.stringify(resolutionDetails.resolvedNotebook);
        const serializedFromDisk = JSON.stringify(resolvedNotebook);
        if (serializedFromEvent !== serializedFromDisk) {
            throw new Error('Resolved notebook from event does not match the file written to disk');
        }
        
        // Verify that each resolved row content matches the corresponding cell in the notebook
        console.log('\n=== VERIFYING CELL SOURCES MATCH RESOLVED ROW CONTENTS ===\n');
        
        let cellMismatchCount = 0;
        const resolvedRows = resolutionDetails.resolvedRows || [];
        for (let rowIndex = 0; rowIndex < resolvedRows.length; rowIndex++) {
            const row = resolvedRows[rowIndex];
            const resolution = row.resolution;

            if (!resolution) {
                continue;
            }

            if (resolution.choice === 'delete' || resolution.resolvedContent === '') {
                continue;
            }

            const cellIndex = rowIndex;
            
            if (cellIndex >= resolvedNotebook.cells.length) {
                console.log(`❌ Cell ${cellIndex}: out of bounds (notebook has ${resolvedNotebook.cells.length} cells)`);
                cellMismatchCount++;
                continue;
            }
            
            const cell = resolvedNotebook.cells[cellIndex];
            const cellSource = getCellSource(cell);
            const expectedContent = resolution.resolvedContent;
            
            // The resolved content should match the cell source exactly
            if (cellSource === expectedContent) {
                console.log(`✓ Cell ${cellIndex}: source matches resolved content`);
            } else {
                console.log(`❌ Cell ${cellIndex}: MISMATCH`);
                console.log(`   Resolved (${expectedContent.length} chars): ${expectedContent.substring(0, 80)}...`);
                console.log(`   Cell source (${cellSource.length} chars): ${cellSource.substring(0, 80)}...`);
                cellMismatchCount++;
            }
        }
        
        if (cellMismatchCount > 0) {
            throw new Error(`${cellMismatchCount} cells do not match their resolved content`);
        }
        
        console.log('\n=== ALL VERIFICATIONS PASSED ===\n');
        console.log('1. ✓ Button clicking populates textareas correctly');
        console.log('2. ✓ Resolved row contents are correctly written to notebook file');
        
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
