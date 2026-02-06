/**
 * @file cellMatcher.ts
 * @description Cell matching algorithm for three-way notebook merge.
 * 
 * Matches cells across base/current/incoming versions using:
 * - nbdime-style "snaking" algorithm for optimal sequence alignment
 * - Multilevel comparison predicates (strict to loose) following nbdime
 * - Cell ID matching (strictest level)
 * - SequenceMatcher-like string similarity
 * - Output comparison for code cells
 * - Position-based fallback for ambiguous cases
 * 
 * The snaking algorithm computes "snakes" (contiguous sequences of matching
 * cells) using LCS, which provides better alignment than simple pairwise
 * greedy matching.
 * 
 * Also detects cell reordering conflicts where the same cells
 * appear in different orders between branches.
 */

import { NotebookCell, Notebook, CellMapping } from './types';
import { sortByPosition } from './positionUtils';

/** A snake represents a contiguous sequence of matching elements */
interface Snake {
    i: number;  // Start index in sequence A
    j: number;  // Start index in sequence B
    n: number;  // Length of the contiguous match
}

/** Comparison function type for cell matching */
type CellCompare = (a: NotebookCell, b: NotebookCell) => boolean;

// ============================================================================
// String Similarity (SequenceMatcher-like)
// ============================================================================

/**
 * Get normalized source from a cell
 */
function getCellSource(cell: NotebookCell): string {
    return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

/**
 * Find the longest contiguous matching substring.
 * Returns [aStart, bStart, length].
 * Uses hash-based element lookup similar to Python's difflib.SequenceMatcher.
 */
function findLongestMatch(
    a: string, b: string,
    aLo: number, aHi: number,
    bLo: number, bHi: number
): [number, number, number] {
    // Build index: char -> positions in b[bLo:bHi]
    const b2j = new Map<string, number[]>();
    for (let j = bLo; j < bHi; j++) {
        const ch = b[j];
        let arr = b2j.get(ch);
        if (!arr) {
            arr = [];
            b2j.set(ch, arr);
        }
        arr.push(j);
    }

    let bestI = aLo, bestJ = bLo, bestSize = 0;
    // j2len[j] = length of longest match ending at a[..], b[j]
    let j2len = new Map<number, number>();
    
    for (let i = aLo; i < aHi; i++) {
        const newJ2len = new Map<number, number>();
        const positions = b2j.get(a[i]);
        if (positions) {
            for (const j of positions) {
                const k = (j2len.get(j - 1) || 0) + 1;
                newJ2len.set(j, k);
                if (k > bestSize) {
                    bestI = i - k + 1;
                    bestJ = j - k + 1;
                    bestSize = k;
                }
            }
        }
        j2len = newJ2len;
    }
    
    return [bestI, bestJ, bestSize];
}

/**
 * Count total matching characters using matching blocks (SequenceMatcher algorithm).
 * Recursively finds longest contiguous matches and counts their total length.
 */
function countMatchingChars(a: string, b: string): number {
    const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
    let total = 0;
    
    while (queue.length > 0) {
        const [aLo, aHi, bLo, bHi] = queue.pop()!;
        const [i, j, k] = findLongestMatch(a, b, aLo, aHi, bLo, bHi);
        if (k > 0) {
            total += k;
            if (aLo < i && bLo < j) {
                queue.push([aLo, i, bLo, j]);
            }
            if (i + k < aHi && j + k < bHi) {
                queue.push([i + k, aHi, j + k, bHi]);
            }
        }
    }
    
    return total;
}

/**
 * Compute the ratio of matching characters between two strings.
 * Equivalent to Python's difflib.SequenceMatcher.ratio().
 * Returns 2.0 * M / T where M = matching chars, T = total chars in both strings.
 */
function sequenceMatcherRatio(a: string, b: string): number {
    if (a === b) return 1.0;
    const la = a.length, lb = b.length;
    if (!la && !lb) return 1.0;
    if (!la || !lb) return 0;
    
    const matches = countMatchingChars(a, b);
    return 2.0 * matches / (la + lb);
}

/**
 * Quick upper-bound ratio estimate based on character frequency overlap.
 * Equivalent to Python's difflib.SequenceMatcher.quick_ratio().
 */
function quickRatio(a: string, b: string): number {
    const la = a.length, lb = b.length;
    if (!la && !lb) return 1.0;
    if (!la || !lb) return 0;
    
    // Count character frequencies in both strings
    const freqA = new Map<string, number>();
    const freqB = new Map<string, number>();
    for (const ch of a) freqA.set(ch, (freqA.get(ch) || 0) + 1);
    for (const ch of b) freqB.set(ch, (freqB.get(ch) || 0) + 1);
    
    // Sum minimum frequencies = upper bound on matching chars
    let avail = 0;
    for (const [ch, count] of freqA) {
        avail += Math.min(count, freqB.get(ch) || 0);
    }
    
    return 2.0 * avail / (la + lb);
}

/**
 * Fastest upper-bound ratio estimate based on lengths only.
 * Equivalent to Python's difflib.SequenceMatcher.real_quick_ratio().
 */
function realQuickRatio(a: string, b: string): number {
    const la = a.length, lb = b.length;
    if (!la && !lb) return 1.0;
    if (!la || !lb) return 0;
    return 2.0 * Math.min(la, lb) / (la + lb);
}

/**
 * Compare two strings approximately, using SequenceMatcher-like ratio.
 * Equivalent to nbdime's compare_strings_approximate.
 * Uses fast cutoffs: real_quick_ratio -> quick_ratio -> full ratio.
 * 
 * @param a - First string
 * @param b - Second string
 * @param threshold - Minimum ratio to consider strings similar (default 0.7)
 * @param maxlen - Maximum length for detailed comparison (skip if both exceed)
 */
function compareStringsApproximate(
    a: string, b: string,
    threshold: number = 0.7,
    maxlen?: number
): boolean {
    // Fast cutoff: one empty, other not
    if ((!a) !== (!b)) return false;
    
    // Fast exact equality check
    if (a.length === b.length && a === b) return true;
    
    // Fast cutoff based on lengths
    if (realQuickRatio(a, b) < threshold) return false;
    
    // Moderate cutoff based on character frequencies
    if (quickRatio(a, b) < threshold) return false;
    
    // Max length cutoff (for very long strings that aren't exactly equal)
    if (maxlen !== undefined && a.length > maxlen && b.length > maxlen) return false;
    
    // Full ratio computation
    return sequenceMatcherRatio(a, b) > threshold;
}

// ============================================================================
// Cell Similarity
// ============================================================================

/**
 * Compute similarity score between two cells (0-1) using SequenceMatcher ratio.
 * This replaces line-based LCS with character-level matching blocks.
 */
function computeCellSimilarity(cell1: NotebookCell, cell2: NotebookCell): number {
    if (cell1.cell_type !== cell2.cell_type) {
        return 0;
    }

    const source1 = getCellSource(cell1);
    const source2 = getCellSource(cell2);

    if (source1 === source2) {
        return 1.0;
    }

    if (!source1 && !source2) {
        return 1.0;
    }
    if (!source1 || !source2) {
        return 0;
    }

    return sequenceMatcherRatio(source1, source2);
}

// ============================================================================
// Output Comparison (for code cells)
// ============================================================================

/**
 * Compare two outputs approximately.
 * Matches nbdime's compare_output_approximate.
 */
function compareOutputApproximate(x: Record<string, unknown>, y: Record<string, unknown>): boolean {
    if (!x || !y) return x === y;
    if (x.output_type !== y.output_type) return false;
    
    // Skip metadata and execution count
    if (x.output_type === 'stream') {
        if (x.name !== y.name) return false;
        const xText = Array.isArray(x.text) ? (x.text as string[]).join('') : String(x.text || '');
        const yText = Array.isArray(y.text) ? (y.text as string[]).join('') : String(y.text || '');
        return compareStringsApproximate(xText, yText, 0.7, 1000);
    }
    
    if (x.output_type === 'error') {
        return x.ename === y.ename && x.evalue === y.evalue;
    }
    
    if (x.output_type === 'display_data' || x.output_type === 'execute_result') {
        const xData = (x.data || {}) as Record<string, unknown>;
        const yData = (y.data || {}) as Record<string, unknown>;
        const xKeys = new Set(Object.keys(xData));
        const yKeys = new Set(Object.keys(yData));
        if (xKeys.size !== yKeys.size) return false;
        for (const k of xKeys) {
            if (!yKeys.has(k)) return false;
        }
        for (const key of xKeys) {
            if (key.startsWith('text/')) {
                const xVal = Array.isArray(xData[key]) ? (xData[key] as string[]).join('') : String(xData[key]);
                const yVal = Array.isArray(yData[key]) ? (yData[key] as string[]).join('') : String(yData[key]);
                if (!compareStringsApproximate(xVal, yVal, 0.7, 10000)) {
                    return false;
                }
            }
        }
        return true;
    }
    
    return true;
}



/**
 * Compare two outputs strictly.
 * Matches nbdime's compare_output_strict.
 */
function compareOutputStrict(x: Record<string, unknown>, y: Record<string, unknown>): boolean {
    if (!x || !y) return x === y;
    if (x.output_type !== y.output_type) return false;
    
    const xKeys = new Set(Object.keys(x));
    const yKeys = new Set(Object.keys(y));
    
    const handled = new Set(['output_type', 'data', 'metadata', 'execution_count']);
    
    // Strict match on all keys we don't otherwise handle
    for (const k of xKeys) {
        if (!handled.has(k) && JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
            return false;
        }
    }
    for (const k of yKeys) {
        if (!handled.has(k) && !(k in x)) {
            return false;
        }
    }

    
    // Compare data strictly
    const xData = (x.data || {}) as Record<string, unknown>;
    const yData = (y.data || {}) as Record<string, unknown>;
    const xDataKeys = new Set(Object.keys(xData));
    const yDataKeys = new Set(Object.keys(yData));
    if (xDataKeys.size !== yDataKeys.size) return false;
    for (const k of xDataKeys) {
        if (!yDataKeys.has(k)) return false;
        const xVal = Array.isArray(xData[k]) ? (xData[k] as string[]).join('') : String(xData[k]);
        const yVal = Array.isArray(yData[k]) ? (yData[k] as string[]).join('') : String(yData[k]);
        if (!compareStringsApproximate(xVal, yVal, 0.95, 10000)) {
            return false;
        }
    }
    
    return true;
}

/**
 * Compare sequences of outputs approximately.
 */
function compareOutputsApproximate(xOutputs: Record<string, unknown>[], yOutputs: Record<string, unknown>[]): boolean {
    if (xOutputs.length !== yOutputs.length) return false;
    for (let i = 0; i < xOutputs.length; i++) {
        if (!compareOutputApproximate(xOutputs[i], yOutputs[i])) {
            return false;
        }
    }
    return true;
}

// ============================================================================
// nbdime-style Snaking Algorithm
// ============================================================================

/**
 * Compute a comparison grid G[i][j] = compare(A[i], B[j])
 */
function computeCompareGrid<T>(
    A: T[],
    B: T[],
    compare: (a: T, b: T) => boolean
): boolean[][] {
    return A.map(a => B.map(b => compare(a, b)));
}

/**
 * Compute the LCS length grid R[x][y] = LCS length of A[0:x] and B[0:y]
 * given a precomputed comparison grid G.
 */
function computeLCSGrid(G: boolean[][]): number[][] {
    const N = G.length;
    const M = N > 0 ? G[0].length : 0;
    
    const R: number[][] = Array(N + 1).fill(null).map(() => Array(M + 1).fill(0));
    
    for (let x = 1; x <= N; x++) {
        for (let y = 1; y <= M; y++) {
            if (G[x - 1][y - 1]) {
                R[x][y] = R[x - 1][y - 1] + 1;
            } else {
                R[x][y] = Math.max(R[x - 1][y], R[x][y - 1]);
            }
        }
    }
    
    return R;
}

/**
 * Compute LCS indices by backtracking through the LCS grid.
 * Returns parallel arrays of matching indices (A_indices, B_indices).
 */
function computeLCSIndices<T>(
    A: T[],
    B: T[],
    G: boolean[][],
    R: number[][]
): [number[], number[]] {
    const N = A.length;
    const M = B.length;
    const A_indices: number[] = [];
    const B_indices: number[] = [];
    
    let x = N;
    let y = M;
    
    while (x > 0 && y > 0) {
        if (G[x - 1][y - 1]) {
            x--;
            y--;
            A_indices.push(x);
            B_indices.push(y);
        } else if (R[x - 1][y] >= R[x][y - 1]) {
            x--;
        } else {
            y--;
        }
    }
    
    A_indices.reverse();
    B_indices.reverse();
    
    return [A_indices, B_indices];
}

/**
 * Compute snakes from LCS indices.
 * A snake is a tuple (i, j, n) representing n contiguous matching elements
 * starting at index i in A and index j in B.
 */
function computeSnakesFromLCS(
    A_indices: number[],
    B_indices: number[]
): Snake[] {
    const snakes: Snake[] = [];
    
    if (A_indices.length === 0) {
        return snakes;
    }
    
    let currentSnake: Snake = { i: A_indices[0], j: B_indices[0], n: 1 };
    
    for (let k = 1; k < A_indices.length; k++) {
        const ai = A_indices[k];
        const bj = B_indices[k];
        
        // Check if this extends the current snake (contiguous in both sequences)
        if (ai === currentSnake.i + currentSnake.n && 
            bj === currentSnake.j + currentSnake.n) {
            currentSnake.n++;
        } else {
            // Start a new snake
            snakes.push(currentSnake);
            currentSnake = { i: ai, j: bj, n: 1 };
        }
    }
    
    snakes.push(currentSnake);
    return snakes;
}

/**
 * Compute snakes (contiguous matching sequences) using the comparison function.
 * This is the core of nbdime's snaking algorithm.
 */
function computeSnakes<T>(
    A: T[],
    B: T[],
    compare: (a: T, b: T) => boolean
): Snake[] {
    if (A.length === 0 || B.length === 0) {
        return [];
    }
    
    const G = computeCompareGrid(A, B, compare);
    const R = computeLCSGrid(G);
    const [A_indices, B_indices] = computeLCSIndices(A, B, G, R);
    
    return computeSnakesFromLCS(A_indices, B_indices);
}

/**
 * Compute snakes using a multilevel multi-predicate algorithm.
 * 
 * Based on nbdime's snaking algorithm. This algorithm first finds matches using 
 * the strictest predicate (level N), then recursively fills gaps between matches 
 * using looser predicates.
 * 
 * @param A - First sequence of cells
 * @param B - Second sequence of cells
 * @param compares - Array of comparison predicates, from loosest (0) to strictest (N-1)
 * @param rect - Optional bounding rectangle [i0, j0, i1, j1]
 * @param level - Current comparison level (defaults to strictest)
 */
function computeSnakesMultilevel(
    A: NotebookCell[],
    B: NotebookCell[],
    compares: CellCompare[],
    rect?: [number, number, number, number],
    level?: number
): Snake[] {
    if (level === undefined) {
        level = compares.length - 1;
    }
    if (rect === undefined) {
        rect = [0, 0, A.length, B.length];
    }
    
    const [i0, j0, i1, j1] = rect;
    
    // Compute initial set of coarse snakes at this level
    const compare = compares[level];
    const snakes = computeSnakes(A.slice(i0, i1), B.slice(j0, j1), compare)
        .map(s => ({ i: s.i + i0, j: s.j + j0, n: s.n }));
    
    // Base case: at the loosest level, just return what we found
    if (level === 0) {
        return snakes;
    }
    
    // Following nbdime's approach: start with an empty sentinel snake
    // that may be extended or popped at the end
    const newSnakes: Snake[] = [{ i: 0, j: 0, n: 0 }];
    let currentI = i0;
    let currentJ = j0;
    
    // Process each snake and the gap before it
    // Append sentinel snake to handle final gap (as in nbdime)
    for (const snake of [...snakes, { i: i1, j: j1, n: 0 }]) {
        // Is there a gap before this snake?
        if (snake.i > currentI && snake.j > currentJ) {
            // Recurse to compute snakes with less accurate compare 
            // predicates between the coarse snakes
            const subRect: [number, number, number, number] = [currentI, currentJ, snake.i, snake.j];
            const gapSnakes = computeSnakesMultilevel(A, B, compares, subRect, level - 1);
            newSnakes.push(...gapSnakes);
        }
        
        // Add the current snake if it has length
        if (snake.n > 0) {
            const last = newSnakes[newSnakes.length - 1];
            if (last.i + last.n === snake.i && last.j + last.n === snake.j) {
                // Merge contiguous snakes
                last.n += snake.n;
            } else {
                // Add new snake
                newSnakes.push({ ...snake });
            }
        }
        
        currentI = snake.i + snake.n;
        currentJ = snake.j + snake.n;
    }
    
    // Pop empty snake from beginning if it wasn't extended inside the loop
    if (newSnakes.length > 0 && newSnakes[0].n === 0) {
        newSnakes.shift();
    }
    
    return newSnakes;
}

// ============================================================================
// Comparison predicates for multilevel matching (following nbdime)
// ============================================================================

/**
 * Level 3 (strictest): Cell ID match.
 * Only considers cells equal if both have IDs and they match.
 * Matches nbdime's compare_cell_by_ids.
 */
function cellsMatchByIds(a: NotebookCell, b: NotebookCell): boolean {
    return !!a.id && !!b.id && a.id === b.id;
}

/**
 * Level 2: Strict match.
 * Cells have same type, very similar source (>=0.95 ratio), and strict output match.
 * Matches nbdime's compare_cell_strict.
 */
function cellsStrictMatch(a: NotebookCell, b: NotebookCell): boolean {
    if (a.cell_type !== b.cell_type) return false;
    
    const sourceA = getCellSource(a);
    const sourceB = getCellSource(b);
    if (!compareStringsApproximate(sourceA, sourceB, 0.95)) return false;
    
    // Compare outputs for code cells
    if (a.cell_type === 'code') {
        const aOutputs = (a.outputs || []) as unknown as Record<string, unknown>[];
        const bOutputs = (b.outputs || []) as unknown as Record<string, unknown>[];
        // Be strict on number of outputs
        if (aOutputs.length !== bOutputs.length) return false;
        // Be strict on content
        for (let i = 0; i < aOutputs.length; i++) {
            if (!compareOutputStrict(aOutputs[i], bOutputs[i])) {
                return false;
            }
        }
    }
    
    return true;
}

/**
 * Level 1: Moderate match.
 * Cells have same type and moderately similar source (>=0.7 ratio).
 * For code cells, also requires similar outputs.
 * Matches nbdime's compare_cell_moderate.
 */
function cellsModerateMatch(a: NotebookCell, b: NotebookCell): boolean {
    if (a.cell_type !== b.cell_type) return false;
    
    const sourceA = getCellSource(a);
    const sourceB = getCellSource(b);
    if (!compareStringsApproximate(sourceA, sourceB, 0.7)) return false;
    
    // Compare outputs for code cells
    if (a.cell_type === 'code') {
        const aOutputs = (a.outputs || []) as unknown as Record<string, unknown>[];
        const bOutputs = (b.outputs || []) as unknown as Record<string, unknown>[];
        if (!!aOutputs.length !== !!bOutputs.length) return false;
        if (aOutputs.length > 0 && bOutputs.length > 0) {
            if (!compareOutputsApproximate(aOutputs, bOutputs)) {
                return false;
            }
        }
    }
    
    return true;
}

/**
 * Level 0 (loosest): Approximate match.
 * Cells have same type and approximately similar source.
 * Short strings (< 10 chars) are always considered matching.
 * Matches nbdime's compare_cell_approximate.
 */
function cellsApproximateMatch(a: NotebookCell, b: NotebookCell): boolean {
    if (a.cell_type !== b.cell_type) return false;
    
    const sourceA = getCellSource(a);
    const sourceB = getCellSource(b);
    
    // Fast cutoff when one is empty and other isn't
    if ((!sourceA) !== (!sourceB)) return false;
    
    // Short string optimization (from nbdime's compare_text_approximate):
    // Allow aligning short strings without detailed comparison
    const shortLen = 10;
    if (sourceA.length < shortLen && sourceB.length < shortLen) {
        return true;
    }
    
    return compareStringsApproximate(sourceA, sourceB, 0.7);
}


/**
 * Match cells between base and current/incoming versions using snaking algorithm.
 * 
 * Uses nbdime-style multilevel comparison with 4 levels:
 * - Level 3 (strictest): Cell ID match
 * - Level 2: Strict source (>=0.95) + strict output match
 * - Level 1: Moderate source (>=0.7) + approximate output match
 * - Level 0 (loosest): Approximate source (>=0.7, short-string optimization)
 * 
 * Returns a map from base cell index to other cell index.
 */
function matchCellsToBase(
    baseCells: NotebookCell[],
    otherCells: NotebookCell[]
): Map<number, number> {
    const matches = new Map<number, number>(); // baseIndex -> otherIndex
    
    if (baseCells.length === 0 || otherCells.length === 0) {
        return matches;
    }
    
    // Use multilevel snaking algorithm with comparison predicates
    // Ordered from loosest (0) to strictest (N-1), following nbdime
    const compares: CellCompare[] = [
        cellsApproximateMatch, // Level 0: >=0.7 similar, short-string opt
        cellsModerateMatch,    // Level 1: >=0.7 similar + output match
        cellsStrictMatch,      // Level 2: >=0.95 similar + strict outputs
        cellsMatchByIds,       // Level 3: cell ID match
    ];
    
    const snakes = computeSnakesMultilevel(baseCells, otherCells, compares);
    
    // Convert snakes to matches
    for (const snake of snakes) {
        for (let k = 0; k < snake.n; k++) {
            matches.set(snake.i + k, snake.j + k);
        }
    }
    
    return matches;
}

/**
 * Main function: Match cells across all three versions (base, current, incoming)
 */
export function matchCells(
    base: Notebook | null | undefined,
    current: Notebook | null | undefined,
    incoming: Notebook | null | undefined
): CellMapping[] {
    const mappings: CellMapping[] = [];
    
    // Handle edge cases
    if (!base && !current && !incoming) {
        return [];
    }
    
    const baseCells = base?.cells || [];
    const currentCells = current?.cells || [];
    const incomingCells = incoming?.cells || [];
    
    // If no base, match current to incoming directly using snaking
    if (baseCells.length === 0) {
        // Use snaking for current -> incoming matching
        const currentToIncoming = matchCellsToBase(currentCells, incomingCells);
        const usedincomingIndices = new Set<number>();
        
        for (let currentIdx = 0; currentIdx < currentCells.length; currentIdx++) {
            const incomingIdx = currentToIncoming.get(currentIdx);
            
            if (incomingIdx !== undefined) {
                mappings.push({
                    currentIndex: currentIdx,
                    incomingIndex: incomingIdx,
                    matchConfidence: 1.0,
                    currentCell: currentCells[currentIdx],
                    incomingCell: incomingCells[incomingIdx]
                });
                usedincomingIndices.add(incomingIdx);
            } else {
                // Unmatched current cell
                mappings.push({
                    currentIndex: currentIdx,
                    matchConfidence: 1.0,
                    currentCell: currentCells[currentIdx]
                });
            }
        }
        
        // Unmatched incoming cells
        for (let incomingIdx = 0; incomingIdx < incomingCells.length; incomingIdx++) {
            if (!usedincomingIndices.has(incomingIdx)) {
                mappings.push({
                    incomingIndex: incomingIdx,
                    matchConfidence: 1.0,
                    incomingCell: incomingCells[incomingIdx]
                });
            }
        }
        
        return mappings;
    }
    
    // Match base to current and base to incoming
    const baseTocurrent = matchCellsToBase(baseCells, currentCells);
    const baseToincoming = matchCellsToBase(baseCells, incomingCells);
    
    const usedcurrentIndices = new Set<number>();
    const usedincomingIndices = new Set<number>();
    
    // Create mappings for cells that exist in base
    for (let baseIdx = 0; baseIdx < baseCells.length; baseIdx++) {
        const currentIdx = baseTocurrent.get(baseIdx);
        const incomingIdx = baseToincoming.get(baseIdx);
        
        const mapping: CellMapping = {
            baseIndex: baseIdx,
            currentIndex: currentIdx,
            incomingIndex: incomingIdx,
            matchConfidence: 0.9, // High confidence for base-anchored matches
            baseCell: baseCells[baseIdx],
            currentCell: currentIdx !== undefined ? currentCells[currentIdx] : undefined,
            incomingCell: incomingIdx !== undefined ? incomingCells[incomingIdx] : undefined
        };
        
        mappings.push(mapping);
        
        if (currentIdx !== undefined) usedcurrentIndices.add(currentIdx);
        if (incomingIdx !== undefined) usedincomingIndices.add(incomingIdx);
    }
    
    // Handle cells that exist in current but not matched to base
    // Use snaking on remaining unmatched cells for better alignment
    const unmatchedCurrentCells: NotebookCell[] = [];
    const unmatchedCurrentIndices: number[] = [];
    const unmatchedIncomingCells: NotebookCell[] = [];
    const unmatchedIncomingIndices: number[] = [];
    
    for (let currentIdx = 0; currentIdx < currentCells.length; currentIdx++) {
        if (!usedcurrentIndices.has(currentIdx)) {
            unmatchedCurrentCells.push(currentCells[currentIdx]);
            unmatchedCurrentIndices.push(currentIdx);
        }
    }
    
    for (let incomingIdx = 0; incomingIdx < incomingCells.length; incomingIdx++) {
        if (!usedincomingIndices.has(incomingIdx)) {
            unmatchedIncomingCells.push(incomingCells[incomingIdx]);
            unmatchedIncomingIndices.push(incomingIdx);
        }
    }
    
    // Match unmatched cells using snaking
    const unmatchedMatches = matchCellsToBase(unmatchedCurrentCells, unmatchedIncomingCells);
    const newlyMatchedIncoming = new Set<number>();
    
    for (let localCurrentIdx = 0; localCurrentIdx < unmatchedCurrentCells.length; localCurrentIdx++) {
        const localIncomingIdx = unmatchedMatches.get(localCurrentIdx);
        const globalCurrentIdx = unmatchedCurrentIndices[localCurrentIdx];
        
        if (localIncomingIdx !== undefined) {
            const globalIncomingIdx = unmatchedIncomingIndices[localIncomingIdx];
            mappings.push({
                currentIndex: globalCurrentIdx,
                incomingIndex: globalIncomingIdx,
                matchConfidence: computeCellSimilarity(
                    currentCells[globalCurrentIdx],
                    incomingCells[globalIncomingIdx]
                ),
                currentCell: currentCells[globalCurrentIdx],
                incomingCell: incomingCells[globalIncomingIdx]
            });
            newlyMatchedIncoming.add(localIncomingIdx);
        } else {
            // current-only cell
            mappings.push({
                currentIndex: globalCurrentIdx,
                matchConfidence: 1.0,
                currentCell: currentCells[globalCurrentIdx]
            });
        }
        
        usedcurrentIndices.add(globalCurrentIdx);
    }
    
    // Handle remaining incoming-only cells
    for (let localIncomingIdx = 0; localIncomingIdx < unmatchedIncomingCells.length; localIncomingIdx++) {
        if (newlyMatchedIncoming.has(localIncomingIdx)) continue;
        
        const globalIncomingIdx = unmatchedIncomingIndices[localIncomingIdx];
        mappings.push({
            incomingIndex: globalIncomingIdx,
            matchConfidence: 1.0,
            incomingCell: incomingCells[globalIncomingIdx]
        });
    }
    
    // Sort mappings to preserve logical cell order
    return sortMappingsByPosition(mappings);
}

/**
 * Sort cell mappings to preserve logical cell order.
 * Uses anchor position (base > current > incoming) with tiebreakers
 * to maintain original notebook structure.
 */
function sortMappingsByPosition(mappings: CellMapping[]): CellMapping[] {
    return sortByPosition(mappings, (m) => ({
        anchor: m.baseIndex ?? m.currentIndex ?? m.incomingIndex ?? 0,
        base: m.baseIndex,
        current: m.currentIndex,
        incoming: m.incomingIndex
    }));
}

/**
 * Detect if cells have been reordered between versions
 */
export function detectReordering(mappings: CellMapping[]): boolean {
    const validMappings = mappings.filter(m => 
        m.baseIndex !== undefined && 
        m.currentIndex !== undefined && 
        m.incomingIndex !== undefined
    );
    
    if (validMappings.length < 2) return false;
    
    // Check if order is preserved
    for (let i = 1; i < validMappings.length; i++) {
        const prev = validMappings[i - 1];
        const curr = validMappings[i];
        
        const baseOrdered = curr.baseIndex! > prev.baseIndex!;
        const currentOrdered = curr.currentIndex! > prev.currentIndex!;
        const incomingOrdered = curr.incomingIndex! > prev.incomingIndex!;
        
        // If ordering differs between versions, cells were reordered
        if (baseOrdered !== currentOrdered || baseOrdered !== incomingOrdered) {
            return true;
        }
    }
    
    return false;
}
