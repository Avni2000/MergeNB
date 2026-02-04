/**
 * @file diffUtils.ts
 * @description Text diffing utilities for visual conflict comparison.
 *
 * Implements LCS (Longest Common Subsequence) based diff algorithm:
 * - Line-by-line comparison between two text versions
 * - Inline word/character-level change detection within modified lines
 * - Produces aligned left/right diff results for side-by-side display
 * - Used by the browser-based conflict resolver to render diff highlighting
 */

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
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Compute LCS (Longest Common Subsequence) for line matching
    const lcs = computeLCS(oldLines, newLines);

    const left: DiffLine[] = [];
    const right: DiffLine[] = [];

    let oldIdx = 0;
    let newIdx = 0;
    let lcsIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
        if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx]) {
            // Check if this line also matches in new
            if (newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
                // Unchanged line
                left.push({ type: 'unchanged', content: oldLines[oldIdx] });
                right.push({ type: 'unchanged', content: newLines[newIdx] });
                oldIdx++;
                newIdx++;
                lcsIdx++;
            } else {
                // Line was added in new before this common line
                left.push({ type: 'unchanged', content: '' }); // Placeholder for alignment
                right.push({ type: 'added', content: newLines[newIdx] });
                newIdx++;
            }
        } else if (lcsIdx < lcs.length && newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
            // Line was removed from old
            left.push({ type: 'removed', content: oldLines[oldIdx] });
            right.push({ type: 'unchanged', content: '' }); // Placeholder
            oldIdx++;
        } else if (oldIdx < oldLines.length && newIdx < newLines.length) {
            // Both lines are different - this is a modification
            const inlineLeft = computeInlineDiff(oldLines[oldIdx], newLines[newIdx]);
            const inlineRight = computeInlineDiff(newLines[newIdx], oldLines[oldIdx], true);

            left.push({
                type: 'modified',
                content: oldLines[oldIdx],
                inlineChanges: inlineLeft
            });
            right.push({
                type: 'modified',
                content: newLines[newIdx],
                inlineChanges: inlineRight
            });
            oldIdx++;
            newIdx++;
        } else if (oldIdx < oldLines.length) {
            // Remaining lines in old are removed
            left.push({ type: 'removed', content: oldLines[oldIdx] });
            right.push({ type: 'unchanged', content: '' });
            oldIdx++;
        } else if (newIdx < newLines.length) {
            // Remaining lines in new are added
            left.push({ type: 'unchanged', content: '' });
            right.push({ type: 'added', content: newLines[newIdx] });
            newIdx++;
        }
    }

    return { left, right };
}

/**
 * Compute inline (word/character-level) diff for a modified line.
 * Uses word-level granularity for better readability.
 */
function computeInlineDiff(text: string, otherText: string, isNew: boolean = false): InlineChange[] {
    // Tokenize into words and whitespace
    const tokens1 = tokenizeWords(text);
    const tokens2 = tokenizeWords(otherText);
    const lcs = computeLCS(tokens1, tokens2);

    const changes: InlineChange[] = [];
    let idx1 = 0;
    let lcsIdx = 0;

    while (idx1 < tokens1.length) {
        if (lcsIdx < lcs.length && tokens1[idx1] === lcs[lcsIdx]) {
            changes.push({ type: 'unchanged', text: tokens1[idx1] });
            idx1++;
            lcsIdx++;
        } else {
            // This token was removed/added
            changes.push({
                type: isNew ? 'added' : 'removed',
                text: tokens1[idx1]
            });
            idx1++;
        }
    }

    return changes;
}

/**
 * Tokenize text into words and whitespace for word-level diff.
 * Preserves all characters including punctuation as separate tokens for fine-grained comparison.
 */
function tokenizeWords(text: string): string[] {
    const tokens: string[] = [];
    let current = '';

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const isWhitespace = /\s/.test(char);
        const isAlphaNum = /[a-zA-Z0-9_]/.test(char);

        if (isWhitespace) {
            // Flush current token
            if (current) {
                tokens.push(current);
                current = '';
            }
            // Add whitespace as a token
            tokens.push(char);
        } else if (isAlphaNum) {
            // Continue building alphanumeric word
            current += char;
        } else {
            // Punctuation or special character - flush and add separately
            if (current) {
                tokens.push(current);
                current = '';
            }
            tokens.push(char);
        }
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Compute Longest Common Subsequence of two arrays.
 * @param arr1
 * @param arr2
 * @returns The LCS as an array
 */
function computeLCS<T>(arr1: T[], arr2: T[]): T[] {
    const m = arr1.length;
    const n = arr2.length;

    // DP table
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (arr1[i - 1] === arr2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to find the LCS
    const lcs: T[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (arr1[i - 1] === arr2[j - 1]) {
            lcs.unshift(arr1[i - 1]);
            i--;
            j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return lcs;
}
