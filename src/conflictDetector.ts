import { CellConflict, NotebookConflict, NotebookSemanticConflict, SemanticConflict, CellMapping } from './types';
import { Notebook, NotebookCell } from './types';
import * as gitIntegration from './gitIntegration';
import { matchCells, detectReordering } from './cellMatcher';
import { parseNotebook } from './notebookParser';

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
 * Convert cells to a display string for the conflict UI
 */
function cellsToDisplayString(notebook: Notebook, cellIndices: number[]): string {
    return cellIndices.map(idx => {
        const cell = notebook.cells[idx];
        const source = sourceToString(cell.source);
        const typeLabel = cell.cell_type === 'code' ? '[Code]' : '[Markdown]';
        return `--- Cell ${idx + 1} ${typeLabel} ---\n${source}`;
    }).join('\n\n');
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
        const localContent = cellsToDisplayString(notebook, cellConflict.localCellIndices);
        const remoteContent = cellsToDisplayString(notebook, cellConflict.remoteCellIndices);
        
        conflicts.push({
            cellIndex: cellConflict.startMarkerCellIndex,
            field: 'source',
            localContent: localContent || '(no local cells)',
            remoteContent: remoteContent || '(no remote cells)',
            marker: {
                start: cellConflict.startMarkerCellIndex,
                middle: cellConflict.separatorCellIndex,
                end: cellConflict.endMarkerCellIndex,
                localBranch: cellConflict.localBranch,
                remoteBranch: cellConflict.remoteBranch
            }
        });
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
