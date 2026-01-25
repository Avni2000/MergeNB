/**
 * @file conflictDetector.ts
 * @description Conflict detection and analysis engine for MergeNB.
 * 
 * Handles two types of conflicts:
 * 
 * 1. TEXTUAL CONFLICTS - Git inserted <<<<<<</=======/>>>>>>> markers
 *    - Raw markers: Break JSON parsing, require raw text analysis
 *    - HTML-styled markers: Valid JSON with markers in cell content
 *    - Cell-level markers: Entire cells marked as current/incoming
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
 * Matches patterns like: <span style="color:red"><b><<<<<<< current</b></span>
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
    currentContent: string;
    incomingContent: string;
    currentBranch?: string;
    incomingBranch?: string;
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
    
    // Extract current content (between <<<<<<< and =======)
    const afterStart = startIdx + startMatch[0].length;
    const currentContent = str.substring(afterStart, middleIdx);
    
    // Extract incoming content (between ======= and >>>>>>>)
    const afterMiddle = middleIdx + 8; // length of "=======\n"
    const incomingContent = str.substring(afterMiddle, endIdx);
    
    return {
        currentContent: currentContent.replace(/\n$/, ''),
        incomingContent: incomingContent.replace(/\n$/, ''),
        currentBranch: startMatch[1] || undefined,
        incomingBranch: endMatch[1] || undefined
    };
}

/**
 * Resolve a conflict in a string by choosing current or incoming content.
 * Recursively resolves all conflicts in the string.
 */
function resolveStringConflict(str: string, choice: 'current' | 'incoming' | 'both'): string {
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
        case 'current':
            replacement = conflict.currentContent;
            break;
        case 'incoming':
            replacement = conflict.incomingContent;
            break;
        case 'both':
            replacement = conflict.currentContent + '\n' + conflict.incomingContent;
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
    currentCellIndices: number[];
    incomingCellIndices: number[];
    currentBranch?: string;
    incomingBranch?: string;
}

/**
 * Find cell-level conflicts where entire cells are marked as current/incoming.
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
            const currentBranch = extractBranchFromMarkerCell(cell, 'start');
            
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
            
            const incomingBranch = extractBranchFromMarkerCell(notebook.cells[endIdx], 'end');
            
            // Cells between start+1 and sep-1 are current
            const currentCellIndices: number[] = [];
            for (let j = startIdx + 1; j < sepIdx; j++) {
                currentCellIndices.push(j);
            }
            
            // Cells between sep+1 and end-1 are incoming
            const incomingCellIndices: number[] = [];
            for (let j = sepIdx + 1; j < endIdx; j++) {
                incomingCellIndices.push(j);
            }
            
            conflicts.push({
                startMarkerCellIndex: startIdx,
                separatorCellIndex: sepIdx,
                endMarkerCellIndex: endIdx,
                currentCellIndices,
                incomingCellIndices,
                currentBranch,
                incomingBranch
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
        // Match cells by position: current[0] vs incoming[0], current[1] vs incoming[1], etc.
        const maxCells = Math.max(
            cellConflict.currentCellIndices.length,
            cellConflict.incomingCellIndices.length
        );
        
        for (let i = 0; i < maxCells; i++) {
            const currentIdx = cellConflict.currentCellIndices[i];
            const incomingIdx = cellConflict.incomingCellIndices[i];
            
            const currentCell = currentIdx !== undefined ? notebook.cells[currentIdx] : undefined;
            const incomingCell = incomingIdx !== undefined ? notebook.cells[incomingIdx] : undefined;
            
            const currentContent = currentCell ? cellToDisplayContent(currentCell) : '';
            const incomingContent = incomingCell ? cellToDisplayContent(incomingCell) : '';
            
            // Determine cell type for display
            const cellType = currentCell?.cell_type || incomingCell?.cell_type || 'code';
            
            conflicts.push({
                cellIndex: currentIdx ?? incomingIdx ?? cellConflict.startMarkerCellIndex,
                field: 'source',
                currentContent,
                incomingContent,
                marker: {
                    start: cellConflict.startMarkerCellIndex,
                    middle: cellConflict.separatorCellIndex,
                    end: cellConflict.endMarkerCellIndex,
                    currentBranch: cellConflict.currentBranch,
                    incomingBranch: cellConflict.incomingBranch
                },
                // Store cell type info for UI display
                cellType: cellType as 'code' | 'markdown' | 'raw',
                currentCellIndex: currentIdx,
                incomingCellIndex: incomingIdx
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
            c.currentCellIndices.includes(cellIndex) ||
            c.incomingCellIndices.includes(cellIndex)
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
                    currentContent: extracted.currentContent,
                    incomingContent: extracted.incomingContent,
                    marker: { 
                        start: 0, middle: 0, end: 0,
                        currentBranch: extracted.currentBranch,
                        incomingBranch: extracted.incomingBranch
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
                    currentContent: extracted.currentContent,
                    incomingContent: extracted.incomingContent,
                    marker: {
                        start: 0, middle: 0, end: 0,
                        currentBranch: extracted.currentBranch,
                        incomingBranch: extracted.incomingBranch
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
                currentContent: extracted.currentContent,
                incomingContent: extracted.incomingContent,
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
    resolutions: Array<{ marker: { start: number; middle?: number; end?: number }; choice: 'current' | 'incoming' | 'both'; customContent?: string }>
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
    
    // Default resolution choice for all conflicts (use first resolution's choice or 'current')
    const defaultChoice = resolutions[0]?.choice || 'current';
    
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
                if (choice === 'current') {
                    // Keep current cells, remove incoming cells
                    cellConflict.incomingCellIndices.forEach(idx => cellsToRemove.add(idx));
                } else if (choice === 'incoming') {
                    // Keep incoming cells, remove current cells
                    cellConflict.currentCellIndices.forEach(idx => cellsToRemove.add(idx));
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
    return { current: '', incoming: '' };
}

/**
 * Enrich textual conflicts with base/current/incoming versions from Git staging areas.
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

        const { base, current, incoming } = versions;
        console.log('[MergeNB] Got Git versions for textual conflict:');
        console.log('[MergeNB] - base:', base ? `${base.length} chars` : 'null');
        console.log('[MergeNB] - current:', current ? `${current.length} chars` : 'null');
        console.log('[MergeNB] - incoming:', incoming ? `${incoming.length} chars` : 'null');

        // Parse each version as a notebook
        let baseNotebook: Notebook | undefined;
        let currentNotebook: Notebook | undefined;
        let incomingNotebook: Notebook | undefined;

        try {
            if (base) baseNotebook = parseNotebook(base);
        } catch (error) {
            console.warn('[MergeNB] Failed to parse base notebook:', error);
        }

        try {
            if (current) currentNotebook = parseNotebook(current);
        } catch (error) {
            console.warn('[MergeNB] Failed to parse current notebook:', error);
        }

        try {
            if (incoming) incomingNotebook = parseNotebook(incoming);
        } catch (error) {
            console.warn('[MergeNB] Failed to parse incoming notebook:', error);
        }

        // If we couldn't parse at least current and incoming, return original
        if (!currentNotebook && !incomingNotebook) {
            console.log('[MergeNB] Could not parse current or incoming notebooks');
            return conflict;
        }

        // Match cells across versions
        const cellMappings = matchCells(baseNotebook, currentNotebook, incomingNotebook);

        // Get branch information
        const [currentBranch, incomingBranch] = await Promise.all([
            gitIntegration.getCurrentBranch(conflict.filePath),
            gitIntegration.getMergeBranch(conflict.filePath)
        ]);

        console.log('[MergeNB] Enriched textual conflict with context:');
        console.log('[MergeNB] - cellMappings:', cellMappings.length);
        console.log('[MergeNB] - currentBranch:', currentBranch);
        console.log('[MergeNB] - incomingBranch:', incomingBranch);

        return {
            ...conflict,
            base: baseNotebook,
            current: currentNotebook,
            incoming: incomingNotebook,
            cellMappings,
            currentBranch: currentBranch || undefined,
            incomingBranch: incomingBranch || undefined
        };
    } catch (error) {
        console.error('[MergeNB] Error enriching textual conflict:', error);
        return conflict;
    }
}

/**
 * Detect semantic conflicts (Git UU status without textual markers)
 * Compares base/current/incoming versions from Git staging areas
 */
export async function detectSemanticConflicts(filePath: string): Promise<NotebookSemanticConflict | null> {
    try {
        // Get the three-way versions from Git
        const versions = await gitIntegration.getThreeWayVersions(filePath);
        if (!versions) {
            return null; // Not an unmerged file
        }

        const { base, current, incoming } = versions;

        // Debug: Check if we're getting different versions
        console.log('[MergeNB] detectSemanticConflicts for:', filePath);
        console.log('[MergeNB] base length:', base?.length ?? 0);
        console.log('[MergeNB] current length:', current?.length ?? 0);
        console.log('[MergeNB] incoming length:', incoming?.length ?? 0);
        console.log('[MergeNB] base === current:', base === current);
        console.log('[MergeNB] base === incoming:', base === incoming);
        console.log('[MergeNB] current === incoming:', current === incoming);

        // Parse each version as a notebook
        let baseNotebook: Notebook | undefined;
        let currentNotebook: Notebook | undefined;
        let incomingNotebook: Notebook | undefined;

        try {
            if (base) baseNotebook = parseNotebook(base);
        } catch (error) {
            console.warn('Failed to parse base notebook:', error);
        }

        try {
            if (current) currentNotebook = parseNotebook(current);
        } catch (error) {
            console.warn('Failed to parse current notebook:', error);
        }

        try {
            if (incoming) incomingNotebook = parseNotebook(incoming);
        } catch (error) {
            console.warn('Failed to parse incoming notebook:', error);
        }

        // Debug: Check parsed notebooks
        if (baseNotebook && currentNotebook && incomingNotebook) {
            const baseLegoCell = baseNotebook.cells.find(c => {
                const src = Array.isArray(c.source) ? c.source.join('') : c.source;
                return src.includes('2.3 The Lego Analogy');
            });
            const currentLegoCell = currentNotebook.cells.find(c => {
                const src = Array.isArray(c.source) ? c.source.join('') : c.source;
                return src.includes('2.3 The Lego Analogy');
            });
            const incomingLegoCell = incomingNotebook.cells.find(c => {
                const src = Array.isArray(c.source) ? c.source.join('') : c.source;
                return src.includes('2.3 The Lego Analogy');
            });
            
            if (baseLegoCell) {
                const baseSrc = Array.isArray(baseLegoCell.source) ? baseLegoCell.source.join('') : baseLegoCell.source;
                const currentSrc = currentLegoCell ? (Array.isArray(currentLegoCell.source) ? currentLegoCell.source.join('') : currentLegoCell.source) : '';
                const incomingSrc = incomingLegoCell ? (Array.isArray(incomingLegoCell.source) ? incomingLegoCell.source.join('') : incomingLegoCell.source) : '';
                
                console.log('[MergeNB] LEGO CELL PARSED:');
                console.log('[MergeNB] - base has "Key insight":', baseSrc.includes('Key insight'));
                console.log('[MergeNB] - current has "Key insight":', currentSrc.includes('Key insight'));
                console.log('[MergeNB] - incoming has "Key insight":', incomingSrc.includes('Key insight'));
            }
        }

        // If we couldn't parse at least current and incoming, can't detect semantic conflicts
        if (!currentNotebook && !incomingNotebook) {
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
        const cellMappings = matchCells(baseNotebook, currentNotebook, incomingNotebook);

        // Analyze mappings to find semantic conflicts
        const semanticConflicts = analyzeSemanticConflictsFromMappings(cellMappings);

        // Get branch information
        const [currentBranch, incomingBranch] = await Promise.all([
            gitIntegration.getCurrentBranch(filePath),
            gitIntegration.getMergeBranch(filePath)
        ]);

        return {
            filePath,
            hasTextualConflicts,
            semanticConflicts,
            cellMappings,
            base: baseNotebook,
            current: currentNotebook,
            incoming: incomingNotebook,
            currentBranch: currentBranch || undefined,
            incomingBranch: incomingBranch || undefined
        };
    } catch (error) {
        console.error('Error detecting semantic conflicts:', error);
        return null;
    }
}

/**
 * Analyze cell mappings to identify semantic conflicts.
 * Exported for testing purposes.
 */
export function analyzeSemanticConflictsFromMappings(mappings: CellMapping[]): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Check for cell reordering
    if (detectReordering(mappings)) {
        conflicts.push({
            type: 'cell-reordered',
            description: 'Cells have been reordered between versions'
        });
    }

    for (const mapping of mappings) {
        const { baseIndex, currentIndex, incomingIndex, baseCell, currentCell, incomingCell } = mapping;

        // Case 1: Cell added in current only
        if (currentCell && !baseCell && !incomingCell) {
            conflicts.push({
                type: 'cell-added',
                currentCellIndex: currentIndex,
                currentContent: currentCell,
                description: 'Cell added in current branch'
            });
            continue;
        }

        // Case 2: Cell added in incoming only
        if (incomingCell && !baseCell && !currentCell) {
            conflicts.push({
                type: 'cell-added',
                incomingCellIndex: incomingIndex,
                incomingContent: incomingCell,
                description: 'Cell added in incoming branch'
            });
            continue;
        }

        // Case 3: Cell added in both (conflict!)
        if (currentCell && incomingCell && !baseCell) {
            const currentSource = Array.isArray(currentCell.source) ? currentCell.source.join('') : currentCell.source;
            const incomingSource = Array.isArray(incomingCell.source) ? incomingCell.source.join('') : incomingCell.source;

            if (currentSource !== incomingSource) {
                conflicts.push({
                    type: 'cell-added',
                    currentCellIndex: currentIndex,
                    incomingCellIndex: incomingIndex,
                    currentContent: currentCell,
                    incomingContent: incomingCell,
                    description: 'Different cells added in same position'
                });
            }
            continue;
        }

        // Case 4: Cell deleted in current
        if (baseCell && !currentCell && incomingCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                incomingCellIndex: incomingIndex,
                baseContent: baseCell,
                incomingContent: incomingCell,
                description: 'Cell deleted in current branch'
            });
            continue;
        }

        // Case 5: Cell deleted in incoming
        if (baseCell && currentCell && !incomingCell) {
            conflicts.push({
                type: 'cell-deleted',
                baseCellIndex: baseIndex,
                currentCellIndex: currentIndex,
                baseContent: baseCell,
                currentContent: currentCell,
                description: 'Cell deleted in incoming branch'
            });
            continue;
        }

        // Case 6: Cell deleted in both (no conflict, just deleted)
        if (baseCell && !currentCell && !incomingCell) {
            // Not a conflict, skip
            continue;
        }

        // Case 7: Cell exists in all three - check for modifications
        if (baseCell && currentCell && incomingCell) {
            const conflicts_found = compareCells(baseCell, currentCell, incomingCell, baseIndex, currentIndex, incomingIndex);
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
    currentCell: NotebookCell,
    incomingCell: NotebookCell,
    baseIndex?: number,
    currentIndex?: number,
    incomingIndex?: number
): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Compare source content
    const baseSource = Array.isArray(baseCell.source) ? baseCell.source.join('') : baseCell.source;
    const currentSource = Array.isArray(currentCell.source) ? currentCell.source.join('') : currentCell.source;
    const incomingSource = Array.isArray(incomingCell.source) ? incomingCell.source.join('') : incomingCell.source;

    const currentModified = currentSource !== baseSource;
    const incomingModified = incomingSource !== baseSource;

    // Both modified the source differently
    if (currentModified && incomingModified && currentSource !== incomingSource) {
        conflicts.push({
            type: 'cell-modified',
            baseCellIndex: baseIndex,
            currentCellIndex: currentIndex,
            incomingCellIndex: incomingIndex,
            baseContent: baseCell,
            currentContent: currentCell,
            incomingContent: incomingCell,
            description: 'Cell source modified in both branches differently'
        });
    }

    // Compare execution_count (only for code cells)
    if (baseCell.cell_type === 'code' && currentCell.cell_type === 'code' && incomingCell.cell_type === 'code') {
        const baseExecCount = baseCell.execution_count;
        const currentExecCount = currentCell.execution_count;
        const incomingExecCount = incomingCell.execution_count;

        if (currentExecCount !== incomingExecCount && 
            (currentExecCount !== baseExecCount || incomingExecCount !== baseExecCount)) {
            conflicts.push({
                type: 'execution-count-changed',
                baseCellIndex: baseIndex,
                currentCellIndex: currentIndex,
                incomingCellIndex: incomingIndex,
                baseContent: baseCell,
                currentContent: currentCell,
                incomingContent: incomingCell,
                description: `Execution count differs: current=${currentExecCount}, incoming=${incomingExecCount}`
            });
        }

        // Compare outputs
        const baseOutputs = JSON.stringify(baseCell.outputs || []);
        const currentOutputs = JSON.stringify(currentCell.outputs || []);
        const incomingOutputs = JSON.stringify(incomingCell.outputs || []);

        if (currentOutputs !== incomingOutputs && 
            (currentOutputs !== baseOutputs || incomingOutputs !== baseOutputs)) {
            conflicts.push({
                type: 'outputs-changed',
                baseCellIndex: baseIndex,
                currentCellIndex: currentIndex,
                incomingCellIndex: incomingIndex,
                baseContent: baseCell,
                currentContent: currentCell,
                incomingContent: incomingCell,
                description: 'Cell outputs differ between branches'
            });
        }
    }

    // Compare metadata
    const baseMetadata = JSON.stringify(baseCell.metadata);
    const currentMetadata = JSON.stringify(currentCell.metadata);
    const incomingMetadata = JSON.stringify(incomingCell.metadata);

    const currentMetadataModified = currentMetadata !== baseMetadata;
    const incomingMetadataModified = incomingMetadata !== baseMetadata;

    if (currentMetadataModified && incomingMetadataModified && currentMetadata !== incomingMetadata) {
        conflicts.push({
            type: 'metadata-changed',
            baseCellIndex: baseIndex,
            currentCellIndex: currentIndex,
            incomingCellIndex: incomingIndex,
            baseContent: baseCell,
            currentContent: currentCell,
            incomingContent: incomingCell,
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

    // Start with a deep copy of the current notebook as our resolved version
    const resolvedNotebook: Notebook = semanticConflict.current 
        ? JSON.parse(JSON.stringify(semanticConflict.current))
        : JSON.parse(JSON.stringify(semanticConflict.incoming!));

    // Track cell indices that had auto-resolutions applied
    const autoResolvedCellIndices = new Set<number>();

    for (const conflict of semanticConflict.semanticConflicts) {
        let autoResolved = false;

        // Auto-resolve execution count differences
        if (conflict.type === 'execution-count-changed' && effectiveSettings.autoResolveExecutionCount) {
            // Set execution_count to null on the resolved cell
            if (conflict.currentCellIndex !== undefined && resolvedNotebook.cells[conflict.currentCellIndex]) {
                resolvedNotebook.cells[conflict.currentCellIndex].execution_count = null;
                autoResolvedCellIndices.add(conflict.currentCellIndex);
            }
            autoResolved = true;
            autoResolvedCount++;
            autoResolvedDescriptions.push(`Execution count set to null (cell ${(conflict.currentCellIndex ?? 0) + 1})`);
        }

        // Auto-resolve outputs-changed conflicts when stripOutputs is enabled
        // Only if the source code is identical (pure output difference)
        if (conflict.type === 'outputs-changed' && effectiveSettings.stripOutputs) {
            const currentSource = conflict.currentContent?.source;
            const incomingSource = conflict.incomingContent?.source;
            
            const currentSourceStr = Array.isArray(currentSource) ? currentSource.join('') : (currentSource || '');
            const incomingSourceStr = Array.isArray(incomingSource) ? incomingSource.join('') : (incomingSource || '');
            
            // If source is identical, this is purely an output difference - auto-resolve
            if (currentSourceStr === incomingSourceStr) {
                if (conflict.currentCellIndex !== undefined && resolvedNotebook.cells[conflict.currentCellIndex]) {
                    resolvedNotebook.cells[conflict.currentCellIndex].outputs = [];
                    resolvedNotebook.cells[conflict.currentCellIndex].execution_count = null;
                    autoResolvedCellIndices.add(conflict.currentCellIndex);
                }
                autoResolved = true;
                autoResolvedCount++;
                autoResolvedDescriptions.push(`Outputs cleared (cell ${(conflict.currentCellIndex ?? 0) + 1})`);
            }
        }

        if (!autoResolved) {
            remainingConflicts.push(conflict);
        }
    }

    // Auto-resolve kernel version differences (notebook-level metadata)
    if (effectiveSettings.autoResolveKernelVersion) {
        const currentKernel = semanticConflict.current?.metadata?.kernelspec;
        const incomingKernel = semanticConflict.incoming?.metadata?.kernelspec;
        const baseKernel = semanticConflict.base?.metadata?.kernelspec;

        // Check if kernel versions differ between current and incoming
        if (currentKernel && incomingKernel) {
            const currentKernelStr = JSON.stringify(currentKernel);
            const incomingKernelStr = JSON.stringify(incomingKernel);
            const baseKernelStr = baseKernel ? JSON.stringify(baseKernel) : '';

            if (currentKernelStr !== incomingKernelStr && 
                (currentKernelStr !== baseKernelStr || incomingKernelStr !== baseKernelStr)) {
                // Use current kernel (already in resolvedNotebook)
                kernelAutoResolved = true;
                autoResolvedCount++;
                autoResolvedDescriptions.push('Kernel version: using current version');
            }
        }

        // Also check language_info version
        const currentLangInfo = semanticConflict.current?.metadata?.language_info;
        const incomingLangInfo = semanticConflict.incoming?.metadata?.language_info;
        const baseLangInfo = semanticConflict.base?.metadata?.language_info;

        if (currentLangInfo && incomingLangInfo) {
            const currentLangStr = JSON.stringify(currentLangInfo);
            const incomingLangStr = JSON.stringify(incomingLangInfo);
            const baseLangStr = baseLangInfo ? JSON.stringify(baseLangInfo) : '';

            if (currentLangStr !== incomingLangStr && 
                (currentLangStr !== baseLangStr || incomingLangStr !== baseLangStr)) {
                // Use current language_info (already in resolvedNotebook)
                if (!kernelAutoResolved) {
                    autoResolvedCount++;
                    autoResolvedDescriptions.push('Python version: using current version');
                }
                kernelAutoResolved = true;
            }
        }
    }

    // Strip outputs from any remaining conflicted cells if enabled
    if (effectiveSettings.stripOutputs) {
        // For remaining conflicts that weren't auto-resolved, still strip outputs
        for (const conflict of remainingConflicts) {
            if (conflict.currentCellIndex !== undefined && !autoResolvedCellIndices.has(conflict.currentCellIndex)) {
                const cell = resolvedNotebook.cells[conflict.currentCellIndex];
                if (cell && cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
                    cell.outputs = [];
                    autoResolvedDescriptions.push(`Outputs stripped (cell ${conflict.currentCellIndex + 1})`);
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
 * Check if a notebook has kernel version differences between current and incoming
 */
export function hasKernelVersionConflict(
    current?: Notebook,
    incoming?: Notebook,
    base?: Notebook
): boolean {
    if (!current || !incoming) return false;

    const currentKernel = current.metadata?.kernelspec;
    const incomingKernel = incoming.metadata?.kernelspec;
    const baseKernel = base?.metadata?.kernelspec;

    if (!currentKernel || !incomingKernel) return false;

    const currentStr = JSON.stringify(currentKernel);
    const incomingStr = JSON.stringify(incomingKernel);
    const baseStr = baseKernel ? JSON.stringify(baseKernel) : '';

    return currentStr !== incomingStr && (currentStr !== baseStr || incomingStr !== baseStr);
}
