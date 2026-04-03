/**
 * Shared helpers for integration / headless test runners (paths, isolated config env).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function toSafePathSegment(value: string): string {
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
