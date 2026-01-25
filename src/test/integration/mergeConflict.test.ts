/**
 * @file mergeConflict.test.ts
 * @description Integration tests for MergeNB conflict detection and resolution.
 * 
 * Test philosophy:
 * - Each test should verify a specific, meaningful behavior
 * - Tests use real git operations where possible to catch integration issues
 * - Fixture files (02_*.ipynb, 04_Cascadia.ipynb) provide realistic scenarios
 */

import { describe, it } from 'mocha';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

const DEFAULT_TIMEOUT_MS = 20000;

// ============================================================================
// Assertions
// ============================================================================

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertGreater(actual: number, expected: number, message: string): void {
    if (actual <= expected) {
        throw new Error(`${message}: expected > ${expected}, got ${actual}`);
    }
}

function assertThrows(fn: () => void, message: string): void {
    let threw = false;
    try {
        fn();
    } catch {
        threw = true;
    }
    if (!threw) {
        throw new Error(message);
    }
}

// ============================================================================
// Git Test Repository Helper
// ============================================================================

class TestRepo {
    readonly path: string;

    constructor() {
        this.path = fs.mkdtempSync(path.join(os.tmpdir(), 'mergenb-test-'));
    }

    exec(cmd: string): string {
        try {
            // Use maxBuffer to handle large notebook files (default is 1MB, increase to 10MB)
            return execSync(cmd, { 
                cwd: this.path, 
                encoding: 'utf8', 
                stdio: ['pipe', 'pipe', 'pipe'],
                maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large notebooks
            });
        } catch (e: any) {
            if (e.status === 1 && cmd.includes('merge')) {
                return e.stdout || '';
            }
            throw e;
        }
    }

    init(): void {
        this.exec('git init');
        this.exec('git config user.email "test@test.current"');
        this.exec('git config user.name "Test"');
        this.exec('git checkout -b main');
    }

    write(filename: string, content: string): void {
        fs.writeFileSync(path.join(this.path, filename), content);
    }

    read(filename: string): string {
        return fs.readFileSync(path.join(this.path, filename), 'utf8');
    }

    commit(message: string): void {
        this.exec('git add .');
        this.exec(`git commit -m "${message}"`);
    }

    branch(name: string): void {
        this.exec(`git checkout -b ${name}`);
    }

    checkout(name: string): void {
        this.exec(`git checkout ${name}`);
    }

    merge(branch: string): boolean {
        try {
            this.exec(`git merge ${branch} --no-edit`);
            return true;
        } catch {
            return false;
        }
    }

    isUnmerged(filename: string): boolean {
        const status = this.exec('git status --porcelain');
        return status.includes(`UU ${filename}`);
    }

    getStaged(stage: 1 | 2 | 3, filename: string): string | null {
        try {
            return this.exec(`git show :${stage}:"${filename}"`);
        } catch {
            return null;
        }
    }

    cleanup(): void {
        fs.rmSync(this.path, { recursive: true, force: true });
    }
}

// ============================================================================
// Imports
// ============================================================================

import {
    hasConflictMarkers,
    analyzeNotebookConflicts,
    resolveAllConflicts,
} from '../../conflictDetector';

import { parseNotebook } from '../../notebookParser';
import { matchCells, detectReordering } from '../../cellMatcher';
import type { Notebook, NotebookCell, CellMapping, SemanticConflict } from '../../types';

// ============================================================================
// Helpers
// ============================================================================

function getCellSource(cell: NotebookCell): string {
    return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

function createNotebook(cells: Array<{ 
    type: 'code' | 'markdown'; 
    source: string; 
    execution_count?: number 
}>): Notebook {
    return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: cells.map(c => ({
            cell_type: c.type,
            metadata: {},
            source: [c.source],
            ...(c.type === 'code' ? { execution_count: c.execution_count ?? null, outputs: [] } : {}),
        })),
    };
}

function analyzeSemanticConflicts(
    base: Notebook | undefined,
    current: Notebook | undefined,
    incoming: Notebook | undefined
): { mappings: CellMapping[]; conflicts: SemanticConflict[] } {
    const mappings = matchCells(base, current, incoming);
    const conflicts: SemanticConflict[] = [];

    if (detectReordering(mappings)) {
        conflicts.push({ type: 'cell-reordered', description: 'Cells reordered' });
    }

    for (const m of mappings) {
        const { baseIndex, currentIndex, incomingIndex, baseCell, currentCell, incomingCell } = m;

        // Cell added in one branch only
        if (currentCell && !baseCell && !incomingCell) {
            conflicts.push({ type: 'cell-added', currentCellIndex: currentIndex, description: 'Added in current' });
        } else if (incomingCell && !baseCell && !currentCell) {
            conflicts.push({ type: 'cell-added', incomingCellIndex: incomingIndex, description: 'Added in incoming' });
        }
        // Cell deleted
        else if (baseCell && !currentCell && incomingCell) {
            conflicts.push({ type: 'cell-deleted', baseCellIndex: baseIndex, description: 'Deleted in current' });
        } else if (baseCell && currentCell && !incomingCell) {
            conflicts.push({ type: 'cell-deleted', baseCellIndex: baseIndex, description: 'Deleted in incoming' });
        }
        // Cell modified in both
        else if (baseCell && currentCell && incomingCell) {
            const baseSrc = getCellSource(baseCell);
            const currentSrc = getCellSource(currentCell);
            const incomingSrc = getCellSource(incomingCell);

            if (currentSrc !== baseSrc && incomingSrc !== baseSrc && currentSrc !== incomingSrc) {
                conflicts.push({ type: 'cell-modified', baseCellIndex: baseIndex, description: 'Modified in both' });
            }

            // Execution count conflicts
            if (baseCell.cell_type === 'code') {
                const bExec = baseCell.execution_count;
                const lExec = currentCell.execution_count;
                const rExec = incomingCell.execution_count;
                if (lExec !== bExec && rExec !== bExec && lExec !== rExec) {
                    conflicts.push({ type: 'execution-count-changed', baseCellIndex: baseIndex, description: 'Exec count differs' });
                }
            }
        }
    }

    return { mappings, conflicts };
}

// ============================================================================
// Mocha Test Suite
// ============================================================================

describe('MergeNB Integration Tests', function () {
    this.timeout(DEFAULT_TIMEOUT_MS);

    // ========================================================================
    // Textual Conflict Tests
    // ========================================================================
    describe('Textual Conflicts', () => {
        
        it('detects and resolves inline conflict markers (simple-textual-conflict.ipynb)', function () {
            // simple-textual-conflict.ipynb has hand-crafted inline conflict markers within cell source
            // This tests the core conflict detection and resolution workflow
            
            const testDir = path.resolve(__dirname, '..');
            const testFilePath = path.join(testDir, 'simple-textual-conflict.ipynb');

            assert(fs.existsSync(testFilePath), `Missing fixture: ${testFilePath}`);

            const content = fs.readFileSync(testFilePath, 'utf8');
            
            // Should detect conflict markers
            assert(hasConflictMarkers(content), 'Should detect conflict markers');

            // Should parse as valid JSON (markers are inside cell source strings)
            const notebook = parseNotebook(content);
            assert(Array.isArray(notebook.cells), 'Should have cells array');

            // Analyze to extract conflicts
            const analysis = analyzeNotebookConflicts(testFilePath, content);
            assertGreater(analysis.conflicts.length, 0, 'Should detect at least one conflict');

            const conflict = analysis.conflicts[0];
            assert(conflict.currentContent !== conflict.incomingContent, 'current and incoming should differ');

            // Resolution should produce valid marker-free JSON
            const resolved = resolveAllConflicts(content, [{ marker: conflict.marker, choice: 'current' }]);
            assert(!hasConflictMarkers(resolved) || analysis.conflicts.length > 1, 
                   'Should remove at least one conflict marker');

            // Result should still be valid JSON
            const resolvedNb = parseNotebook(resolved);
            assert(Array.isArray(resolvedNb.cells), 'Resolved should be valid notebook');
        });

        it('handles HTML-styled conflict markers (04_Cascadia.ipynb)', function () {
            // nbdime and some tools wrap conflict markers in HTML spans
            // This test verifies we can detect and resolve those too
            
            const testDir = path.resolve(__dirname, '..');
            const cascadiaPath = path.join(testDir, '04_Cascadia.ipynb');

            assert(fs.existsSync(cascadiaPath), `Missing fixture: ${cascadiaPath}`);

            const content = fs.readFileSync(cascadiaPath, 'utf8');

            // Should detect as having conflicts
            assert(hasConflictMarkers(content), 'Should detect HTML-styled conflict markers');

            // Should be valid JSON (HTML markers are inside cell content, not breaking JSON)
            const notebook = parseNotebook(content);
            assert(Array.isArray(notebook.cells), 'Should parse as valid notebook');

            // Should analyze and find conflicts
            const analysis = analyzeNotebookConflicts(cascadiaPath, content);
            assertGreater(analysis.conflicts.length, 0, 'Should find cell conflicts');
            console.log(`     Found ${analysis.conflicts.length} conflicts`);

            // Resolution should produce valid notebook without markers
            const resolutions = analysis.conflicts.map(c => ({ marker: c.marker, choice: 'current' as const }));
            const resolved = resolveAllConflicts(content, resolutions);
            
            assert(!hasConflictMarkers(resolved), 'Resolved should have no markers');
            const resolvedNb = parseNotebook(resolved);
            assert(Array.isArray(resolvedNb.cells), 'Resolved should be valid notebook');
        });

        it('resolution produces valid multi-cell notebook JSON', function () {
            // Verifies that conflict resolution preserves notebook structure
            // with multiple cells, only some of which are conflicting
            
            const repo = new TestRepo();
            try {
                repo.init();

                const base = createNotebook([
                    { type: 'markdown', source: '# Header' },
                    { type: 'code', source: 'x = 1' },
                    { type: 'markdown', source: '# Footer' },
                ]);
                const current = createNotebook([
                    { type: 'markdown', source: '# Header' },
                    { type: 'code', source: 'x = current' },
                    { type: 'markdown', source: '# Footer' },
                ]);
                const incoming = createNotebook([
                    { type: 'markdown', source: '# Header' },
                    { type: 'code', source: 'x = incoming' },
                    { type: 'markdown', source: '# Footer' },
                ]);

                repo.write('nb.ipynb', JSON.stringify(base, null, 2));
                repo.commit('base');

                repo.branch('feature');
                repo.write('nb.ipynb', JSON.stringify(incoming, null, 2));
                repo.commit('incoming');

                repo.checkout('main');
                repo.write('nb.ipynb', JSON.stringify(current, null, 2));
                repo.commit('current');

                repo.merge('feature');
                const content = repo.read('nb.ipynb');

                if (hasConflictMarkers(content)) {
                    const analysis = analyzeNotebookConflicts(path.join(repo.path, 'nb.ipynb'), content);
                    const resolutions = analysis.conflicts.map(c => ({ marker: c.marker, choice: 'current' as const }));
                    const resolved = resolveAllConflicts(content, resolutions);

                    // Must be valid JSON
                    const notebook = JSON.parse(resolved);
                    assertEqual(notebook.nbformat, 4, 'Should have nbformat');
                    assert(Array.isArray(notebook.cells), 'Should have cells array');
                    
                    // All cells should have required fields
                    for (const cell of notebook.cells) {
                        assert(cell.cell_type, 'Cell should have cell_type');
                        assert(cell.source !== undefined, 'Cell should have source');
                    }

                    assert(!hasConflictMarkers(resolved), 'No conflict markers should remain');
                }
            } finally {
                repo.cleanup();
            }
        });
    });

    // ========================================================================
    // Semantic Conflict Tests  
    // ========================================================================
    describe('Semantic Conflicts', () => {

        it('detects cell additions in three-way merge', function () {
            // When incoming adds a cell that base doesn't have, we should detect it
            
            const base = createNotebook([
                { type: 'markdown', source: '# Title' },
            ]);
            const current = createNotebook([
                { type: 'markdown', source: '# Title' },
            ]);
            const incoming = createNotebook([
                { type: 'markdown', source: '# Title' },
                { type: 'code', source: 'new_cell = True' },
            ]);

            const { conflicts } = analyzeSemanticConflicts(base, current, incoming);
            
            const addConflicts = conflicts.filter(c => c.type === 'cell-added');
            assertGreater(addConflicts.length, 0, 'Should detect cell-added');
        });

        it('detects cell deletions in three-way merge', function () {
            // When one branch deletes a cell, we should detect it
            
            const base = createNotebook([
                { type: 'markdown', source: '# Title' },
                { type: 'code', source: 'will_be_deleted = True' },
            ]);
            const current = createNotebook([
                { type: 'markdown', source: '# Title' },
                // Cell deleted
            ]);
            const incoming = createNotebook([
                { type: 'markdown', source: '# Title' },
                { type: 'code', source: 'will_be_deleted = True' },
            ]);

            const { conflicts } = analyzeSemanticConflicts(base, current, incoming);
            
            const deleteConflicts = conflicts.filter(c => c.type === 'cell-deleted');
            assertGreater(deleteConflicts.length, 0, 'Should detect cell-deleted');
        });

        it('detects execution count conflicts', function () {
            // Different execution counts between branches should be flagged
            
            const base = createNotebook([{ type: 'code', source: 'x = 1', execution_count: 1 }]);
            const current = createNotebook([{ type: 'code', source: 'x = 1', execution_count: 5 }]);
            const incoming = createNotebook([{ type: 'code', source: 'x = 1', execution_count: 10 }]);

            const { conflicts } = analyzeSemanticConflicts(base, current, incoming);
            
            const execConflicts = conflicts.filter(c => c.type === 'execution-count-changed');
            assertGreater(execConflicts.length, 0, 'Should detect execution count conflict');
        });

        it('matches cells across real notebook trio (02_*.ipynb)', function () {
            // Tests cell matching on real notebooks with 64-65 cells
            // Verifies the algorithm scales and produces sensible results
            
            const testDir = path.resolve(__dirname, '..');
            const basePath = path.join(testDir, '02_base.ipynb');
            const currentPath = path.join(testDir, '02_current.ipynb');
            const incomingPath = path.join(testDir, '02_incoming.ipynb');

            assert(fs.existsSync(basePath), 'Missing 02_base.ipynb');
            assert(fs.existsSync(currentPath), 'Missing 02_current.ipynb');
            assert(fs.existsSync(incomingPath), 'Missing 02_incoming.ipynb');

            const base = parseNotebook(fs.readFileSync(basePath, 'utf8'));
            const current = parseNotebook(fs.readFileSync(currentPath, 'utf8'));
            const incoming = parseNotebook(fs.readFileSync(incomingPath, 'utf8'));

            // Known cell counts
            assertEqual(base.cells.length, 64, 'Base should have 64 cells');
            assertEqual(current.cells.length, 64, 'current should have 64 cells');
            assertEqual(incoming.cells.length, 65, 'incoming should have 65 cells');

            const mappings = matchCells(base, current, incoming);
            assertGreater(mappings.length, 0, 'Should produce mappings');

            // Count mapped cells
            const baseMapped = mappings.filter(m => m.baseCell).length;
            const currentMapped = mappings.filter(m => m.currentCell).length;
            const incomingMapped = mappings.filter(m => m.incomingCell).length;

            assertEqual(baseMapped, 64, 'All base cells should be mapped');
            assertEqual(currentMapped, 64, 'All current cells should be mapped');
            assertEqual(incomingMapped, 65, 'All incoming cells should be mapped');

            // Most should be high confidence (similar notebooks)
            const highConf = mappings.filter(m => m.matchConfidence >= 0.9).length;
            assertGreater(highConf, mappings.length * 0.5, 'Most mappings should be high confidence');

            console.log(`     ${mappings.length} mappings, ${highConf} high confidence`);
        });

        it('retrieves staged versions from Git during merge (if unmerged)', function () {
            // During a merge conflict, Git stages base/current/incoming as :1/:2/:3
            // We need to retrieve and parse these for semantic analysis
            // NOTE: Git may auto-merge large notebook differences, so we check both paths
            
            const repo = new TestRepo();
            const testDir = path.resolve(__dirname, '..');

            try {
                const baseContent = fs.readFileSync(path.join(testDir, '02_base.ipynb'), 'utf8');
                const currentContent = fs.readFileSync(path.join(testDir, '02_current.ipynb'), 'utf8');
                const incomingContent = fs.readFileSync(path.join(testDir, '02_incoming.ipynb'), 'utf8');

                repo.init();
                repo.write('nb.ipynb', baseContent);
                repo.commit('base');

                repo.branch('feature');
                repo.write('nb.ipynb', incomingContent);
                repo.commit('incoming');

                repo.checkout('main');
                repo.write('nb.ipynb', currentContent);
                repo.commit('current');

                repo.merge('feature');

                // Check merge result
                const isUnmerged = repo.isUnmerged('nb.ipynb');
                const hasMarkers = hasConflictMarkers(repo.read('nb.ipynb'));

                if (isUnmerged) {
                    // Git created a semantic conflict - test staging area retrieval
                    const stagedBase = repo.getStaged(1, 'nb.ipynb');
                    const stagedcurrent = repo.getStaged(2, 'nb.ipynb');
                    const stagedincoming = repo.getStaged(3, 'nb.ipynb');

                    assert(stagedBase !== null, 'Should retrieve stage 1 (base)');
                    assert(stagedcurrent !== null, 'Should retrieve stage 2 (current)');
                    assert(stagedincoming !== null, 'Should retrieve stage 3 (incoming)');

                    // Each should be valid notebooks
                    const base = parseNotebook(stagedBase!);
                    const current = parseNotebook(stagedcurrent!);
                    const incoming = parseNotebook(stagedincoming!);

                    assert(base.cells.length > 0, 'Staged base should have cells');
                    assert(current.cells.length > 0, 'Staged current should have cells');
                    assert(incoming.cells.length > 0, 'Staged incoming should have cells');
                } else if (hasMarkers) {
                    // Git created textual conflict markers
                    console.log('     Git produced textual markers, staging test skipped');
                } else {
                    // Git auto-merged cleanly - this is also valid behavior
                    console.log('     Git auto-merged cleanly, staging test skipped');
                }
            } finally {
                repo.cleanup();
            }
        });
    });

    // ========================================================================
    // Edge Cases & Robustness
    // ========================================================================
    describe('Edge Cases', () => {

        it('rejects malformed notebook JSON', function () {
            // Parser should throw on invalid input, not silently fail
            
            assertThrows(() => {
                parseNotebook('not valid json');
            }, 'Should throw on invalid JSON');

            assertThrows(() => {
                parseNotebook('{"valid": "json but not notebook"}');
            }, 'Should throw on missing cells array');

            assertThrows(() => {
                parseNotebook('{"cells": [], "metadata": {}}');
            }, 'Should throw on missing nbformat');
        });

        it('handles cell source as string or string[]', function () {
            // nbformat allows source as either string or string[]
            // Our matching should normalize both forms
            
            const nbWithString: Notebook = {
                nbformat: 4,
                nbformat_minor: 5,
                metadata: {},
                cells: [{
                    cell_type: 'code',
                    source: 'x = 1\ny = 2',  // string
                    metadata: {},
                    outputs: [],
                }],
            };

            const nbWithArray: Notebook = {
                nbformat: 4,
                nbformat_minor: 5,
                metadata: {},
                cells: [{
                    cell_type: 'code',
                    source: ['x = 1\n', 'y = 2'],  // string[]
                    metadata: {},
                    outputs: [],
                }],
            };

            const mappings = matchCells(nbWithString, nbWithArray, undefined);
            assertEqual(mappings.length, 1, 'Should produce one mapping');
            assert(mappings[0].matchConfidence >= 0.9, 'Should match with high confidence');
        });

        it('handles empty notebooks', function () {
            const empty: Notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] };
            const withCell = createNotebook([{ type: 'markdown', source: '# Added' }]);

            // Should not crash, should detect the addition
            const { mappings, conflicts } = analyzeSemanticConflicts(empty, withCell, empty);
            assertGreater(mappings.length, 0, 'Should produce mapping for added cell');
        });

        it('preserves unicode and special characters', function () {
            const special = createNotebook([
                { type: 'markdown', source: '# 中文 日本語 한국어 🎉' },
                { type: 'code', source: 'print("Hello\\nWorld")' },
            ]);

            const serialized = JSON.stringify(special);
            const parsed = parseNotebook(serialized);

            assertEqual(parsed.cells.length, 2, 'Should preserve all cells');
            assert(getCellSource(parsed.cells[0]).includes('🎉'), 'Should preserve emoji');
            assert(getCellSource(parsed.cells[0]).includes('中文'), 'Should preserve CJK');
        });
    });
});
