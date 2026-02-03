/**
 * @file diff.ts
 * @description Re-exports diff utilities from the shared diffUtils module.
 * 
 * This thin wrapper provides backward-compatible APIs for the web client
 * while delegating to the shared implementation.
 */

import { computeLineDiff as sharedComputeLineDiff, DiffLine, DiffResult } from '../../diffUtils';

// Re-export types from the shared module
export type { DiffLine, DiffResult, InlineChange } from '../../diffUtils';

/**
 * Compute a line-based diff between two strings.
 * Returns the right-side diff lines (showing what changed from old to new).
 * 
 * For full side-by-side display, use computeLineDiffAligned instead.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
    const result = sharedComputeLineDiff(oldText, newText);
    // Return the right side for display (shows the "new" content with change markers)
    return result.right;
}

/**
 * Compute aligned side-by-side diff between two strings.
 * Returns both left and right arrays with matching line positions.
 */
export function computeLineDiffAligned(oldText: string, newText: string): DiffResult {
    return sharedComputeLineDiff(oldText, newText);
}

/**
 * Get CSS class for diff line based on type and side.
 */
export function getDiffLineClass(line: DiffLine, side: 'base' | 'current' | 'incoming'): string {
    switch (line.type) {
        case 'unchanged':
            return 'diff-line';
        case 'added':
            return 'diff-line added';
        case 'removed':
            return 'diff-line removed';
        case 'modified':
            // Modified lines show inline changes
            return side === 'current' ? 'diff-line modified-old' : 'diff-line modified-new';
        default:
            return 'diff-line';
    }
}
