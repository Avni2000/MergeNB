/**
 * @file logger.ts
 * @description Simple debug logging utility.
 *
 * debug() logs appear when:
 *   - Running in VSCode extension development mode (__VSCODE_EXTENSION_DEVELOPMENT__=true)
 *   - Debug mode explicitly enabled (MERGENB_DEBUG=true, e.g. via --debug flag)
 *   - Running in CI with debug output (ACTIONS_DEBUG=1)
 *
 * info/warn/error always appear.
 *
 * Call sites are responsible for their own prefix (e.g. '[Resolver]', '[MergeNB]').
 */

/**
 * Check if debug logging is enabled.
 */
function isDebugEnabled(): boolean {
    if (typeof process === 'undefined' || typeof process.env === 'undefined') {
        return false;
    }
    return (
        process.env.__VSCODE_EXTENSION_DEVELOPMENT__ === 'true' ||
        process.env.MERGENB_DEBUG === 'true' ||
        process.env?.ACTIONS_DEBUG === '1'
    );
}

/**
 * Log a debug message. Only appears outside of production.
 */
export function debug(...args: any[]): void {
    if (isDebugEnabled()) {
        console.log(...args);
    }
}

/**
 * Log an info message (always appears).
 */
export function info(...args: any[]): void {
    console.log(...args);
}

/**
 * Log a warning message (always appears).
 */
export function warn(...args: any[]): void {
    console.warn(...args);
}

/**
 * Log an error message (always appears).
 */
export function error(...args: any[]): void {
    console.error(...args);
}
