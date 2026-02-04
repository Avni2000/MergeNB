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
                let appendNote = '';
                
                if (rowIndex % 2 === 0) {
                    // Even index: prefer incoming
                    if (hasIncoming) {
                        buttonToClick = '.btn-incoming';
                        console.log(`  -> Clicking "Use Incoming" (even index)`);
                    } else if (hasCurrent) {
                        buttonToClick = '.btn-current';
                        appendNote = '(incoming doesn\'t exist)';
                        console.log(`  -> Clicking "Use Current" (incoming doesn't exist)`);
                    } else {
                        buttonToClick = '.btn-base';
                        appendNote = '(neither current nor incoming exist)';
                        console.log(`  -> Clicking "Use Base" (neither current nor incoming exist)`);
                    }
                } else {
                    // Odd index: prefer current
                    if (hasCurrent) {
                        buttonToClick = '.btn-current';
                        console.log(`  -> Clicking "Use Current" (odd index)`);
                    } else if (hasIncoming) {
                        buttonToClick = '.btn-incoming';
                        appendNote = '(current doesn\'t exist)';
                        console.log(`  -> Clicking "Use Incoming" (current doesn't exist)`);
                    } else {
                        buttonToClick = '.btn-base';
                        appendNote = '(neither current nor incoming exist)';
                        console.log(`  -> Clicking "Use Base" (neither current nor incoming exist)`);
                    }
                }
                
                // Click the resolution button
                const button = rowElement.locator(buttonToClick);
                await button.waitFor({ timeout: 10000 });
                await button.click();
                
                // Wait for textarea to appear
                await rowElement.locator('.resolved-content-input').waitFor({ timeout: 5000 });
                
                const textarea = rowElement.locator('.resolved-content-input');
                
                // Get current value
                let currentValue = await textarea.inputValue();
                let modifications: string[] = [];
                
                // Add note if cell didn't exist
                if (appendNote) {
                    modifications.push(appendNote);
                }
                
                // If row index is divisible by 5, add that note too
                if (rowIndex % 5 === 0) {
                    modifications.push('(current taken - divisible by 5)');
                }
                
                // Apply modifications if any
                if (modifications.length > 0) {
                    const newValue = currentValue + '\n' + modifications.join('\n');
                    await textarea.fill(newValue);
                    console.log(`  -> Modified text with: ${modifications.join(', ')}`);
                }
                
                // Small delay between rows
                await new Promise(r => setTimeout(r, 200));
            } catch (error: any) {
                console.error(`  -> Failed to resolve row ${i}: ${error.message}`);
                throw error;
            }
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
        
        console.log('\n=== VERIFYING RESOLVED NOTEBOOK ===\n');
        
        // Read the resolved conflict.ipynb file
        const resolvedNotebook = JSON.parse(fs.readFileSync(conflictFile, 'utf8'));
        console.log(`Resolved notebook has ${resolvedNotebook.cells.length} cells`);
        
        // Build expected resolutions based on our rules
        const expectedResolutions: Array<{
            conflictIndex: number;
            rowIndex: number;
            expectedSource: string;
            reason: string;
        }> = [];
        
        for (let i = 0; i < conflictRows.length; i++) {
            const capturedRow = conflictRows[i];
            const rowIndex = capturedRow.rowIndex;
            const hasBase = capturedRow.base.exists;
            const hasCurrent = capturedRow.current.exists;
            const hasIncoming = capturedRow.incoming.exists;
            
            let expectedSource: string;
            let reason: string;
            
            if (rowIndex % 2 === 0) {
                // Even index: prefer incoming
                if (hasIncoming) {
                    expectedSource = capturedRow.incoming.content || '';
                    reason = 'even index -> incoming';
                } else if (hasCurrent) {
                    expectedSource = capturedRow.current.content || '';
                    reason = 'even index -> current (incoming missing)';
                    expectedSource += '\n(incoming doesn\'t exist)';
                } else {
                    expectedSource = capturedRow.base.content || '';
                    reason = 'even index -> base (both missing)';
                    expectedSource += '\n(neither current nor incoming exist)';
                }
            } else {
                // Odd index: prefer current
                if (hasCurrent) {
                    expectedSource = capturedRow.current.content || '';
                    reason = 'odd index -> current';
                } else if (hasIncoming) {
                    expectedSource = capturedRow.incoming.content || '';
                    reason = 'odd index -> incoming (current missing)';
                    expectedSource += '\n(current doesn\'t exist)';
                } else {
                    expectedSource = capturedRow.base.content || '';
                    reason = 'odd index -> base (both missing)';
                    expectedSource += '\n(neither current nor incoming exist)';
                }
            }
            
            // Add divisible by 5 marker
            if (rowIndex % 5 === 0) {
                expectedSource += '\n(current taken - divisible by 5)';
                reason += ' + divisible by 5';
            }
            
            expectedResolutions.push({
                conflictIndex: i,
                rowIndex,
                expectedSource: expectedSource.trim(),
                reason
            });
        }
        
        // Now verify each conflict was resolved correctly
        console.log('\n=== CELL-BY-CELL VERIFICATION ===\n');
        
        let allMatch = true;
        let discrepancyCount = 0;
        
        for (const expected of expectedResolutions) {
            // The resolved notebook should have cells in order
            // We need to find the cell at the conflict row position
            // Since we have 71 total rows (captured), we need to map rowIndex to actual cell index
            
            // For simplicity, let's just verify that the expected content appears somewhere
            // in the resolved notebook's cells
            const cellIndex = expected.rowIndex;
            
            if (cellIndex >= resolvedNotebook.cells.length) {
                console.log(`❌ DISCREPANCY: Conflict ${expected.conflictIndex} (row ${expected.rowIndex})`);
                console.log(`   Cell index ${cellIndex} out of bounds (notebook has ${resolvedNotebook.cells.length} cells)`);
                allMatch = false;
                discrepancyCount++;
                continue;
            }
            
            const actualCell = resolvedNotebook.cells[cellIndex];
            const actualSource = Array.isArray(actualCell.source) 
                ? actualCell.source.join('')
                : actualCell.source;
            
            // Normalize whitespace and unicode for comparison
            const normalizeWhitespace = (text: string) => {
                return text
                    .trim()
                    .replace(/\r\n/g, '\n')  // Normalize line endings
                    .replace(/\n{3,}/g, '\n\n')  // Collapse multiple blank lines to max 2
                    .replace(/[ \t]+$/gm, '')  // Remove trailing whitespace on each line
                    .replace(/^[ \t]+/gm, '')  // Remove leading whitespace on each line
                    // Normalize markdown syntax
                    .replace(/^#{1,6}\s+/gm, '')  // Remove markdown headers
                    .replace(/^---+$/gm, '')  // Remove markdown horizontal rules
                    .replace(/^[-*+]\s+/gm, '')  // Remove markdown list markers
                    .replace(/^>\s*/gm, '')  // Remove markdown blockquote markers
                    .replace(/\|/g, '')  // Remove markdown table pipes
                    .replace(/[-]{3,}/g, '')  // Remove markdown table separator lines
                    .replace(/\*\*([^\*]+)\*\*/g, '$1')  // Remove bold
                    .replace(/\*([^\*]+)\*/g, '$1')  // Remove italic
                    .replace(/`([^`]+)`/g, '$1')  // Remove inline code
                    .replace(/\s+/g, ' ')  // Collapse all whitespace to single spaces
                    .replace(/[''""\u2018\u2019\u201C\u201D]/g, "'")  // Normalize quotes/apostrophes
                    .replace(/[—–−]/g, '-')  // Normalize dashes (but not table separators)
                    .replace(/…/g, '...')  // Normalize ellipsis
                    .normalize('NFKD')  // Unicode normalization
                    .trim();  // Final trim to remove any leading/trailing spaces
            };
            
            const actualNormalized = normalizeWhitespace(actualSource);
            const expectedNormalized = normalizeWhitespace(expected.expectedSource);
            
            if (actualNormalized === expectedNormalized) {
                console.log(`✓ Conflict ${expected.conflictIndex} (row ${expected.rowIndex}): MATCH`);
                console.log(`  Reason: ${expected.reason}`);
                console.log(`  Content preview: ${actualNormalized.substring(0, 60)}...`);
            } else {
                console.log(`❌ DISCREPANCY: Conflict ${expected.conflictIndex} (row ${expected.rowIndex})`);
                console.log(`  Reason: ${expected.reason}`);
                console.log(`  Expected (normalized): ${expectedNormalized.substring(0, 100)}...`);
                console.log(`  Actual (normalized): ${actualNormalized.substring(0, 100)}...`);
                console.log(`  Expected length: ${expectedNormalized.length}, Actual length: ${actualNormalized.length}`);
                
                // Show character-by-character diff for first mismatch
                let firstDiffIndex = -1;
                for (let i = 0; i < Math.min(expectedNormalized.length, actualNormalized.length); i++) {
                    if (expectedNormalized[i] !== actualNormalized[i]) {
                        firstDiffIndex = i;
                        break;
                    }
                }
                if (firstDiffIndex !== -1) {
                    const contextStart = Math.max(0, firstDiffIndex - 20);
                    const contextEnd = Math.min(expectedNormalized.length, firstDiffIndex + 20);
                    console.log(`  First difference at index ${firstDiffIndex}:`);
                    console.log(`    Expected: "${expectedNormalized.substring(contextStart, contextEnd)}"`);
                    console.log(`    Actual:   "${actualNormalized.substring(contextStart, contextEnd)}"`);
                }
                
                allMatch = false;
                discrepancyCount++;
            }
        }
        
        console.log('\n=== VERIFICATION SUMMARY ===\n');
        console.log(`Total conflicts verified: ${expectedResolutions.length}`);
        console.log(`Matching: ${expectedResolutions.length - discrepancyCount}`);
        console.log(`Discrepancies: ${discrepancyCount}`);
        
        if (!allMatch) {
            throw new Error(`Found ${discrepancyCount} discrepancies in resolved notebook`);
        }
        
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
