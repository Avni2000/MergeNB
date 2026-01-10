/**
 * @file conflictDetector.ts
 * @description Conflict detection and analysis engine for MergeNB.
 * 
 * Handles two types of conflicts:
 * 
 * 1. TEXTUAL CONFLICTS - Git inserted <<<<<<</=======/>>>>>>> markers
 *    - Raw markers: Break JSON parsing, require raw text analysis
 *    - HTML-styled markers: Valid JSON with markers in cell content
 *    - Cell-level markers: Entire cells marked as local/remote
 *    - Inline markers: Conflict markers within a single cell's source
 * 
 * 2. SEMANTIC CONFLICTS - Git UU status without textual markers
 *    - Cell added/deleted/modified in both branches
 *    - Cell reordering conflicts
 *    - Output and execution count differences
 *    - Metadata changes
 * 
 * Also provides auto-resolution for trivial conflicts (execution counts,
 * outputs, kernel versions) based on user settings.
 */

import { CellConflict, NotebookConflict, NotebookSemanticConflict, SemanticConflict, CellMapping } from './types';
import { Notebook, NotebookCell, NotebookMetadata } from './types';
import * as gitIntegration from './gitIntegration';
import { matchCells, detectReordering } from './cellMatcher';
import { parseNotebook } from './notebookParser';
import { getSettings, MergeNBSettings } from './settings';

/**
 * Result of auto-resolution preprocessing
 */
export interface AutoResolveResult {
    /** Filtered conflicts that still need manual resolution */
    remainingConflicts: SemanticConflict[];
    /** Number of conflicts auto-resolved */
    autoResolvedCount: number;
    /** Description of what was auto-resolved */
    autoResolvedDescriptions: string[];
    /** The notebook with auto-resolutions applied */
    resolvedNotebook: Notebook;
    /** Whether kernel metadata was auto-resolved */
    kernelAutoResolved: boolean;
}

/**
 * Pattern for raw Git conflict markers (breaks JSON)
 */
const RAW_CONFLICT_START = /<{7}/;
const RAW_CONFLICT_SEP = /={7}/;
const RAW_CONFLICT_END = />{7}/;

/**
 * Pattern for HTML-styled conflict markers (valid JSON, markers in cell content)
 * Matches patterns like: <span style="color:red"><b><<<<<<< local</b></span>
 */
const HTML_CONFLICT_START_PATTERN = /<[^>]*>[^<]*<{7}[^<]*<\/[^>]*>/i;
const HTML_CONFLICT_SEP_PATTERN = /<[^>]*>[^<]*={7}[^<]*<\/[^>]*>/i;
const HTML_CONFLICT_END_PATTERN = /<[^>]*>[^<]*>{7}[^<]*<\/[^>]*>/i;

/**
 * Check if a cell's source contains an HTML-styled conflict marker
 */
function isCellConflictMarker(cell: NotebookCell, type: 'start' | 'separator' | 'end'): boolean {
    const source = sourceToString(cell.source);
    switch (type) {
        case 'start':
            return HTML_CONFLICT_START_PATTERN.test(source);
        case 'separator':
            return HTML_CONFLICT_SEP_PATTERN.test(source);
        case 'end':
            return HTML_CONFLICT_END_PATTERN.test(source);
    }
}

/**
 * Extract branch name from HTML-styled conflict marker cell
 */
function extractBranchFromMarkerCell(cell: NotebookCell, type: 'start' | 'end'): string | undefined {
    const source = sourceToString(cell.source);
    if (type === 'start') {
        const match = source.match(/<{7}\s*([^<\s]*)/);
        return match?.[1] || undefined;
    } else {
        const match = source.match(/>{7}\s*([^<\s]*)/);
        return match?.[1] || undefined;
    }
}

/**
 * Check if content contains Git merge conflict markers.
 * Supports both raw markers and HTML-styled markers in notebook cells.
 */
export function hasConflictMarkers(content: string): boolean {
    // Check for raw conflict markers (traditional git conflicts)
    const hasRawMarkers = RAW_CONFLICT_START.test(content) && 
                          RAW_CONFLICT_SEP.test(content) && 
                          RAW_CONFLICT_END.test(content);
    if (hasRawMarkers) {
        return true;
    }
    
    // Check for HTML-styled conflict markers (notebook-specific)
    const hasHtmlMarkers = HTML_CONFLICT_START_PATTERN.test(content) && 
                           HTML_CONFLICT_SEP_PATTERN.test(content) && 
                           HTML_CONFLICT_END_PATTERN.test(content);
    return hasHtmlMarkers;
}

/**
 * Represents a conflict found within a string value
 */
interface StringConflict {
    localContent: string;
    remoteContent: string;
    localBranch?: string;
    remoteBranch?: string;
}

/**
 * Extract conflicts from a string that contains conflict markers.
 * Returns null if no conflict markers found.
 */
function extractConflictFromString(str: string): StringConflict | null {
    const startMatch = str.match(/<<<<<<< ?([^\n]*)\n/);
    if (!startMatch) return null;
    
    const startIdx = str.indexOf('<<<<<<<');
    const middleIdx = str.indexOf('=======');
    const endMatch = str.match(/>>>>>>> ?([^\n]*)/);
    
    if (middleIdx === -1 || !endMatch) return null;
    
    const endIdx = str.indexOf('>>>>>>>');
    
    // Extract local content (between <<<<<<< and =======)
    const afterStart = startIdx + startMatch[0].length;
    const localContent = str.substring(afterStart, middleIdx);
    
    // Extract remote content (between ======= and >>>>>>>)
    const afterMiddle = middleIdx + 8; // length of "=======\n"
    const remoteContent = str.substring(afterMiddle, endIdx);
    
    return {
        localContent: localContent.replace(/\n$/, ''),
        remoteContent: remoteContent.replace(/\n$/, ''),
        localBranch: startMatch[1] || undefined,
        remoteBranch: endMatch[1] || undefined
    };
}

/**
 * Resolve a conflict in a string by choosing local or remote content.
 * Recursively resolves all conflicts in the string.
 */
function resolveStringConflict(str: string, choice: 'local' | 'remote' | 'both'): string {
    const conflict = extractConflictFromString(str);
    if (!conflict) return str;
    
    const startIdx = str.indexOf('<<<<<<<');
    const endMatch = str.match(/>>>>>>> ?[^\n]*/);
    if (!endMatch) return str;
    
    const endIdx = str.indexOf('>>>>>>>') + endMatch[0].length;
    // Also remove trailing newline if present
    const finalEndIdx = str[endIdx] === '\n' ? endIdx + 1 : endIdx;
    
    const before = str.substring(0, startIdx);
    const after = str.substring(finalEndIdx);
    
    let replacement: string;
    switch (choice) {
        case 'local':
            replacement = conflict.localContent;
            break;
        case 'remote':
            replacement = conflict.remoteContent;
            break;
        case 'both':
            replacement = conflict.localContent + '\n' + conflict.remoteContent;
            break;
    }
    
    const result = before + replacement + after;
    
    // Recursively resolve any remaining conflicts
    if (result.includes('<<<<<<<') && result.includes('=======') && result.includes('>>>>>>>')) {
        return resolveStringConflict(result, choice);
    }
    
    return result;
}

/**
 * Normalize cell source to string (can be string or string[])
 */
function sourceToString(source: string | string[]): string {
    return Array.isArray(source) ? source.join('') : source;
}

/**
 * Convert string back to source array format
 */
function stringToSource(str: string): string[] {
    if (!str) return [];
    const lines = str.split('\n');
    return lines.map((line, i) => i < lines.length - 1 ? line + '\n' : line);
}

/**
 * Check if a cell has conflicts in its source (inline within cell content)
 */
function cellSourceHasInlineConflict(cell: NotebookCell): boolean {
    const source = sourceToString(cell.source);
    // Check for raw markers within cell content
    return source.includes('<<<<<<<') && source.includes('=======') && source.includes('>>>>>>>');
}

/**
 * Check if a cell has conflicts in its outputs
 */
function cellOutputsHaveConflict(cell: NotebookCell): boolean {
    if (!cell.outputs) return false;
    return cell.outputs.some(output => {
        if (output.text) {
            const text = Array.isArray(output.text) ? output.text.join('') : output.text;
            return hasConflictMarkers(text);
        }
        return false;
    });
}

/**
 * Represents a cell-level conflict region in the notebook.
 * Cells between a <<<<<<< marker cell and >>>>>>> marker cell are in conflict.
 */
interface CellLevelConflict {
    startMarkerCellIndex: number;
    separatorCellIndex: number;
    endMarkerCellIndex: number;
    localCellIndices: number[];
    remoteCellIndices: number[];
    localBranch?: string;
    remoteBranch?: string;
}

/**
 * Find cell-level conflicts where entire cells are marked as local/remote.
 * This handles the case where conflict markers are in separate cells.
 */
function findCellLevelConflicts(notebook: Notebook): CellLevelConflict[] {
    const conflicts: CellLevelConflict[] = [];
    
    let i = 0;
    while (i < notebook.cells.length) {
        const cell = notebook.cells[i];
        
        if (isCellConflictMarker(cell, 'start')) {
            // Found start of conflict region
            const startIdx = i;
            const localBranch = extractBranchFromMarkerCell(cell, 'start');
            
            // Find separator
            let sepIdx = -1;
            for (let j = i + 1; j < notebook.cells.length; j++) {
                if (isCellConflictMarker(notebook.cells[j], 'separator')) {
                    sepIdx = j;
                    break;
                }
            }
            
            if (sepIdx === -1) {
                i++;
                continue;
            }
            
            // Find end marker
            let endIdx = -1;
            for (let j = sepIdx + 1; j < notebook.cells.length; j++) {
                if (isCellConflictMarker(notebook.cells[j], 'end')) {
                    endIdx = j;
                    break;
                }
            }
            
            if (endIdx === -1) {
                i++;
                continue;
            }
            
            const remoteBranch = extractBranchFromMarkerCell(notebook.cells[endIdx], 'end');
            
            // Cells between start+1 and sep-1 are local
            const localCellIndices: number[] = [];
            for (let j = startIdx + 1; j < sepIdx; j++) {
                localCellIndices.push(j);
            }
            
            // Cells between sep+1 and end-1 are remote
            const remoteCellIndices: number[] = [];
            for (let j = sepIdx + 1; j < endIdx; j++) {
                remoteCellIndices.push(j);
            }
            
            conflicts.push({
                startMarkerCellIndex: startIdx,
                separatorCellIndex: sepIdx,
                endMarkerCellIndex: endIdx,
                localCellIndices,
                remoteCellIndices,
                localBranch,
                remoteBranch
            });
            
            i = endIdx + 1;
        } else {
            i++;
        }
    }
    
    return conflicts;
}

/**
 * Get display content for a single cell
 */
function cellToDisplayContent(cell: NotebookCell): string {
    return sourceToString(cell.source);
}

/**
 * Analyze a notebook and find all conflicts.
 */
export function analyzeNotebookConflicts(filePath: string, content: string): NotebookConflict {
    const conflicts: CellConflict[] = [];
    
    let notebook: Notebook;
    try {
        notebook = JSON.parse(content);
    } catch {
        // If JSON is invalid, the conflict markers broke the structure
        // Fall back to raw text analysis
        return analyzeRawConflicts(filePath, content);
    }
    
    // First, check for cell-level conflicts (HTML-styled markers in separate cells)
    const cellLevelConflicts = findCellLevelConflicts(notebook);
    
    for (const cellConflict of cellLevelConflicts) {
        // Create individual conflict entries for each cell pair
        // Match cells by position: local[0] vs remote[0], local[1] vs remote[1], etc.
        const maxCells = Math.max(
            cellConflict.localCellIndices.length,
            cellConflict.remoteCellIndices.length
        );
        
        for (let i = 0; i < maxCells; i++) {
            const localIdx = cellConflict.localCellIndices[i];
            const remoteIdx = cellConflict.remoteCellIndices[i];
            
            const localCell = localIdx !== undefined ? notebook.cells[localIdx] : undefined;
            const remoteCell = remoteIdx !== undefined ? notebook.cells[remoteIdx] : undefined;
            
            const localContent = localCell ? cellToDisplayContent(localCell) : '';
            const remoteContent = remoteCell ? cellToDisplayContent(remoteCell) : '';
            
            // Determine cell type for display
            const cellType = localCell?.cell_type || remoteCell?.cell_type || 'code';
            
            conflicts.push({
                cellIndex: localIdx ?? remoteIdx ?? cellConflict.startMarkerCellIndex,
                field: 'source',
                localContent,
                remoteContent,
                marker: {
                    start: cellConflict.startMarkerCellIndex,
                    middle: cellConflict.separatorCellIndex,
                    end: cellConflict.endMarkerCellIndex,
                    localBranch: cellConflict.localBranch,
                    remoteBranch: cellConflict.remoteBranch
                },
                // Store cell type info for UI display
                cellType: cellType as 'code' | 'markdown' | 'raw',
                localCellIndex: localIdx,
                remoteCellIndex: remoteIdx
            });
        }
    }
    
    // Then check for inline conflicts within individual cells
    notebook.cells.forEach((cell, cellIndex) => {
        // Skip cells that are part of cell-level conflict markers
        const isMarkerCell = cellLevelConflicts.some(c => 
            cellIndex === c.startMarkerCellIndex ||
            cellIndex === c.separatorCellIndex ||
            cellIndex === c.endMarkerCellIndex
        );
        const isInConflictRegion = cellLevelConflicts.some(c =>
            c.localCellIndices.includes(cellIndex) ||
            c.remoteCellIndices.includes(cellIndex)
        );
        
        if (isMarkerCell || isInConflictRegion) {
            return; // Skip - already handled as cell-level conflict
        }
        
        // Check source for inline conflicts
        if (cellSourceHasInlineConflict(cell)) {
            const source = sourceToString(cell.source);
            const extracted = extractConflictFromString(source);
            if (extracted) {
                conflicts.push({
                    cellIndex,
                    field: 'source',
                    localContent: extracted.localContent,
                    remoteContent: extracted.remoteContent,
                    marker: { 
                        start: 0, middle: 0, end: 0,
                        localBranch: extracted.localBranch,
                        remoteBranch: extracted.remoteBranch
                    }
                });
            }
        }
        
        // Check outputs
        if (cellOutputsHaveConflict(cell)) {
            const outputText = cell.outputs!
                .map(o => o.text ? (Array.isArray(o.text) ? o.text.join('') : o.text) : '')
                .join('');
            const extracted = extractConflictFromString(outputText);
            if (extracted) {
                conflicts.push({
                    cellIndex,
                    field: 'outputs',
                    localContent: extracted.localContent,
                    remoteContent: extracted.remoteContent,
                    marker: {
                        start: 0, middle: 0, end: 0,
                        localBranch: extracted.localBranch,
                        remoteBranch: extracted.remoteBranch
                    }
                });
            }
        }
    });
    
    return {
        filePath,
        rawContent: content,
        conflicts,
        metadataConflicts: []
    };
}

/**
 * Fallback: analyze raw text when JSON is broken by conflict markers
 */
function analyzeRawConflicts(filePath: string, content: string): NotebookConflict {
    const conflicts: CellConflict[] = [];
    
    if (hasConflictMarkers(content)) {
        const extracted = extractConflictFromString(content);
        if (extracted) {
            conflicts.push({
                cellIndex: -1,
                field: 'source',
                localContent: extracted.localContent,
                remoteContent: extracted.remoteContent,
                marker: { start: 0, middle: 0, end: 0 }
            });
        }
    }
    
    return {
        filePath,
        rawContent: content,
        conflicts,
        metadataConflicts: []
    };
}

/**
 * Resolve all conflicts in a notebook.
 */
export function resolveAllConflicts(
    content: string,
    resolutions: Array<{ marker: { start: number; middle?: number; end?: number }; choice: 'local' | 'remote' | 'both'; customContent?: string }>
): string {
    let notebook: Notebook;
    try {
        notebook = JSON.parse(content);
    } catch {
        // JSON is broken, do raw text replacement
        let result = content;
        for (const res of resolutions) {
            result = resolveStringConflict(result, res.choice);
        }
        return result;
    }
    
    // Find cell-level conflicts first
    const cellLevelConflicts = findCellLevelConflicts(notebook);
    
    // Process resolutions
    const analysisResult = analyzeNotebookConflicts('', content);
    const conflicts = analysisResult.conflicts;
    
    // Build a set of cell indices to remove (marker cells and rejected cells)
    const cellsToRemove = new Set<number>();
    
    // Default resolution choice for all conflicts (use first resolution's choice or 'local')
    const defaultChoice = resolutions[0]?.choice || 'local';
    
    // Process each resolution
    conflicts.forEach((conflict, i) => {
        const resolution = resolutions[i];
        if (!resolution) return;
        
        const choice = resolution.choice;
        
        // Check if this is a cell-level conflict (marker indices will be > 0)
        const isCellLevelConflict = conflict.marker.start > 0 || 
            (conflict.marker.middle !== undefined && conflict.marker.middle > 0);
        
        if (isCellLevelConflict) {
            // Find the matching cell-level conflict
            const cellConflict = cellLevelConflicts.find(c => 
                c.startMarkerCellIndex === conflict.marker.start
            );
            
            if (cellConflict) {
                // Always remove marker cells
                cellsToRemove.add(cellConflict.startMarkerCellIndex);
                cellsToRemove.add(cellConflict.separatorCellIndex);
                cellsToRemove.add(cellConflict.endMarkerCellIndex);
                
                // Remove cells based on choice
                if (choice === 'local') {
                    // Keep local cells, remove remote cells
                    cellConflict.remoteCellIndices.forEach(idx => cellsToRemove.add(idx));
                } else if (choice === 'remote') {
                    // Keep remote cells, remove local cells
                    cellConflict.localCellIndices.forEach(idx => cellsToRemove.add(idx));
                }
                // 'both' keeps all content cells, just removes markers
            }
        } else {
            // Inline conflict within a cell
            const cellIndex = conflict.cellIndex;
            if (cellIndex >= 0 && cellIndex < notebook.cells.length) {
                const cell = notebook.cells[cellIndex];
                const source = sourceToString(cell.source);
                
                if (source.includes('<<<<<<<') && source.includes('=======') && source.includes('>>>>>>>')) {
                    const resolved = resolveStringConflict(source, choice);
                    notebook.cells[cellIndex] = {
                        ...cell,
                        source: stringToSource(resolved)
                    };
                }
            }
        }
    });
    
    // Also process any cells with output conflicts - clear their outputs
    notebook.cells = notebook.cells.map(cell => {
        if (cell.outputs && cell.outputs.length > 0) {
            const hasOutputConflict = cell.outputs.some(output => {
                if (output.text) {
                    const text = Array.isArray(output.text) ? output.text.join('') : output.text;
                    return text.includes('<<<<<<<') || text.includes('=======') || text.includes('>>>>>>>');
                }
                return false;
            });
            
            if (hasOutputConflict) {
                // Clear outputs that have conflict markers
                return { ...cell, outputs: [] };
            }
        }
        return cell;
    });
    
    // Filter out cells that should be removed
    notebook.cells = notebook.cells.filter((_, idx) => !cellsToRemove.has(idx));
    
    return JSON.stringify(notebook, null, 1);
}

// Legacy exports for compatibility
export function findConflictMarkers(_content: string) {
    return [];
}

export function extractConflictContent(_content: string, _marker: { start: number; middle: number; end: number }) {
    return { local: '', remote: '' };
}

/**
 * Enrich textual conflicts with base/local/remote versions from Git staging areas.
 * This allows showing non-conflicted cells alongside conflicted ones in the UI.
 */
export async function enrichTextualConflictsWithContext(
    conflict: NotebookConflict
): Promise<NotebookConflict> {
    try {
        // Get the three-way versions from Git staging areas
        const versions = await gitIntegration.getThreeWayVersions(conflict.filePath);
        if (!versions) {
            console.log('[MergeNB] Could not get Git versions for textual conflict');
            return conflict; // Return original conflict without enrichment
        }

        const { base, local, remote } = versions;
        console.log('[MergeNB] Got Git versions for textual conflict:');
        console.log('[MergeNB] - base:', base ? `${base.length} chars` : 'null');
        console.log('[MergeNB] - local:', local ? `${local.length} chars` : 'null');
        console.log('[MergeNB] - remote:', remote ? `${remote.length} chars` : 'null');

        // Parse each version as a notebook
        let baseNotebook: Notebook | undefined;
        let localNotebook: Notebook | undefined;
        let remoteNotebook: Notebook | undefined;

        try {
            if (base) baseNotebook = parseNotebook(base);
        } catch (error) {
            console.warn('[MergeNB] Failed to parse base notebook:', error);
        }

        try {
            if (local) localNotebook = parseNotebook(local);
        } catch (error) {
            console.warn('[MergeNB] Failed to parse local notebook:', error);
        }

        try {
            if (remote) remoteNotebook = parseNotebook(remote);
        } catch (error) {
            console.warn('[MergeNB] Failed to parse remote notebook:', error);
        }

        // If we couldn't parse at least local and remote, return original
        if (!localNotebook && !remoteNotebook) {
            console.log('[MergeNB] Could not parse local or remote notebooks');
            return conflict;
        }

        // Match cells across versions
        const cellMappings = matchCells(baseNotebook, localNotebook, remoteNotebook);

        // Get branch information
        const [localBranch, remoteBranch] = await Promise.all([
            gitIntegration.getCurrentBranch(conflict.filePath),
            gitIntegration.getMergeBranch(conflict.filePath)
        ]);

        console.log('[MergeNB] Enriched textual conflict with context:');
        console.log('[MergeNB] - cellMappings:', cellMappings.length);
        console.log('[MergeNB] - localBranch:', localBranch);
        console.log('[MergeNB] - remoteBranch:', remoteBranch);

        return {
            ...conflict,
            base: baseNotebook,
            local: localNotebook,
            remote: remoteNotebook,
            cellMappings,
            localBranch: localBranch || undefined,
            remoteBranch: remoteBranch || undefined
        };
    } catch (error) {
        console.error('[MergeNB] Error enriching textual conflict:', error);
        return conflict;
    }
}

/**
 * Detect semantic conflicts (Git UU status without textual markers)
 * Compares base/local/remote versions from Git staging areas
 */
export async function detectSemanticConflicts(filePath: string): Promise<NotebookSemanticConflict | null> {
    try {
        // Get the three-way versions from Git
        const versions = await gitIntegration.getThreeWayVersions(filePath);
        if (!versions) {
            return null; // Not an unmerged file
        }

        const { base, local, remote } = versions;

        // Debug: Check if we're getting different versions
        console.log('[MergeNB] detectSemanticConflicts for:', filePath);
        console.log('[MergeNB] base length:', base?.length ?? 0);
        console.log('[MergeNB] local length:', local?.length ?? 0);
        console.log('[MergeNB] remote length:', remote?.length ?? 0);
        console.log('[MergeNB] base === local:', base === local);
        console.log('[MergeNB] base === remote:', base === remote);
        console.log('[MergeNB] local === remote:', local === remote);

        // Parse each version as a notebook
        let baseNotebook: Notebook | undefined;
        let localNotebook: Notebook | undefined;
        let remoteNotebook: Notebook | undefined;

        try {
            if (base) baseNotebook = parseNotebook(base);
        } catch (error) {
            console.warn('Failed to parse base notebook:', error);
        }

        try {
            if (local) localNotebook = parseNotebook(local);
        } catch (error) {
            console.warn('Failed to parse local notebook:', error);
        }

        try {
            if (remote) remoteNotebook = parseNotebook(remote);
        } catch (error) {
            console.warn('Failed to parse remote notebook:', error);
        }

        // Debug: Check parsed notebooks
        if (baseNotebook && localNotebook && remoteNotebook) {
            const baseLegoCell = baseNotebook.cells.find(c => {
                const src = Array.isArray(c.source) ? c.source.join('') : c.source;
                return src.includes('2.3 The Lego Analogy');
            });
            const localLegoCell = localNotebook.cells.find(c => {
                const src = Array.isArray(c.source) ? c.source.join('') : c.source;
                return src.includes('2.3 The Lego Analogy');
            });
            const remoteLegoCell = remoteNotebook.cells.find(c => {
                const src = Array.isArray(c.source) ? c.source.join('') : c.source;
                return src.includes('2.3 The Lego Analogy');
            });
            
            if (baseLegoCell) {
                const baseSrc = Array.isArray(baseLegoCell.source) ? baseLegoCell.source.join('') : baseLegoCell.source;
                const localSrc = localLegoCell ? (Array.isArray(localLegoCell.source) ? localLegoCell.source.join('') : localLegoCell.source) : '';
                const remoteSrc = remoteLegoCell ? (Array.isArray(remoteLegoCell.source) ? remoteLegoCell.source.join('') : remoteLegoCell.source) : '';
                
                console.log('[MergeNB] LEGO CELL PARSED:');
                console.log('[MergeNB] - base has "Key insight":', baseSrc.includes('Key insight'));
                console.log('[MergeNB] - local has "Key insight":', localSrc.includes('Key insight'));
                console.log('[MergeNB] - remote has "Key insight":', remoteSrc.includes('Key insight'));
            }
        }

        // If we couldn't parse at least local and remote, can't detect semantic conflicts
        if (!localNotebook && !remoteNotebook) {
            return null;
        }

        // Check if current working version has textual conflict markers
        const fs = await import('fs');
        let hasTextualConflicts = false;
        try {
            const workingContent = fs.readFileSync(filePath, 'utf8');
            hasTextualConflicts = hasConflictMarkers(workingContent);
        } catch (error) {
            // File might not exist yet or be inaccessible
            hasTextualConflicts = false;
        }

        // Match cells across versions
        const cellMappings = matchCells(baseNotebook, localNotebook, remoteNotebook);

        // Analyze mappings to find semantic conflicts
        const semanticConflicts = analyzeSemanticConflicts(cellMappings);

        // Get branch information
        const [localBranch, remoteBranch] = await Promise.all([
            gitIntegration.getCurrentBranch(filePath),
            gitIntegration.getMergeBranch(filePath)
        ]);

        return {
            filePath,
            hasTextualConflicts,
            semanticConflicts,
            cellMappings,
            base: baseNotebook,
            local: localNotebook,
            remote: remoteNotebook,
            localBranch: localBranch || undefined,
            remoteBranch: remoteBranch || undefined
        };
    } catch (error) {
        console.error('Error detecting semantic conflicts:', error);
        return null;
    }
}

/**
 * Analyze cell mappings to identify semantic conflicts
 */
function analyzeSemanticConflicts(mappings: CellMapping[]): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Check for cell reordering
    if (detectReordering(mappings)) {
        conflicts.push({
            type: 'cell-reordered',
            description: 'Cells have been reordered between versions'
        });
    }

    for (const mapping of mappings) {
        const { baseIndex, localIndex, remoteIndex, baseCell, localCell, remoteCell } = mapping;

        // Case 1: Cell added in local only
        if (localCell && !baseCell && !remoteCell) {
            conflicts.push({
                type: 'cell-added',
                localCellIndex: localIndex,
                localContent: localCell,
                description: 'Cell added in local branch'
            });
            continue;
        }

        // Case 2: Cell added in remote only
        if (remoteCell && !baseCell && !localCell) {
            conflicts.push({
                type: 'cell-added',
                remoteCellIndex: remoteIndex,
                remoteContent: remoteCell,
                description: 'Cell added in remote branch'
            });
            continue;
        }

        // Case 3: Cell added in both (conflict!)
        if (localCell && remoteCell && !baseCell) {
            const localSource = Array.isArray(localCell.source) ? localCell.source.join('') : localCell.source;
            const remoteSource = Array.isArray(remoteCell.source) ? remoteCell.source.join('') : remoteCell.source;

            if (localSource !== remoteSource) {
                conflicts.push({
                    type: 'cell-added',
                    localCellIndex: localIndex,
                    remoteCellIndex: remoteIndex,
                    localContent: localCell,
                    remoteContent: remoteCell,
                    description: 'Different cells added in same position'
                });
            }
            continue;
        }

        // Case 4: Cell deleted in local
        if (baseCell && !localCell && remoteCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                remoteCellIndex: remoteIndex,
                baseContent: baseCell,
                remoteContent: remoteCell,
                description: 'Cell deleted in local branch'
            });
            continue;
        }

        // Case 5: Cell deleted in remote
        if (baseCell && localCell && !remoteCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                localCellIndex: localIndex,
                baseContent: baseCell,
                localContent: localCell,
                description: 'Cell deleted in remote branch'
            });
            continue;
        }

        // Case 6: Cell deleted in both (no conflict, just deleted)
        if (baseCell && !localCell && !remoteCell) {
            // Not a conflict, skip
            continue;
        }

        // Case 7: Cell exists in all three - check for modifications
        if (baseCell && localCell && remoteCell) {
            const conflicts_found = compareCells(baseCell, localCell, remoteCell, baseIndex, localIndex, remoteIndex);
            conflicts.push(...conflicts_found);
        }
    }

    return conflicts;
}

/**
 * Compare a cell across three versions to find specific conflicts
 */
function compareCells(
    baseCell: NotebookCell,
    localCell: NotebookCell,
    remoteCell: NotebookCell,
    baseIndex?: number,
    localIndex?: number,
    remoteIndex?: number
): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Compare source content
    const baseSource = Array.isArray(baseCell.source) ? baseCell.source.join('') : baseCell.source;
    const localSource = Array.isArray(localCell.source) ? localCell.source.join('') : localCell.source;
    const remoteSource = Array.isArray(remoteCell.source) ? remoteCell.source.join('') : remoteCell.source;

    const localModified = localSource !== baseSource;
    const remoteModified = remoteSource !== baseSource;

    // Both modified the source differently
    if (localModified && remoteModified && localSource !== remoteSource) {
        conflicts.push({
            type: 'cell-modified',
            baseCellIndex: baseIndex,
            localCellIndex: localIndex,
            remoteCellIndex: remoteIndex,
            baseContent: baseCell,
            localContent: localCell,
            remoteContent: remoteCell,
            description: 'Cell source modified in both branches differently'
        });
    }

    // Compare execution_count (only for code cells)
    if (baseCell.cell_type === 'code' && localCell.cell_type === 'code' && remoteCell.cell_type === 'code') {
        const baseExecCount = baseCell.execution_count;
        const localExecCount = localCell.execution_count;
        const remoteExecCount = remoteCell.execution_count;

        if (localExecCount !== remoteExecCount && 
            (localExecCount !== baseExecCount || remoteExecCount !== baseExecCount)) {
            conflicts.push({
                type: 'execution-count-changed',
                baseCellIndex: baseIndex,
                localCellIndex: localIndex,
                remoteCellIndex: remoteIndex,
                baseContent: baseCell,
                localContent: localCell,
                remoteContent: remoteCell,
                description: `Execution count differs: local=${localExecCount}, remote=${remoteExecCount}`
            });
        }

        // Compare outputs
        const baseOutputs = JSON.stringify(baseCell.outputs || []);
        const localOutputs = JSON.stringify(localCell.outputs || []);
        const remoteOutputs = JSON.stringify(remoteCell.outputs || []);

        if (localOutputs !== remoteOutputs && 
            (localOutputs !== baseOutputs || remoteOutputs !== baseOutputs)) {
            conflicts.push({
                type: 'outputs-changed',
                baseCellIndex: baseIndex,
                localCellIndex: localIndex,
                remoteCellIndex: remoteIndex,
                baseContent: baseCell,
                localContent: localCell,
                remoteContent: remoteCell,
                description: 'Cell outputs differ between branches'
            });
        }
    }

    // Compare metadata
    const baseMetadata = JSON.stringify(baseCell.metadata);
    const localMetadata = JSON.stringify(localCell.metadata);
    const remoteMetadata = JSON.stringify(remoteCell.metadata);

    const localMetadataModified = localMetadata !== baseMetadata;
    const remoteMetadataModified = remoteMetadata !== baseMetadata;

    if (localMetadataModified && remoteMetadataModified && localMetadata !== remoteMetadata) {
        conflicts.push({
            type: 'metadata-changed',
            baseCellIndex: baseIndex,
            localCellIndex: localIndex,
            remoteCellIndex: remoteIndex,
            baseContent: baseCell,
            localContent: localCell,
            remoteContent: remoteCell,
            description: 'Cell metadata modified in both branches differently'
        });
    }

    return conflicts;
}

/**
 * Apply auto-resolutions to semantic conflicts based on user settings.
 * Returns filtered conflicts that still need manual resolution.
 */
export function applyAutoResolutions(
    semanticConflict: NotebookSemanticConflict,
    settings?: MergeNBSettings
): AutoResolveResult {
    const effectiveSettings = settings || getSettings();
    const remainingConflicts: SemanticConflict[] = [];
    const autoResolvedDescriptions: string[] = [];
    let autoResolvedCount = 0;
    let kernelAutoResolved = false;

    // Start with a deep copy of the local notebook as our resolved version
    const resolvedNotebook: Notebook = semanticConflict.local 
        ? JSON.parse(JSON.stringify(semanticConflict.local))
        : JSON.parse(JSON.stringify(semanticConflict.remote!));

    // Track cell indices that had auto-resolutions applied
    const autoResolvedCellIndices = new Set<number>();

    for (const conflict of semanticConflict.semanticConflicts) {
        let autoResolved = false;

        // Auto-resolve execution count differences
        if (conflict.type === 'execution-count-changed' && effectiveSettings.autoResolveExecutionCount) {
            // Set execution_count to null on the resolved cell
            if (conflict.localCellIndex !== undefined && resolvedNotebook.cells[conflict.localCellIndex]) {
                resolvedNotebook.cells[conflict.localCellIndex].execution_count = null;
                autoResolvedCellIndices.add(conflict.localCellIndex);
            }
            autoResolved = true;
            autoResolvedCount++;
            autoResolvedDescriptions.push(`Execution count set to null (cell ${(conflict.localCellIndex ?? 0) + 1})`);
        }

        // Auto-resolve outputs-changed conflicts when stripOutputs is enabled
        // Only if the source code is identical (pure output difference)
        if (conflict.type === 'outputs-changed' && effectiveSettings.stripOutputs) {
            const localSource = conflict.localContent?.source;
            const remoteSource = conflict.remoteContent?.source;
            
            const localSourceStr = Array.isArray(localSource) ? localSource.join('') : (localSource || '');
            const remoteSourceStr = Array.isArray(remoteSource) ? remoteSource.join('') : (remoteSource || '');
            
            // If source is identical, this is purely an output difference - auto-resolve
            if (localSourceStr === remoteSourceStr) {
                if (conflict.localCellIndex !== undefined && resolvedNotebook.cells[conflict.localCellIndex]) {
                    resolvedNotebook.cells[conflict.localCellIndex].outputs = [];
                    resolvedNotebook.cells[conflict.localCellIndex].execution_count = null;
                    autoResolvedCellIndices.add(conflict.localCellIndex);
                }
                autoResolved = true;
                autoResolvedCount++;
                autoResolvedDescriptions.push(`Outputs cleared (cell ${(conflict.localCellIndex ?? 0) + 1})`);
            }
        }

        if (!autoResolved) {
            remainingConflicts.push(conflict);
        }
    }

    // Auto-resolve kernel version differences (notebook-level metadata)
    if (effectiveSettings.autoResolveKernelVersion) {
        const localKernel = semanticConflict.local?.metadata?.kernelspec;
        const remoteKernel = semanticConflict.remote?.metadata?.kernelspec;
        const baseKernel = semanticConflict.base?.metadata?.kernelspec;

        // Check if kernel versions differ between local and remote
        if (localKernel && remoteKernel) {
            const localKernelStr = JSON.stringify(localKernel);
            const remoteKernelStr = JSON.stringify(remoteKernel);
            const baseKernelStr = baseKernel ? JSON.stringify(baseKernel) : '';

            if (localKernelStr !== remoteKernelStr && 
                (localKernelStr !== baseKernelStr || remoteKernelStr !== baseKernelStr)) {
                // Use local kernel (already in resolvedNotebook)
                kernelAutoResolved = true;
                autoResolvedCount++;
                autoResolvedDescriptions.push('Kernel version: using local version');
            }
        }

        // Also check language_info version
        const localLangInfo = semanticConflict.local?.metadata?.language_info;
        const remoteLangInfo = semanticConflict.remote?.metadata?.language_info;
        const baseLangInfo = semanticConflict.base?.metadata?.language_info;

        if (localLangInfo && remoteLangInfo) {
            const localLangStr = JSON.stringify(localLangInfo);
            const remoteLangStr = JSON.stringify(remoteLangInfo);
            const baseLangStr = baseLangInfo ? JSON.stringify(baseLangInfo) : '';

            if (localLangStr !== remoteLangStr && 
                (localLangStr !== baseLangStr || remoteLangStr !== baseLangStr)) {
                // Use local language_info (already in resolvedNotebook)
                if (!kernelAutoResolved) {
                    autoResolvedCount++;
                    autoResolvedDescriptions.push('Python version: using local version');
                }
                kernelAutoResolved = true;
            }
        }
    }

    // Strip outputs from any remaining conflicted cells if enabled
    if (effectiveSettings.stripOutputs) {
        // For remaining conflicts that weren't auto-resolved, still strip outputs
        for (const conflict of remainingConflicts) {
            if (conflict.localCellIndex !== undefined && !autoResolvedCellIndices.has(conflict.localCellIndex)) {
                const cell = resolvedNotebook.cells[conflict.localCellIndex];
                if (cell && cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
                    cell.outputs = [];
                    autoResolvedDescriptions.push(`Outputs stripped (cell ${conflict.localCellIndex + 1})`);
                }
            }
        }
    }

    return {
        remainingConflicts,
        autoResolvedCount,
        autoResolvedDescriptions,
        resolvedNotebook,
        kernelAutoResolved
    };
}

/**
 * Check if a notebook has kernel version differences between local and remote
 */
export function hasKernelVersionConflict(
    local?: Notebook,
    remote?: Notebook,
    base?: Notebook
): boolean {
    if (!local || !remote) return false;

    const localKernel = local.metadata?.kernelspec;
    const remoteKernel = remote.metadata?.kernelspec;
    const baseKernel = base?.metadata?.kernelspec;

    if (!localKernel || !remoteKernel) return false;

    const localStr = JSON.stringify(localKernel);
    const remoteStr = JSON.stringify(remoteKernel);
    const baseStr = baseKernel ? JSON.stringify(baseKernel) : '';

    return localStr !== remoteStr && (localStr !== baseStr || remoteStr !== baseStr);
}
