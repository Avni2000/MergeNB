/**
 * @file diffUtils.ts
 * @description Text diffing utilities for visual conflict comparison.
 *
 * Uses the `diff` library (jsdiff) for line-level and word-level diffing.
 * Produces aligned left/right diff results for side-by-side display.
 * Used by the browser-based conflict resolver to render diff highlighting.
 */

import * as Diff from 'diff';

export interface DiffLine {
    type: 'unchanged' | 'added' | 'removed' | 'modified';
    content: string;
    /** For modified lines, the inline changes */
    inlineChanges?: InlineChange[];
}

export interface InlineChange {
    type: 'unchanged' | 'added' | 'removed';
    text: string;
}

export interface DiffResult {
    left: DiffLine[];   // Lines for the "old" / "current" / "base" side
    right: DiffLine[];  // Lines for the "new" / "incoming" side
}

/**
 * Compute a line-by-line diff between two strings.
 * Returns separate arrays for left and right sides with change annotations.
 */
export function computeLineDiff(oldText: string, newText: string): DiffResult {
    const changes = Diff.diffLines(oldText, newText, { newlineIsToken: false });

    const left: DiffLine[] = [];
    const right: DiffLine[] = [];

    // Pair up removed/added blocks so we can mark them as 'modified' with inline diffs
    // when there's a 1-to-1 correspondence.
    let i = 0;
    while (i < changes.length) {
        const change = changes[i];

        if (!change.added && !change.removed) {
            // Unchanged block
            const lines = splitLines(change.value);
            for (const line of lines) {
                left.push({ type: 'unchanged', content: line });
                right.push({ type: 'unchanged', content: line });
            }
            i++;
        } else if (change.removed) {
            // Look ahead: if the next block is an addition, treat as modification
            const next = changes[i + 1];
            if (next?.added) {
                const removedLines = splitLines(change.value);
                const addedLines = splitLines(next.value);
                const pairCount = Math.min(removedLines.length, addedLines.length);

                // Paired lines → 'modified' with inline diff
                for (let k = 0; k < pairCount; k++) {
                    left.push({
                        type: 'modified',
                        content: removedLines[k],
                        inlineChanges: computeInlineDiff(removedLines[k], addedLines[k], false),
                    });
                    right.push({
                        type: 'modified',
                        content: addedLines[k],
                        inlineChanges: computeInlineDiff(addedLines[k], removedLines[k], true),
                    });
                }

                // Remaining removed lines (more removed than added)
                for (let k = pairCount; k < removedLines.length; k++) {
                    left.push({ type: 'removed', content: removedLines[k] });
                    right.push({ type: 'unchanged', content: '' });
                }

                // Remaining added lines (more added than removed)
                for (let k = pairCount; k < addedLines.length; k++) {
                    left.push({ type: 'unchanged', content: '' });
                    right.push({ type: 'added', content: addedLines[k] });
                }

                i += 2; // consumed both blocks
            } else {
                // Pure removal
                for (const line of splitLines(change.value)) {
                    left.push({ type: 'removed', content: line });
                    right.push({ type: 'unchanged', content: '' });
                }
                i++;
            }
        } else {
            // Pure addition (not preceded by a removal)
            for (const line of splitLines(change.value)) {
                left.push({ type: 'unchanged', content: '' });
                right.push({ type: 'added', content: line });
            }
            i++;
        }
    }

    return { left, right };
}

/**
 * Compute inline (word-level) diff for a modified line.
 */
function computeInlineDiff(text: string, otherText: string, isNew: boolean): InlineChange[] {
    const changes = Diff.diffWords(text, otherText);
    const result: InlineChange[] = [];

    for (const change of changes) {
        if (!change.added && !change.removed) {
            result.push({ type: 'unchanged', text: change.value });
        } else if (isNew ? change.added : change.removed) {
            result.push({ type: isNew ? 'added' : 'removed', text: change.value });
        }
        // Skip the counterpart (removed on new side / added on old side)
    }

    return result;
}

/**
 * Split a diff chunk value into individual lines, dropping the trailing empty
 * string that results from a trailing newline.
 */
function splitLines(value: string): string[] {
    const lines = value.split('\n');
    // diffLines values end with '\n', producing a trailing empty element
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}
