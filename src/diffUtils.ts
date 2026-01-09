/**
 * @file diffUtils.ts
 * @description Text diffing utilities for visual conflict comparison.
 * 
 * Implements LCS (Longest Common Subsequence) based diff algorithm:
 * - Line-by-line comparison between two text versions
 * - Inline word/character-level change detection within modified lines
 * - Produces aligned left/right diff results for side-by-side display
 * - Used by the webview panel to render diff highlighting
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
    left: DiffLine[];   // Lines for the "old" / "local" / "base" side
    right: DiffLine[];  // Lines for the "new" / "remote" side
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
 * Compute inline (character-level) diff for a modified line.
 */
function computeInlineDiff(text: string, otherText: string, isNew: boolean = false): InlineChange[] {
    // Simple word-level diff for better readability
    const words1 = tokenize(text);
    const words2 = tokenize(otherText);
    const lcs = computeLCS(words1, words2);
    
    const changes: InlineChange[] = [];
    let idx1 = 0;
    let lcsIdx = 0;
    
    while (idx1 < words1.length) {
        if (lcsIdx < lcs.length && words1[idx1] === lcs[lcsIdx]) {
            changes.push({ type: 'unchanged', text: words1[idx1] });
            idx1++;
            lcsIdx++;
        } else {
            // This word was removed/added
            changes.push({ 
                type: isNew ? 'added' : 'removed', 
                text: words1[idx1] 
            });
            idx1++;
        }
    }
    
    return changes;
}

/**
 * Tokenize text into words and whitespace for inline diff.
 */
function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inWord = false;
    
    for (const char of text) {
        const isWhitespace = /\s/.test(char);
        if (isWhitespace) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            tokens.push(char);
            inWord = false;
        } else {
            current += char;
            inWord = true;
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

/**
 * Generate HTML for a diff view with proper highlighting.
 * This creates a side-by-side view with synchronized line highlighting.
 */
export function generateDiffHtml(
    oldText: string, 
    newText: string,
    oldLabel: string = 'Old',
    newLabel: string = 'New'
): { leftHtml: string; rightHtml: string } {
    const diff = computeLineDiff(oldText, newText);
    
    let leftHtml = '';
    let rightHtml = '';
    
    for (let i = 0; i < Math.max(diff.left.length, diff.right.length); i++) {
        const leftLine = diff.left[i];
        const rightLine = diff.right[i];
        
        if (leftLine) {
            leftHtml += renderDiffLine(leftLine, 'left');
        }
        if (rightLine) {
            rightHtml += renderDiffLine(rightLine, 'right');
        }
    }
    
    return { leftHtml, rightHtml };
}

/**
 * Render a single diff line with appropriate CSS classes.
 */
function renderDiffLine(line: DiffLine, side: 'left' | 'right'): string {
    const lineClass = getLineClass(line.type, side);
    
    if (line.content === '' && (line.type === 'unchanged')) {
        // Empty placeholder line for alignment
        return `<div class="diff-line diff-line-empty">&nbsp;</div>`;
    }
    
    if (line.inlineChanges && line.inlineChanges.length > 0) {
        // Line with inline changes
        const content = line.inlineChanges.map(change => {
            const cls = getInlineClass(change.type, side);
            return `<span class="${cls}">${escapeHtml(change.text)}</span>`;
        }).join('');
        return `<div class="diff-line ${lineClass}">${content || '&nbsp;'}</div>`;
    }
    
    return `<div class="diff-line ${lineClass}">${escapeHtml(line.content) || '&nbsp;'}</div>`;
}

function getLineClass(type: DiffLine['type'], side: 'left' | 'right'): string {
    switch (type) {
        case 'unchanged':
            return 'diff-line-unchanged';
        case 'added':
            return 'diff-line-added';
        case 'removed':
            return 'diff-line-removed';
        case 'modified':
            return side === 'left' ? 'diff-line-modified-old' : 'diff-line-modified-new';
        default:
            return '';
    }
}

function getInlineClass(type: InlineChange['type'], side: 'left' | 'right'): string {
    switch (type) {
        case 'unchanged':
            return 'diff-inline-unchanged';
        case 'added':
            return 'diff-inline-added';
        case 'removed':
            return 'diff-inline-removed';
        default:
            return '';
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
