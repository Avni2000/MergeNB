const path = require('path');

// REGISTER MOCKS BEFORE IMPORTING ANYTHING ELSE
const moduleAlias = require('module-alias');
moduleAlias.addAlias('vscode', path.join(__dirname, 'mocks/vscode.js'));

import { test, expect } from '@playwright/test';
import { UnifiedConflictData, NotebookSemanticConflict } from '../web/client/types';

// Synthetic conflict data mimicking a conflict
const mockConflictData: UnifiedConflictData = {
    filePath: '/test/notebook.ipynb',
    type: 'semantic',
    semanticConflict: {
        filePath: '/test/notebook.ipynb',
        cellMappings: [
            { baseIndex: 0, currentIndex: 0, incomingIndex: 0 }, // Identical
            { baseIndex: 1, currentIndex: 1, incomingIndex: undefined }, // Edited in current, deleted in incoming (conflict)
            { baseIndex: undefined, currentIndex: 2, incomingIndex: 1 }, // Added in both (conflict)
        ],
        semanticConflicts: [
            {
                type: 'modified',
                baseContent: { source: ['print("Hello Base")'], cell_type: 'code', execution_count: 1, metadata: {}, outputs: [] },
                currentContent: { source: ['print("Hello Current")'], cell_type: 'code', execution_count: 1, metadata: {}, outputs: [] },
                incomingContent: undefined,
                baseCellIndex: 1,
                currentCellIndex: 1,
                incomingCellIndex: undefined
            },
            {
                type: 'added',
                baseContent: undefined,
                currentContent: { source: ['x = 10'], cell_type: 'code', execution_count: 2, metadata: {}, outputs: [] },
                incomingContent: { source: ['x = 20'], cell_type: 'code', execution_count: 2, metadata: {}, outputs: [] },
                baseCellIndex: undefined,
                currentCellIndex: 2,
                incomingCellIndex: 1
            }
        ],
        base: { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }, // Simplified
        current: { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 },
        incoming: { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 },
        currentBranch: 'main',
        incomingBranch: 'feature'
    } as unknown as NotebookSemanticConflict // Cast as we omitted full notebook structures for brevity
};

test.describe('MergeNB GUI', () => {
    let server: any;
    let serverPort: number;

    test.beforeAll(async () => {
        // Dynamic require to ensure module-alias is active
        const { getWebServer } = require('../web/webServer');
        server = getWebServer();
        // Point extensionUri to project root so it can find dist/web
        // @ts-ignore - Using mock vscode
        server.setExtensionUri({ fsPath: path.resolve(__dirname, '../..') });
        // Use 127.0.0.1 to avoid IPv4/IPv6 ambiguity
        serverPort = await server.start({ port: 0, host: '127.0.0.1' });
        console.log(`Test server started on port ${serverPort}`);
    });

    test.afterAll(async () => {
        await server.stop();
    });

    test('should load conflict UI and interact with resolution buttons', async ({ page }) => {
        // Enable console logging from the browser
        page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
        page.on('pageerror', err => console.error(`[Browser Error] ${err.message}`));

        const sessionId = 'test-session';
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script>
                    // Mock VSCode API injected by extension
                    window.acquireVsCodeApi = () => ({
                        postMessage: (msg) => console.log('VSCode Message:', msg),
                        getState: () => ({}),
                        setState: () => {}
                    });
                </script>
                <script type="module" src="/client.js"></script>
            </head>
            <body><div id="root"></div></body>
            </html>
        `;

        // Navigate to the session URL (explicitly using 127.0.0.1)
        const sessionUrl = `http://127.0.0.1:${serverPort}/?session=${sessionId}`;

        console.log(`Navigating to ${sessionUrl}`);

        // Start session and navigation concurrently to prevent deadlock
        // openSession awaits the WebSocket connection, which is initiated by page.goto
        await Promise.all([
            server.openSession(sessionId, html, (msg: any) => {
                console.log('Received message from browser:', msg);
            }),
            page.goto(sessionUrl)
        ]);

        // Wait for connection to be fully ready
        await page.waitForTimeout(2000);

        // Send conflict data
        console.log('Sending conflict data...');
        server.sendConflictData(sessionId, mockConflictData);

        // Verify title
        await expect(page.locator('.header-title')).toHaveText('MergeNB', { timeout: 10000 });

        // Verify data-testid presence on rows
        // We expect identical row (0), conflict row (1), conflict row (2)
        // Implementation might map indexes differently based on view logic.
        // Let's check for any conflict row.
        const conflictRow = page.locator('[data-testid^="conflict-row-"]');
        await expect(conflictRow).toHaveCount(2);

        // Test taking base/current/incoming
        const firstConflict = conflictRow.first();

        // Check buttons
        await expect(firstConflict.locator('.btn-current')).toBeVisible();

        // Click 'Use Current'
        await firstConflict.locator('.btn-current').click();

        // Verify resolved content appears
        const resolvedEditor = firstConflict.locator('.resolved-content-input');
        await expect(resolvedEditor).toBeVisible();
        await expect(resolvedEditor).toHaveValue('print("Hello Current")');

        // Edit content
        await resolvedEditor.fill('print("Hello Edited")');

        // Verify 'Apply Resolution' button becomes enabled eventually (if all resolved)
        // Resolve the second conflict
        const secondConflict = conflictRow.nth(1);
        await secondConflict.locator('.btn-incoming').click();

        // Check Apply button
        const applyBtn = page.locator('.btn-primary'); // Apply Resolution
        await expect(applyBtn).toBeEnabled();
    });
});
