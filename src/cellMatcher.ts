import { NotebookCell, Notebook, CellMapping } from './types';
import * as crypto from 'crypto';

/**
 * Cell matching algorithm for 3-way merge
 * Matches cells between base, local, and remote versions using content similarity
 */

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
 * Match cells between base and local/remote versions
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
 * Main function: Match cells across all three versions (base, local, remote)
 */
export function matchCells(
    base: Notebook | null | undefined,
    local: Notebook | null | undefined,
    remote: Notebook | null | undefined
): CellMapping[] {
    const mappings: CellMapping[] = [];
    
    // Handle edge cases
    if (!base && !local && !remote) {
        return [];
    }
    
    const baseCells = base?.cells || [];
    const localCells = local?.cells || [];
    const remoteCells = remote?.cells || [];
    
    // If no base, match local to remote directly
    if (baseCells.length === 0) {
        const localHashes = localCells.map(cell => computeCellHash(cell));
        const remoteHashes = remoteCells.map(cell => computeCellHash(cell));
        
        const usedRemoteIndices = new Set<number>();
        
        for (let localIdx = 0; localIdx < localCells.length; localIdx++) {
            const localHash = localHashes[localIdx];
            const remoteIdx = remoteHashes.indexOf(localHash);
            
            if (remoteIdx !== -1 && !usedRemoteIndices.has(remoteIdx)) {
                mappings.push({
                    localIndex: localIdx,
                    remoteIndex: remoteIdx,
                    matchConfidence: 1.0,
                    localCell: localCells[localIdx],
                    remoteCell: remoteCells[remoteIdx]
                });
                usedRemoteIndices.add(remoteIdx);
            } else {
                // Unmatched local cell
                mappings.push({
                    localIndex: localIdx,
                    matchConfidence: 1.0,
                    localCell: localCells[localIdx]
                });
            }
        }
        
        // Unmatched remote cells
        for (let remoteIdx = 0; remoteIdx < remoteCells.length; remoteIdx++) {
            if (!usedRemoteIndices.has(remoteIdx)) {
                mappings.push({
                    remoteIndex: remoteIdx,
                    matchConfidence: 1.0,
                    remoteCell: remoteCells[remoteIdx]
                });
            }
        }
        
        return mappings;
    }
    
    // Match base to local and base to remote
    const baseToLocal = matchCellsToBase(baseCells, localCells);
    const baseToRemote = matchCellsToBase(baseCells, remoteCells);
    
    const usedLocalIndices = new Set<number>();
    const usedRemoteIndices = new Set<number>();
    
    // Create mappings for cells that exist in base
    for (let baseIdx = 0; baseIdx < baseCells.length; baseIdx++) {
        const localIdx = baseToLocal.get(baseIdx);
        const remoteIdx = baseToRemote.get(baseIdx);
        
        const mapping: CellMapping = {
            baseIndex: baseIdx,
            localIndex: localIdx,
            remoteIndex: remoteIdx,
            matchConfidence: 0.9, // High confidence for base-anchored matches
            baseCell: baseCells[baseIdx],
            localCell: localIdx !== undefined ? localCells[localIdx] : undefined,
            remoteCell: remoteIdx !== undefined ? remoteCells[remoteIdx] : undefined
        };
        
        mappings.push(mapping);
        
        if (localIdx !== undefined) usedLocalIndices.add(localIdx);
        if (remoteIdx !== undefined) usedRemoteIndices.add(remoteIdx);
    }
    
    // Handle cells that exist in local but not matched to base
    for (let localIdx = 0; localIdx < localCells.length; localIdx++) {
        if (usedLocalIndices.has(localIdx)) continue;
        
        // Try to match to unmatched remote cells
        let bestRemoteIdx = -1;
        let bestScore = 0.7;
        
        for (let remoteIdx = 0; remoteIdx < remoteCells.length; remoteIdx++) {
            if (usedRemoteIndices.has(remoteIdx)) continue;
            
            const similarity = computeCellSimilarity(localCells[localIdx], remoteCells[remoteIdx]);
            if (similarity > bestScore) {
                bestScore = similarity;
                bestRemoteIdx = remoteIdx;
            }
        }
        
        if (bestRemoteIdx !== -1) {
            mappings.push({
                localIndex: localIdx,
                remoteIndex: bestRemoteIdx,
                matchConfidence: bestScore,
                localCell: localCells[localIdx],
                remoteCell: remoteCells[bestRemoteIdx]
            });
            usedRemoteIndices.add(bestRemoteIdx);
        } else {
            // Local-only cell
            mappings.push({
                localIndex: localIdx,
                matchConfidence: 1.0,
                localCell: localCells[localIdx]
            });
        }
        
        usedLocalIndices.add(localIdx);
    }
    
    // Handle remaining remote-only cells
    for (let remoteIdx = 0; remoteIdx < remoteCells.length; remoteIdx++) {
        if (usedRemoteIndices.has(remoteIdx)) continue;
        
        mappings.push({
            remoteIndex: remoteIdx,
            matchConfidence: 1.0,
            remoteCell: remoteCells[remoteIdx]
        });
    }
    
    return mappings;
}

/**
 * Detect if cells have been reordered between versions
 */
export function detectReordering(mappings: CellMapping[]): boolean {
    const validMappings = mappings.filter(m => 
        m.baseIndex !== undefined && 
        m.localIndex !== undefined && 
        m.remoteIndex !== undefined
    );
    
    if (validMappings.length < 2) return false;
    
    // Check if order is preserved
    for (let i = 1; i < validMappings.length; i++) {
        const prev = validMappings[i - 1];
        const curr = validMappings[i];
        
        const baseOrdered = curr.baseIndex! > prev.baseIndex!;
        const localOrdered = curr.localIndex! > prev.localIndex!;
        const remoteOrdered = curr.remoteIndex! > prev.remoteIndex!;
        
        // If ordering differs between versions, cells were reordered
        if (baseOrdered !== localOrdered || baseOrdered !== remoteOrdered) {
            return true;
        }
    }
    
    return false;
}
