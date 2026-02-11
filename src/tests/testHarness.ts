import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page } from 'playwright';
import {
    type ExpectedCell,
    type TestConfig,
    getCellSource,
    waitForServer,
    waitForSession,
    waitForFileWrite,
} from './testHelpers';
import { ensureCheckboxChecked } from './integrationUtils';

export interface ConflictSession {
    config: TestConfig;
    workspacePath: string;
    conflictFile: string;
    serverPort: number;
    sessionId: string;
    browser: Browser;
    page: Page;
}

export interface SetupOptions {
    headless?: boolean;
    serverTimeoutMs?: number;
    sessionTimeoutMs?: number;
    afterNavigateDelayMs?: number;
    postHeaderDelayMs?: number;
}

export interface ApplyOptions {
    markResolved?: boolean;
    postClickDelayMs?: number;
    writeTimeoutMs?: number;
}

export interface NotebookMatchOptions {
    expectedLabel?: string;
    compareMetadata?: boolean;
    compareExecutionCounts?: boolean;
    renumberEnabled?: boolean;
    logCounts?: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function readTestConfig(): TestConfig {
    const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export async function setupConflictResolver(
    config: TestConfig,
    options: SetupOptions = {}
): Promise<ConflictSession> {
    const workspacePath = config.workspacePath;
    const conflictFile = path.join(workspacePath, 'conflict.ipynb');

    const doc = await vscode.workspace.openTextDocument(conflictFile);
    await vscode.window.showTextDocument(doc);
    await sleep(1000);

    console.log('[TestHarness] Executing merge-nb.findConflicts command...');
    await vscode.commands.executeCommand('merge-nb.findConflicts');
    console.log('[TestHarness] merge-nb.findConflicts command executed');

    console.log('[TestHarness] Waiting for server to start...');
    const serverPort = await waitForServer(
        () => Promise.resolve(vscode.commands.executeCommand<number>('merge-nb.getWebServerPort')),
        options.serverTimeoutMs
    );
    console.log(`[TestHarness] Server started on port ${serverPort}`);

    const sessionId = await waitForSession(serverPort, options.sessionTimeoutMs);
    console.log(`Session created: ${sessionId}`);

    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        const page = await browser.newPage();

        const sessionUrl = `http://127.0.0.1:${serverPort}/?session=${sessionId}`;
        await page.goto(sessionUrl);
        await sleep(options.afterNavigateDelayMs ?? 3000);

        await page.waitForSelector('.header-title', { timeout: 15000 });
        const title = await page.locator('.header-title').textContent();
        if (title?.trim() !== 'MergeNB') {
            throw new Error(`Expected header 'MergeNB', got '${title}'`);
        }

        await sleep(options.postHeaderDelayMs ?? 1000);

        return {
            config,
            workspacePath,
            conflictFile,
            serverPort,
            sessionId,
            browser,
            page,
        };
    } catch (err) {
        await browser.close();
        throw err;
    }
}

export async function applyResolutionAndReadNotebook(
    page: Page,
    conflictFile: string,
    options: ApplyOptions = {}
): Promise<any> {
    if (options.markResolved ?? true) {
        await ensureCheckboxChecked(page, 'Mark as resolved');
    }

    console.log('\n=== Applying resolution ===');
    const applyButton = page.locator('button.btn-primary:has-text("Apply Resolution")');
    await applyButton.waitFor({ timeout: 5000 });

    if (await applyButton.isDisabled()) {
        throw new Error('Apply Resolution button is disabled');
    }

    await applyButton.click();
    await sleep(options.postClickDelayMs ?? 3000);

    const fileWritten = await waitForFileWrite(conflictFile, fs, options.writeTimeoutMs);
    if (!fileWritten) {
        console.log('Warning: Could not confirm file write, proceeding anyway');
    }

    const notebookContent = fs.readFileSync(conflictFile, 'utf8');
    return JSON.parse(notebookContent);
}

export function buildExpectedCellsFromNotebook(notebook: any): ExpectedCell[] {
    if (!notebook || !Array.isArray(notebook.cells)) {
        return [];
    }
    return notebook.cells.map((cell: any, index: number) => {
        const cellType = cell?.cell_type || 'code';
        const hasOutputs = cellType === 'code' &&
            Array.isArray(cell.outputs) &&
            cell.outputs.length > 0;
        return {
            rowIndex: index,
            source: getCellSource(cell),
            cellType,
            metadata: cell?.metadata || {},
            hasOutputs,
        };
    });
}

export function assertNotebookMatches(
    expectedCells: ExpectedCell[],
    resolvedNotebook: any,
    options: NotebookMatchOptions = {}
): void {
    const expectedNonDeleted = expectedCells.filter(c => !c.isDeleted);
    const label = options.expectedLabel || 'Expected';
    const logCounts = options.logCounts ?? true;

    if (!resolvedNotebook || !Array.isArray(resolvedNotebook.cells)) {
        throw new Error('Resolved notebook is missing cells');
    }

    if (logCounts) {
        console.log(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
        console.log(`${label}: ${expectedNonDeleted.length} cells`);
    }

    if (resolvedNotebook.cells.length !== expectedNonDeleted.length) {
        console.log('Cell count mismatch:');
        console.log('Expected cells:');
        for (const cell of expectedNonDeleted) {
            console.log(`  Row ${cell.rowIndex}: ${cell.cellType}, ${cell.source.length} chars`);
        }
        console.log('Actual cells:');
        for (let i = 0; i < resolvedNotebook.cells.length; i++) {
            const src = getCellSource(resolvedNotebook.cells[i]);
            console.log(`  Cell ${i}: ${resolvedNotebook.cells[i].cell_type}, ${src.length} chars`);
        }
        throw new Error(`Cell count mismatch: expected ${expectedNonDeleted.length}, got ${resolvedNotebook.cells.length}`);
    }

    let sourceMismatches = 0;
    let typeMismatches = 0;
    let metadataMismatches = 0;
    let executionMismatches = 0;
    let nextExecutionCount = 1;

    for (let i = 0; i < expectedNonDeleted.length; i++) {
        const expected = expectedNonDeleted[i];
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

        if (options.compareMetadata) {
            const expectedMetadata = expected.metadata || {};
            const actualMetadata = actual.metadata || {};
            if (JSON.stringify(expectedMetadata) !== JSON.stringify(actualMetadata)) {
                metadataMismatches++;
                console.log(`Metadata mismatch at cell ${i}`);
            }
        }

        if (options.compareExecutionCounts && expected.cellType === 'code') {
            const expectedExecutionCount = options.renumberEnabled
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
}
