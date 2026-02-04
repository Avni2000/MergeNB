/**
 * @file integration.test.ts
 * @description Integration test that sets up a real git repo with merge conflicts,
 * uses the actual extension code to detect conflicts, and captures UI data with Playwright.
 * 
 * Uses module-alias to mock VSCode for the webServer import, but the git operations
 * are real and run against actual git repos.
 */

const path = require('path');

// REGISTER MOCKS BEFORE IMPORTING ANYTHING ELSE
const moduleAlias = require('module-alias');
moduleAlias.addAlias('vscode', path.join(__dirname, 'mocks/vscode.js'));

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

// Import modules after mock is registered
import * as gitIntegration from '../gitIntegration';
import { detectSemanticConflicts } from '../conflictDetector';
import { getWebServer } from '../web/webServer';
import type { UnifiedConflictData, MergeRow } from '../web/client/types';

/** Helper to run git commands */
function git(cwd: string, ...args: string[]): string {
    const cmd = `git ${args.join(' ')}`;
    try {
        return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error: any) {
        // Some git commands exit non-zero but are still useful (e.g., merge with conflicts)
        return error.stdout || '';
    }
}

/** Create a temporary git repo with merge conflicts like simulate_merge_uu.sh */
async function createMergeConflictRepo(): Promise<{ repoPath: string; conflictFile: string }> {
    // Create temp directory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergeNB-test-'));
    
    // Get paths to test files
    const testDir = path.resolve(__dirname, '../../test');
    const baseFile = path.join(testDir, '02_base.ipynb');
    const currentFile = path.join(testDir, '02_current.ipynb');
    const incomingFile = path.join(testDir, '02_incoming.ipynb');
    
    // Verify test files exist
    if (!fs.existsSync(baseFile)) {
        throw new Error(`Test file not found: ${baseFile}`);
    }
    if (!fs.existsSync(currentFile)) {
        throw new Error(`Test file not found: ${currentFile}`);
    }
    if (!fs.existsSync(incomingFile)) {
        throw new Error(`Test file not found: ${incomingFile}`);
    }
    
    // Initialize git repo
    git(tmpDir, 'init');
    git(tmpDir, 'config', 'user.email', '"test@mergenb.test"');
    git(tmpDir, 'config', 'user.name', '"MergeNB Test"');
    
    // Create base commit
    fs.copyFileSync(baseFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"base"');
    
    // Get the base branch name (could be 'master' or 'main')
    const baseBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    
    // Create and commit current branch
    git(tmpDir, 'checkout', '-b', 'current');
    fs.copyFileSync(currentFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"current"');
    
    // Create incoming branch from base
    git(tmpDir, 'checkout', baseBranch);
    git(tmpDir, 'checkout', '-b', 'incoming');
    fs.copyFileSync(incomingFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"incoming"');
    
    // Merge incoming into current to produce a conflict (status UU)
    git(tmpDir, 'checkout', 'current');
    git(tmpDir, 'merge', 'incoming'); // This will fail and create UU status
    
    // Verify the conflict exists
    const status = git(tmpDir, 'status', '--porcelain');
    console.log('Git status after merge:', status);
    
    if (!status.includes('UU conflict.ipynb')) {
        throw new Error('Expected UU conflict status, got: ' + status);
    }
    
    return {
        repoPath: tmpDir,
        conflictFile: path.join(tmpDir, 'conflict.ipynb')
    };
}

/** Clean up temp repo */
function cleanupRepo(repoPath: string): void {
    try {
        fs.rmSync(repoPath, { recursive: true, force: true });
    } catch (error) {
        console.warn('Failed to cleanup temp repo:', error);
    }
}

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

test.describe('MergeNB Integration', () => {
    let repoPath: string;
    let conflictFile: string;
    let server: any;
    let serverPort: number;

    test.beforeAll(async () => {
        console.log('Setting up merge conflict repo...');
        const repo = await createMergeConflictRepo();
        repoPath = repo.repoPath;
        conflictFile = repo.conflictFile;
        console.log(`Repo created at: ${repoPath}`);
        console.log(`Conflict file: ${conflictFile}`);
        
        // Start the web server
        server = getWebServer();
        // Mock extension URI to point to project root
        server.setExtensionUri({ fsPath: path.resolve(__dirname, '../..') });
        serverPort = await server.start({ port: 0, host: '127.0.0.1' });
        console.log(`Web server started on port ${serverPort}`);
    });

    test.afterAll(async () => {
        await server?.stop();
        if (repoPath) {
            cleanupRepo(repoPath);
        }
    });

    test('should detect real merge conflicts and capture UI data', async ({ page }) => {
        // Enable console logging from browser
        page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
        page.on('pageerror', err => console.error(`[Browser Error] ${err.message}`));

        // Step 1: Verify we have a real UU conflict
        console.log('Checking if file is unmerged...');
        const isUnmerged = await gitIntegration.isUnmergedFile(conflictFile);
        expect(isUnmerged).toBe(true);
        console.log('File is confirmed as unmerged (UU status)');

        // Step 2: Detect semantic conflicts using real extension code
        console.log('Detecting semantic conflicts...');
        const semanticConflict = await detectSemanticConflicts(conflictFile);
        expect(semanticConflict).not.toBeNull();
        console.log(`Detected ${semanticConflict!.semanticConflicts.length} semantic conflicts`);
        console.log(`Cell mappings: ${semanticConflict!.cellMappings.length}`);

        // Step 3: Build conflict data for the UI
        const conflictData: UnifiedConflictData = {
            filePath: conflictFile,
            type: 'semantic',
            semanticConflict: semanticConflict!,
            currentBranch: 'current',
            incomingBranch: 'incoming'
        };

        // Step 4: Open browser session
        const sessionId = 'integration-test-session';
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script>
                    window.acquireVsCodeApi = () => ({
                        postMessage: (msg) => console.log('VSCode Message:', JSON.stringify(msg)),
                        getState: () => ({}),
                        setState: () => {}
                    });
                </script>
                <script type="module" src="/client.js"></script>
            </head>
            <body><div id="root"></div></body>
            </html>
        `;

        const sessionUrl = `http://127.0.0.1:${serverPort}/?session=${sessionId}`;
        console.log(`Opening session at ${sessionUrl}`);

        // Start session and navigation concurrently
        await Promise.all([
            server.openSession(sessionId, html, (msg: any) => {
                console.log('Message from browser:', JSON.stringify(msg).substring(0, 200));
            }),
            page.goto(sessionUrl)
        ]);

        // Wait for connection
        await page.waitForTimeout(2000);

        // Step 5: Send real conflict data to the browser
        console.log('Sending real conflict data to browser...');
        server.sendConflictData(sessionId, conflictData);

        // Step 6: Wait for UI to render
        await expect(page.locator('.header-title')).toHaveText('MergeNB', { timeout: 15000 });

        // Wait a bit more for all rows to render
        await page.waitForTimeout(1000);

        // Step 7: Capture all row information
        console.log('\n=== CAPTURING ROW DATA ===\n');

        const capturedRows: CapturedRow[] = [];

        // Find all merge rows (both identical and conflict)
        const allRows = page.locator('.merge-row');
        const rowCount = await allRows.count();
        console.log(`Found ${rowCount} total merge rows`);

        for (let i = 0; i < rowCount; i++) {
            const row = allRows.nth(i);
            const testId = await row.getAttribute('data-testid') || `row-${i}`;
            const isConflict = await row.evaluate(el => el.classList.contains('conflict-row'));
            const isIdentical = await row.evaluate(el => el.classList.contains('identical-row'));

            // Extract cell content from each column
            const extractCellData = async (columnClass: string): Promise<{ exists: boolean; content: string | null; cellType: string | null }> => {
                const column = row.locator(`.cell-column.${columnClass}`);
                const exists = await column.count() > 0;
                if (!exists) {
                    // For identical rows, the cell spans all columns
                    if (isIdentical && columnClass === 'current-column') {
                        // Try to get content from the unified cell
                        const unifiedCell = row.locator('.cell-column .notebook-cell');
                        if (await unifiedCell.count() > 0) {
                            const content = await unifiedCell.locator('.cell-content').textContent();
                            const hasCodeClass = await unifiedCell.evaluate(el => el.classList.contains('code-cell'));
                            return { exists: true, content, cellType: hasCodeClass ? 'code' : 'markdown' };
                        }
                    }
                    return { exists: false, content: null, cellType: null };
                }

                // Check for placeholder (deleted cell)
                const placeholder = column.locator('.cell-placeholder');
                if (await placeholder.count() > 0) {
                    return { exists: false, content: null, cellType: null };
                }

                // Get the notebook-cell element
                const notebookCell = column.locator('.notebook-cell');
                if (await notebookCell.count() === 0) {
                    return { exists: false, content: null, cellType: null };
                }

                // Get cell type from class
                let cellType: string | null = null;
                const hasCodeClass = await notebookCell.evaluate(el => el.classList.contains('code-cell'));
                const hasMarkdownClass = await notebookCell.evaluate(el => el.classList.contains('markdown-cell'));
                if (hasCodeClass) cellType = 'code';
                else if (hasMarkdownClass) cellType = 'markdown';

                // Get content from .cell-content
                let content: string | null = null;
                const cellContent = notebookCell.locator('.cell-content');
                if (await cellContent.count() > 0) {
                    content = await cellContent.textContent();
                }

                return { exists: true, content, cellType };

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

            // Log each row
            console.log(`Row ${i}: ${isConflict ? 'CONFLICT' : 'IDENTICAL'} (${testId})`);
            if (capturedRow.base.exists) {
                console.log(`  Base: [${capturedRow.base.cellType}] ${capturedRow.base.content?.substring(0, 50) || '(empty)'}...`);
            }
            if (capturedRow.current.exists) {
                console.log(`  Current: [${capturedRow.current.cellType}] ${capturedRow.current.content?.substring(0, 50) || '(empty)'}...`);
            }
            if (capturedRow.incoming.exists) {
                console.log(`  Incoming: [${capturedRow.incoming.cellType}] ${capturedRow.incoming.content?.substring(0, 50) || '(empty)'}...`);
            }
        }

        console.log('\n=== SUMMARY ===\n');
        const conflictCount = capturedRows.filter(r => r.isConflict).length;
        const identicalCount = capturedRows.filter(r => !r.isConflict).length;
        console.log(`Total rows: ${capturedRows.length}`);
        console.log(`Conflict rows: ${conflictCount}`);
        console.log(`Identical rows: ${identicalCount}`);

        // Also capture conflict-specific rows for more detail
        const conflictRows = page.locator('[data-testid^="conflict-row-"]');
        const conflictRowCount = await conflictRows.count();
        console.log(`\nConflict rows (by testid): ${conflictRowCount}`);

        // Verify we captured something meaningful
        expect(capturedRows.length).toBeGreaterThan(0);

        // Store for potential further analysis
        console.log('\n=== RAW CAPTURED DATA (JSON) ===\n');
        console.log(JSON.stringify(capturedRows, null, 2));
    });
});
