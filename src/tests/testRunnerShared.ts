/**
 * Shared helpers for integration / headless test runners (paths, isolated config env).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TestDef } from './registry';

export function toSafePathSegment(value: string): string {
    const cleaned = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || 'test';
}

export function prepareIsolatedConfigPath(testId: string): {
    configRoot: string;
    configPath: string;
    testConfigPath: string;
} {
    const configRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `mergenb-test-${toSafePathSegment(testId)}-`),
    );
    const configPath = path.join(configRoot, 'config.json');
    const testConfigPath = path.join(configRoot, 'test-config.json');
    return { configRoot, configPath, testConfigPath };
}

export function cleanupIsolatedConfigPath(configRoot: string): void {
    try {
        fs.rmSync(configRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
}

export function resolveNotebookTripletPaths(test: Pick<TestDef, 'notebooks'>): [string, string, string] {
    const testDir = path.resolve(__dirname, '../../test');
    const [baseFile, currentFile, incomingFile] = test.notebooks.map(n =>
        path.join(testDir, n),
    ) as [string, string, string];

    for (const f of [baseFile, currentFile, incomingFile]) {
        if (!fs.existsSync(f)) {
            throw new Error(`Notebook not found: ${f}`);
        }
    }

    return [baseFile, currentFile, incomingFile];
}
