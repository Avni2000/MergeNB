/**
 * @file testHelpers.ts
 * @description Shared utilities for MergeNB integration tests.
 * 
 * Contains common functions for:
 * - Server health checking
 * - Browser/page setup
 * - Cell source extraction
 * - Notebook structure validation
 */

import * as http from 'http';

/** Shape returned by the /health endpoint */
export interface HealthResponse {
    status: string;
    port: number;
    activeSessions: number;
    activeConnections: number;
    sessionIds: string[];
}

/** A cell we expect to find on disk after resolution */
export interface ExpectedCell {
    rowIndex: number;
    source: string;
    cellType: string;
    isConflict: boolean;
    isDeleted: boolean;
    metadata?: Record<string, unknown>;
    hasOutputs?: boolean;
}

/** Config written to disk by the runner, read by the test */
export interface TestConfig {
    workspacePath: string;
    testName: string;
    params?: any;
}

/** Definition of a test case used by the runner */
export interface TestCaseDefinition {
    /** Unique test name, used to dispatch to the right test module */
    name: string;
    /** Notebook files relative to test/ dir: [base, current, incoming] */
    notebooks: [string, string, string];
    /** Path to the compiled test module (.js) relative to out/tests/ */
    testModule: string;
    /** Optional parameters to pass to the test via config */
    params?: any;
}

/** Check if the web server is up */
export function checkHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 500 }, (res) => {
            res.resume(); // Drain body to free the socket
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

/** Get detailed health info from the web server */
export function getHealthInfo(port: number): Promise<HealthResponse | null> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve(null);
                return;
            }
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
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

/** Extract cell source as a string (handles both array and string formats) */
export function getCellSource(cell: any): string {
    if (!cell) return '';
    return Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
}

/** Parse a cell from data-cell attribute JSON */
export function parseCellFromAttribute(cellJson: string | null, context: string): any {
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

/** Wait for the web server to start and return its port. Throws if not found within timeout. */
export async function waitForServer(portFilePath: string, fs: typeof import('fs'), timeoutMs = 30000): Promise<number> {
    const maxAttempts = Math.ceil(timeoutMs / 500);
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            if (fs.existsSync(portFilePath)) {
                const portStr = fs.readFileSync(portFilePath, 'utf8').trim();
                const serverPort = parseInt(portStr, 10);
                if (serverPort > 0 && await checkHealth(serverPort)) {
                    return serverPort;
                }
            }
        } catch { /* continue polling */ }
    }
    throw new Error('Web server did not start within timeout');
}

/** Wait for a session to appear on the server. Returns the session ID. */
export async function waitForSession(port: number, timeoutMs = 15000): Promise<string> {
    const maxAttempts = Math.ceil(timeoutMs / 500);
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 500));
        const healthInfo = await getHealthInfo(port);
        if (healthInfo && healthInfo.sessionIds.length > 0) {
            return healthInfo.sessionIds[0];
        }
    }
    throw new Error('No session was created within timeout');
}

/** Validate that a resolved notebook has valid .ipynb structure */
export function validateNotebookStructure(notebook: any): void {
    if (typeof notebook.nbformat !== 'number') {
        throw new Error('Invalid notebook: missing nbformat');
    }
    if (typeof notebook.nbformat_minor !== 'number') {
        throw new Error('Invalid notebook: missing nbformat_minor');
    }
    if (!notebook.metadata || typeof notebook.metadata !== 'object') {
        throw new Error('Invalid notebook: missing metadata');
    }
    if (!Array.isArray(notebook.cells)) {
        throw new Error('Invalid notebook: cells not an array');
    }

    for (let i = 0; i < notebook.cells.length; i++) {
        const cell = notebook.cells[i];
        if (!cell.cell_type) throw new Error(`Cell ${i}: missing cell_type`);
        if (cell.source === undefined) throw new Error(`Cell ${i}: missing source`);
        if (!cell.metadata) throw new Error(`Cell ${i}: missing metadata`);
        if (cell.cell_type === 'code' && !Array.isArray(cell.outputs)) {
            throw new Error(`Cell ${i}: code cell missing outputs`);
        }
    }
}

/**
 * Wait for the conflict file to be written (mtime within last 10 seconds).
 * Returns true if confirmed, false otherwise.
 */
export async function waitForFileWrite(filePath: string, fs: typeof import('fs'), timeoutMs = 10000): Promise<boolean> {
    const maxAttempts = Math.ceil(timeoutMs / 500);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            const stat = fs.statSync(filePath);
            if (Date.now() - stat.mtimeMs < 10000) {
                return true;
            }
        } catch { /* continue */ }
    }
    return false;
}
