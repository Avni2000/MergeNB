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
