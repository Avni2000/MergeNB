/**
 * @file diff.ts
 * @description Simple line-based diff utilities for highlighting changes.
 */

export interface DiffLine {
    type: 'unchanged' | 'added' | 'removed';
    content: string;
}

/**
 * Compute a simple line-based diff between two strings.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const result: DiffLine[] = [];

    // Simple LCS-based diff
    const lcs = longestCommonSubsequence(oldLines, newLines);
    let oldIdx = 0;
    let newIdx = 0;
    let lcsIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
        if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx]) {
            if (newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
                result.push({ type: 'unchanged', content: lcs[lcsIdx] });
                oldIdx++;
                newIdx++;
                lcsIdx++;
            } else if (newIdx < newLines.length) {
                result.push({ type: 'added', content: newLines[newIdx] });
                newIdx++;
            } else {
                result.push({ type: 'removed', content: oldLines[oldIdx] });
                oldIdx++;
            }
        } else if (oldIdx < oldLines.length && (lcsIdx >= lcs.length || oldLines[oldIdx] !== lcs[lcsIdx])) {
            result.push({ type: 'removed', content: oldLines[oldIdx] });
            oldIdx++;
        } else if (newIdx < newLines.length) {
            result.push({ type: 'added', content: newLines[newIdx] });
            newIdx++;
        }
    }

    return result;
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to find LCS
    const result: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            result.unshift(a[i - 1]);
            i--;
            j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return result;
}

/**
 * Get CSS class for diff line based on type and side.
 */
export function getDiffLineClass(line: DiffLine, side: 'base' | 'current' | 'incoming'): string {
    if (line.type === 'unchanged') return 'diff-line';
    if (side === 'current') {
        return line.type === 'added' ? 'diff-line added' : 'diff-line removed';
    } else if (side === 'incoming') {
        return line.type === 'added' ? 'diff-line added' : 'diff-line removed';
    }
    return 'diff-line';
}
