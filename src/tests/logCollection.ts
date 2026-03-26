/**
 * @file logCollection.ts
 * @description Per-async-context console capture using AsyncLocalStorage.
 *
 * Importing this module installs a single AsyncLocalStorage-aware patch over
 * console.log/warn/error. Code running inside withLogCollection() has all
 * console output routed into a per-invocation buffer rather than written to
 * the terminal. Code running outside any collection context falls through to
 * the original console methods unchanged.
 *
 * This lets parallel headless tests each capture their own logs without
 * race-condition interference — no global mutable state, no restore needed.
 */
import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage<string[]>();

// Capture original methods before patching.
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);

// Global capture buffer: collects logs that fall outside any per-test
// withLogCollection context (e.g. shared server I/O callbacks). Enabled by
// startGlobalCapture() and drained by flushGlobalCapture().
let _globalBuf: string[] | null = null;

function route(original: (...a: any[]) => void, args: any[]): void {
    const buf = storage.getStore();
    const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (buf !== undefined) {
        buf.push(line);
    } else if (_globalBuf !== null) {
        _globalBuf.push(line);
    } else {
        original(...args);
    }
}

// Installed once at module load time.
console.log = (...args: any[]): void => route(_log, args);
console.warn = (...args: any[]): void => route(_warn, args);
console.error = (...args: any[]): void => route(_error, args);

/**
 * Run fn inside a log-collection context. All console output within fn's
 * async subtree is captured into a buffer instead of written to the terminal.
 * Returns the function result and the captured log string.
 */
export async function withLogCollection<T>(
    fn: () => Promise<T>,
): Promise<{ result: T; logs: string }> {
    const buf: string[] = [];
    const result = await storage.run(buf, fn);
    return { result, logs: buf.join('\n') };
}

/**
 * Start capturing logs that fall outside any withLogCollection context
 * (e.g. shared server I/O callbacks that run in their own async resource).
 * Call flushGlobalCapture() to stop and retrieve the captured logs.
 */
export function startGlobalCapture(): void {
    _globalBuf = [];
}

/**
 * Stop global capture and return everything collected since startGlobalCapture().
 */
export function flushGlobalCapture(): string {
    const logs = _globalBuf?.join('\n') ?? '';
    _globalBuf = null;
    return logs;
}
