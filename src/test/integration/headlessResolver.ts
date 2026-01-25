/**
 * @file headlessResolver.ts
 * @description Headless conflict resolution utilities for integration testing.
 * 
 * These functions wrap the main MergeNB modules to enable testing the full
 * conflict detection and resolution pipeline without the VSCode runtime.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Re-export types from main modules
export {
    Notebook,
    NotebookCell,
    NotebookMetadata,
    CellConflict,
    NotebookConflict,
    SemanticConflict,
    CellMapping,
    NotebookSemanticConflict,
    ResolutionChoice,
} from '../../types';

export {
    hasConflictMarkers,
    analyzeNotebookConflicts,
    resolveAllConflicts,
    applyAutoResolutions,
    AutoResolveResult,
    analyzeSemanticConflictsFromMappings,
} from '../../conflictDetector';

export {
    parseNotebook,
    serializeNotebook,
    renumberExecutionCounts,
} from '../../notebookParser';

export {
    matchCells,
    detectReordering,
} from '../../cellMatcher';

import {
    hasConflictMarkers,
    analyzeNotebookConflicts,
    resolveAllConflicts,
    analyzeSemanticConflictsFromMappings,
} from '../../conflictDetector';
import { parseNotebook, serializeNotebook, renumberExecutionCounts } from '../../notebookParser';
import { matchCells, detectReordering } from '../../cellMatcher';
import {
    Notebook,
    NotebookCell,
    CellConflict,
    NotebookConflict,
    CellMapping,
    SemanticConflict,
    NotebookSemanticConflict,
} from '../../types';

// ============================================================================
// Synchronous Git Helpers (for test setup - uses execSync instead of async)
// ============================================================================

/**
 * Synchronous Git operations for test harness.
 * These use execSync for simpler test setup code.
 */
export const GitHeadless = {
    getGitRoot(filePath: string): string | null {
        try {
            const dir = path.dirname(filePath);
            return execSync('git rev-parse --show-toplevel', {
                cwd: dir,
                encoding: 'utf8',
            }).trim();
        } catch {
            return null;
        }
    },

    isUnmerged(filePath: string): boolean {
        try {
            const gitRoot = this.getGitRoot(filePath);
            if (!gitRoot) return false;

            const relativePath = path.relative(gitRoot, filePath);
            const status = execSync('git status --porcelain', {
                cwd: gitRoot,
                encoding: 'utf8',
            });
            return status.includes(`UU ${relativePath}`);
        } catch {
            return false;
        }
    },

    getBase(filePath: string): string | null {
        try {
            const gitRoot = this.getGitRoot(filePath);
            if (!gitRoot) return null;
            const relativePath = path.relative(gitRoot, filePath);
            return execSync(`git show :1:"${relativePath}"`, {
                cwd: gitRoot,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
            });
        } catch {
            return null;
        }
    },

    getcurrent(filePath: string): string | null {
        try {
            const gitRoot = this.getGitRoot(filePath);
            if (!gitRoot) return null;
            const relativePath = path.relative(gitRoot, filePath);
            return execSync(`git show :2:"${relativePath}"`, {
                cwd: gitRoot,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
            });
        } catch {
            return null;
        }
    },

    getincoming(filePath: string): string | null {
        try {
            const gitRoot = this.getGitRoot(filePath);
            if (!gitRoot) return null;
            const relativePath = path.relative(gitRoot, filePath);
            return execSync(`git show :3:"${relativePath}"`, {
                cwd: gitRoot,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
            });
        } catch {
            return null;
        }
    },

    getThreeWayVersions(filePath: string): { base: string | null; current: string | null; incoming: string | null } | null {
        if (!this.isUnmerged(filePath)) {
            return null;
        }
        return {
            base: this.getBase(filePath),
            current: this.getcurrent(filePath),
            incoming: this.getincoming(filePath),
        };
    },

    getCurrentBranch(filePath: string): string | null {
        try {
            const gitRoot = this.getGitRoot(filePath);
            if (!gitRoot) return null;
            return execSync('git branch --show-current', {
                cwd: gitRoot,
                encoding: 'utf8',
            }).trim();
        } catch {
            return null;
        }
    },

    getMergeBranch(filePath: string): string | null {
        try {
            const gitRoot = this.getGitRoot(filePath);
            if (!gitRoot) return null;
            const mergeHead = execSync('git rev-parse MERGE_HEAD', {
                cwd: gitRoot,
                encoding: 'utf8',
            }).trim();
            const result = execSync(`git name-rev --name-only ${mergeHead}`, {
                cwd: gitRoot,
                encoding: 'utf8',
            }).trim();
            return result;
        } catch {
            return null;
        }
    },
};

// ============================================================================
// Conflict Analysis Helpers
// ============================================================================

/**
 * Result of analyzing a notebook file for conflicts
 */
export interface ConflictAnalysis {
    hasConflicts: boolean;
    hasTextualConflicts: boolean;
    hasSemanticConflicts: boolean;
    conflictCount: number;
    textualAnalysis?: NotebookConflict;
    semanticAnalysis?: NotebookSemanticConflict;
}

/**
 * Analyze a notebook file for any type of conflict.
 * This is a synchronous version for headless testing.
 */
export function analyzeConflicts(filePath: string): ConflictAnalysis {
    const content = fs.readFileSync(filePath, 'utf8');
    const hasTextual = hasConflictMarkers(content);

    if (hasTextual) {
        const textualAnalysis = analyzeNotebookConflicts(filePath, content);
        return {
            hasConflicts: true,
            hasTextualConflicts: true,
            hasSemanticConflicts: false,
            conflictCount: textualAnalysis.conflicts.length + textualAnalysis.metadataConflicts.length,
            textualAnalysis,
        };
    }

    // Check for semantic conflicts (UU status without textual markers)
    const isUnmerged = GitHeadless.isUnmerged(filePath);
    if (!isUnmerged) {
        return {
            hasConflicts: false,
            hasTextualConflicts: false,
            hasSemanticConflicts: false,
            conflictCount: 0,
        };
    }

    // Get three-way versions and perform semantic analysis
    const versions = GitHeadless.getThreeWayVersions(filePath);
    if (!versions || !versions.current || !versions.incoming) {
        return {
            hasConflicts: true,
            hasTextualConflicts: false,
            hasSemanticConflicts: true,
            conflictCount: 0,
        };
    }

    // Parse notebooks
    let baseNotebook: Notebook | undefined;
    let currentNotebook: Notebook | undefined;
    let incomingNotebook: Notebook | undefined;

    try {
        if (versions.base) baseNotebook = parseNotebook(versions.base);
    } catch { /* Base may not exist */ }

    try {
        currentNotebook = parseNotebook(versions.current);
    } catch { /* Parse error */ }

    try {
        incomingNotebook = parseNotebook(versions.incoming);
    } catch { /* Parse error */ }

    if (!currentNotebook || !incomingNotebook) {
        return {
            hasConflicts: true,
            hasTextualConflicts: false,
            hasSemanticConflicts: true,
            conflictCount: 0,
        };
    }

    // Perform semantic analysis
    const cellMappings = matchCells(baseNotebook, currentNotebook, incomingNotebook);
    const semanticConflicts = analyzeSemanticConflictsFromMappings(cellMappings);

    const semanticAnalysis: NotebookSemanticConflict = {
        filePath,
        hasTextualConflicts: false,
        semanticConflicts,
        cellMappings,
        base: baseNotebook,
        current: currentNotebook,
        incoming: incomingNotebook,
        currentBranch: GitHeadless.getCurrentBranch(filePath) || undefined,
        incomingBranch: GitHeadless.getMergeBranch(filePath) || undefined,
    };

    return {
        hasConflicts: semanticConflicts.length > 0,
        hasTextualConflicts: false,
        hasSemanticConflicts: semanticConflicts.length > 0,
        conflictCount: semanticConflicts.length,
        semanticAnalysis,
    };
}

function getCellSource(cell: NotebookCell): string {
    return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

// ============================================================================
// Resolution Helpers
// ============================================================================

/**
 * Resolution specification for a set of conflicts
 */
export interface ResolutionSpec {
    choices: Map<number, 'current' | 'incoming' | 'both' | 'base'>;
    renumberExecutionCounts?: boolean;
}

/**
 * Resolve textual conflicts in a notebook file.
 * Returns the resolved content (does not write to disk).
 */
export function resolveTextualConflicts(
    filePath: string,
    resolutionSpec: ResolutionSpec
): string {
    const content = fs.readFileSync(filePath, 'utf8');
    const analysis = analyzeNotebookConflicts(filePath, content);

    // Build resolution array
    const allConflicts = [
        ...analysis.conflicts.map((c: CellConflict, i: number) => ({ marker: c.marker, index: i })),
        ...analysis.metadataConflicts.map((c: { marker: any }, i: number) => ({ marker: c.marker, index: i + analysis.conflicts.length })),
    ];

    const resolutions = allConflicts.map(({ marker, index }) => {
        const choice = resolutionSpec.choices.get(index) || 'current';
        return {
            marker,
            choice: choice === 'base' ? 'current' : choice as 'current' | 'incoming' | 'both',
        };
    });

    let resolved = resolveAllConflicts(content, resolutions);

    // Optionally renumber execution counts
    if (resolutionSpec.renumberExecutionCounts) {
        try {
            let notebook = parseNotebook(resolved);
            notebook = renumberExecutionCounts(notebook);
            resolved = serializeNotebook(notebook);
        } catch { /* Keep unmodified if parse fails */ }
    }

    return resolved;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that a notebook is valid JSON with proper structure
 */
export function validateNotebook(content: string): { valid: boolean; error?: string } {
    try {
        const notebook = JSON.parse(content);
        if (!notebook.cells || !Array.isArray(notebook.cells)) {
            return { valid: false, error: 'Missing or invalid cells array' };
        }
        if (typeof notebook.nbformat !== 'number') {
            return { valid: false, error: 'Missing nbformat' };
        }
        for (let i = 0; i < notebook.cells.length; i++) {
            const cell = notebook.cells[i];
            if (!cell.cell_type) {
                return { valid: false, error: `Cell ${i} missing cell_type` };
            }
            if (cell.source === undefined) {
                return { valid: false, error: `Cell ${i} missing source` };
            }
        }
        return { valid: true };
    } catch (e: any) {
        return { valid: false, error: `JSON parse error: ${e.message}` };
    }
}

/**
 * Check if resolved content still has conflict markers
 */
export function hasRemainingConflicts(content: string): boolean {
    return hasConflictMarkers(content);
}
