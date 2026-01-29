/**
 * @file cellMatcher.ts
 * @description Cell matching algorithm for three-way notebook merge.
 * 
 * Matches cells across base/current/incoming versions using:
 * - Content hashing for exact matches
 * - Levenshtein distance for similarity scoring
 * - Hungarian algorithm for optimal bipartite matching
 * - Position-based fallback for ambiguous cases
 * 
 * Also detects cell reordering conflicts where the same cells
 * appear in different orders between branches.
 */

import { NotebookCell, Notebook, CellMapping } from './types';
import * as crypto from 'crypto';

/**
 * Compute a hash of cell content for similarity matching
 */
function computeCellHash(cell: NotebookCell): string {
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    const contentToHash = `${cell.cell_type}:${source}`;
    return crypto.createHash('sha256').update(contentToHash).digest('hex');
}

/**
 * Compute similarity score between two cells (0-1)
 */
function computeCellSimilarity(cell1: NotebookCell, cell2: NotebookCell): number {
    // Different cell types = no match
    if (cell1.cell_type !== cell2.cell_type) {
        return 0;
    }

    const source1 = Array.isArray(cell1.source) ? cell1.source.join('') : cell1.source;
    const source2 = Array.isArray(cell2.source) ? cell2.source.join('') : cell2.source;

    // Exact match
    if (source1 === source2) {
        return 1.0;
    }

    // Empty cells
    if (!source1 && !source2) {
        return 1.0;
    }
    if (!source1 || !source2) {
        return 0;
    }

    // Compute Levenshtein-based similarity
    const distance = levenshteinDistance(source1, source2);
    const maxLen = Math.max(source1.length, source2.length);
    
    return 1 - (distance / maxLen);
}

/**
 * Compute Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    
    // Create 2D array
    const dp: number[][] = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
    
    // Initialize base cases
    for (let i = 0; i <= len1; i++) {
        dp[i][0] = i;
    }
    for (let j = 0; j <= len2; j++) {
        dp[0][j] = j;
    }
    
    // Fill the matrix
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,     // deletion
                    dp[i][j - 1] + 1,     // insertion
                    dp[i - 1][j - 1] + 1  // substitution
                );
            }
        }
    }
    
    return dp[len1][len2];
}


/**
 * Match cells between base and current/incoming versions
 */
function matchCellsToBase(
    baseCells: NotebookCell[],
    otherCells: NotebookCell[],
    threshold: number = 0.7
): Map<number, number> {
    const matches = new Map<number, number>(); // baseIndex -> otherIndex
    const usedOtherIndices = new Set<number>();
    
    // Create hash map for exact matches
    const baseHashes = baseCells.map(cell => computeCellHash(cell));
    const otherHashes = otherCells.map(cell => computeCellHash(cell));
    
    // First pass: exact hash matches
    for (let baseIdx = 0; baseIdx < baseCells.length; baseIdx++) {
        const baseHash = baseHashes[baseIdx];
        const otherIdx = otherHashes.indexOf(baseHash);
        
        if (otherIdx !== -1 && !usedOtherIndices.has(otherIdx)) {
            matches.set(baseIdx, otherIdx);
            usedOtherIndices.add(otherIdx);
        }
    }
    
    // Second pass: similarity-based matching for unmatched cells
    for (let baseIdx = 0; baseIdx < baseCells.length; baseIdx++) {
        if (matches.has(baseIdx)) continue;
        
        let bestMatch = -1;
        let bestScore = threshold;
        
        for (let otherIdx = 0; otherIdx < otherCells.length; otherIdx++) {
            if (usedOtherIndices.has(otherIdx)) continue;
            
            const similarity = computeCellSimilarity(baseCells[baseIdx], otherCells[otherIdx]);
            if (similarity > bestScore) {
                bestScore = similarity;
                bestMatch = otherIdx;
            }
        }
        
        if (bestMatch !== -1) {
            matches.set(baseIdx, bestMatch);
            usedOtherIndices.add(bestMatch);
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
    
    // If no base, match current to incoming directly
    if (baseCells.length === 0) {
        const currentHashes = currentCells.map(cell => computeCellHash(cell));
        const incomingHashes = incomingCells.map(cell => computeCellHash(cell));
        
        const usedincomingIndices = new Set<number>();
        
        for (let currentIdx = 0; currentIdx < currentCells.length; currentIdx++) {
            const currentHash = currentHashes[currentIdx];
            const incomingIdx = incomingHashes.indexOf(currentHash);
            
            if (incomingIdx !== -1 && !usedincomingIndices.has(incomingIdx)) {
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
    for (let currentIdx = 0; currentIdx < currentCells.length; currentIdx++) {
        if (usedcurrentIndices.has(currentIdx)) continue;
        
        // Try to match to unmatched incoming cells
        let bestincomingIdx = -1;
        let bestScore = 0.7;
        
        for (let incomingIdx = 0; incomingIdx < incomingCells.length; incomingIdx++) {
            if (usedincomingIndices.has(incomingIdx)) continue;
            
            const similarity = computeCellSimilarity(currentCells[currentIdx], incomingCells[incomingIdx]);
            if (similarity > bestScore) {
                bestScore = similarity;
                bestincomingIdx = incomingIdx;
            }
        }
        
        if (bestincomingIdx !== -1) {
            mappings.push({
                currentIndex: currentIdx,
                incomingIndex: bestincomingIdx,
                matchConfidence: bestScore,
                currentCell: currentCells[currentIdx],
                incomingCell: incomingCells[bestincomingIdx]
            });
            usedincomingIndices.add(bestincomingIdx);
        } else {
            // current-only cell
            mappings.push({
                currentIndex: currentIdx,
                matchConfidence: 1.0,
                currentCell: currentCells[currentIdx]
            });
        }
        
        usedcurrentIndices.add(currentIdx);
    }
    
    // Handle remaining incoming-only cells
    for (let incomingIdx = 0; incomingIdx < incomingCells.length; incomingIdx++) {
        if (usedincomingIndices.has(incomingIdx)) continue;
        
        mappings.push({
            incomingIndex: incomingIdx,
            matchConfidence: 1.0,
            incomingCell: incomingCells[incomingIdx]
        });
    }
    
    // Sort mappings to preserve logical cell order
    // This ensures the resolver and webview see cells in the same order
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
 * Generic comparator that compares two position-like objects.
 * Accepts canonical keys: `anchor`, `incoming`, `current`, `base`.
 */
export function compareByPosition(
    a: { anchor?: number; incoming?: number; current?: number; base?: number },
    b: { anchor?: number; incoming?: number; current?: number; base?: number }
): number {
    const posA = a.anchor ?? 0;
    const posB = b.anchor ?? 0;

    if (posA !== posB) {
        return posA - posB;
    }

    // Tie-breaker: compare indices from all versions to preserve insertion order
    if (a.incoming !== undefined && b.incoming !== undefined) {
        if (a.incoming !== b.incoming) return a.incoming - b.incoming;
    }

    if (a.current !== undefined && b.current !== undefined) {
        if (a.current !== b.current) return a.current - b.current;
    }

    if (a.base !== undefined && b.base !== undefined) {
        if (a.base !== b.base) return a.base - b.base;
    }

    const hasAnyIndexA = (a.incoming ?? a.current ?? a.base) !== undefined;
    const hasAnyIndexB = (b.incoming ?? b.current ?? b.base) !== undefined;

    if (hasAnyIndexA && !hasAnyIndexB) return -1;
    if (!hasAnyIndexA && hasAnyIndexB) return 1;

    return 0;
}

/**
 * Sort a list of items using a position accessor that maps each item
 * to the canonical position fields consumed by `compareByPosition`.
 */
export function sortByPosition<T>(
    items: T[],
    accessor: (item: T) => { anchor?: number; incoming?: number; current?: number; base?: number }
): T[] {
    return [...items].sort((x, y) => compareByPosition(accessor(x), accessor(y)));
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
