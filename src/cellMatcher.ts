/**
 * @file cellMatcher.ts
 * @description Cell matching algorithm for three-way notebook merge.
 * 
 * Matches cells across base/current/incoming versions using:
 * - Content hashing for exact matches
 * - nbdime-style "snaking" algorithm for optimal sequence alignment
 * - Multilevel comparison predicates (strict to loose)
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

/**
 * Get normalized source from a cell
 */
function getCellSource(cell: NotebookCell): string {
    return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

/**
 * Compute similarity score between two cells (0-1) using line-based comparison.
 * This is more efficient than character-level Levenshtein for notebook cells.
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

    // Use line-based LCS for similarity (faster than char-level Levenshtein)
    const lines1 = source1.split('\n');
    const lines2 = source2.split('\n');
    const lcsLength = computeLCSLength(lines1, lines2);
    const maxLines = Math.max(lines1.length, lines2.length);
    
    return lcsLength / maxLines;
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
 * Compute the length of LCS for two arrays (simple version for similarity)
 */
function computeLCSLength<T>(arr1: T[], arr2: T[]): number {
    const m = arr1.length;
    const n = arr2.length;
    
    // Use space-optimized version (only need 2 rows)
    let prev = Array(n + 1).fill(0);
    let curr = Array(n + 1).fill(0);
    
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (arr1[i - 1] === arr2[j - 1]) {
                curr[j] = prev[j - 1] + 1;
            } else {
                curr[j] = Math.max(prev[j], curr[j - 1]);
            }
        }
        [prev, curr] = [curr, prev];
    }
    
    return prev[n];
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
    if (newSnakes[0].n === 0) {
        newSnakes.shift();
    }
    
    return newSnakes;
}

// ============================================================================
// Comparison predicates for multilevel matching
// ============================================================================

/**
 * Exact match: cells have identical type and source
 */
function cellsExactMatch(a: NotebookCell, b: NotebookCell): boolean {
    if (a.cell_type !== b.cell_type) return false;
    const sourceA = getCellSource(a);
    const sourceB = getCellSource(b);
    return sourceA === sourceB;
}

/**
 * Similar match: cells have same type and >=50% line similarity
 */
function cellsSimilarMatch(a: NotebookCell, b: NotebookCell): boolean {
    if (a.cell_type !== b.cell_type) return false;
    const similarity = computeCellSimilarity(a, b);
    return similarity >= 0.5;
}

/**
 * Weak match: cells have same type and >=30% line similarity
 */
function cellsWeakMatch(a: NotebookCell, b: NotebookCell): boolean {
    if (a.cell_type !== b.cell_type) return false;
    const similarity = computeCellSimilarity(a, b);
    return similarity >= 0.3;
}


/**
 * Match cells between base and current/incoming versions using snaking algorithm.
 * 
 * Uses nbdime-style multilevel comparison:
 * - Level 2 (strictest): Exact content match
 * - Level 1: Similar content (>=50% line similarity)
 * - Level 0 (loosest): Weak match (>=30% line similarity)
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
    // Ordered from loosest (0) to strictest (N-1)
    const compares: CellCompare[] = [
        cellsWeakMatch,    // Level 0: >=30% similar
        cellsSimilarMatch, // Level 1: >=50% similar
        cellsExactMatch,   // Level 2: exact match
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
