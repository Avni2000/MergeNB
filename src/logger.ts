/**
 * @file logger.ts
 * @description Simple debug logging utility.
 * 
 * Logs only appear when: running in development (automatically detected).
 */

let vscode: typeof import('vscode') | undefined;
try {
    vscode = require('vscode');
} catch {
    // Running in headless mode (tests)
}

/**
 * Check if debug logging is enabled.
 * Only enabled in VSCode extension development mode.
 */
function isDebugEnabled(): boolean {
    return process.env.__VSCODE_EXTENSION_DEVELOPMENT__ === 'true';
}

/**
 * Log a debug message.
 * Only appears in development.
 */
export function debug(...args: any[]): void {
    if (isDebugEnabled()) {
        console.log('[MergeNB]', ...args);
    }
}

/**
 * Log an info message (always appears).
 */
export function info(...args: any[]): void {
    console.log('[MergeNB]', ...args);
}

/**
 * Log a warning message (always appears).
 */
export function warn(...args: any[]): void {
    console.warn('[MergeNB]', ...args);
}

/**
 * Log an error message (always appears).
 */
export function error(...args: any[]): void {
    console.error('[MergeNB]', ...args);
}
