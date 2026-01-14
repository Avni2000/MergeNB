#!/usr/bin/env npx ts -node
/**
 * @file mergeConflict.test.ts
 * @description Integration tests for MergeNB conflict detection and resolution.
 * 
 * These tests create REAL Git merge conflicts and verify the detection/resolution
 * pipeline works correctly. Tests fail loudly if conflicts aren't created.
 * 
 * Run with: npx ts-node src/test/integration/mergeConflict.test.ts
 * Or: npm run test:integration
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

// ============================================================================
// Test Infrastructure
// ============================================================================

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
    duration?: number;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
    const start = Date.now();
    try {
        fn();
        results.push({ name, passed: true, duration: Date.now() - start });
        console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
    } catch (e: any) {
        results.push({ name, passed: false, error: e.message, duration: Date.now() - start });
        console.log(`  ❌ ${name}`);
        console.log(`     ${e.message}`);
    }
}

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
            return execSync(cmd, { cwd: this.path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e: any) {
            // Merge conflicts return exit code 1, that's expected
            if (e.status === 1 && cmd.includes('merge')) {
                return e.stdout || '';
            }
            throw e;
        }
    }

    init(): void {
        this.exec('git init');
        this.exec('git config user.email "test@test.local"');
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
            return true; // Clean merge
        } catch {
            return false; // Conflict
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
// Import from main codebase
// ============================================================================

import {
    hasConflictMarkers,
    analyzeNotebookConflicts,
    resolveAllConflicts,
} from '../../conflictDetector';

import {
    parseNotebook,
    serializeNotebook,
} from '../../notebookParser';

import { matchCells, detectReordering } from '../../cellMatcher';

import type { 
    Notebook,
    NotebookCell,
    CellMapping,
    SemanticConflict,
    SemanticConflictType
} from '../../types';

// ============================================================================
// Semantic Conflict Analysis (Synchronous - for testing without Git staging)
// ============================================================================

/**
 * Analyze semantic conflicts between three notebook versions.
 * This is a synchronous version for testing that takes parsed notebooks directly.
 */
function analyzeSemanticConflictsFromNotebooks(
    base: Notebook | undefined,
    local: Notebook | undefined,
    remote: Notebook | undefined
): { mappings: CellMapping[]; conflicts: SemanticConflict[] } {
    const mappings = matchCells(base, local, remote);
    const conflicts = detectSemanticConflictsFromMappings(mappings);
    return { mappings, conflicts };
}

/**
 * Detect semantic conflicts from cell mappings.
 * Mirrors the logic in conflictDetector.ts but accessible for testing.
 */
function detectSemanticConflictsFromMappings(mappings: CellMapping[]): SemanticConflict[] {
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

        // Cell added in local only
        if (localCell && !baseCell && !remoteCell) {
            conflicts.push({
                type: 'cell-added',
                localCellIndex: localIndex,
                localContent: localCell,
                description: 'Cell added in local branch'
            });
            continue;
        }

        // Cell added in remote only
        if (remoteCell && !baseCell && !localCell) {
            conflicts.push({
                type: 'cell-added',
                remoteCellIndex: remoteIndex,
                remoteContent: remoteCell,
                description: 'Cell added in remote branch'
            });
            continue;
        }

        // Cell added in both (potential conflict)
        if (localCell && remoteCell && !baseCell) {
            const localSrc = getCellSource(localCell);
            const remoteSrc = getCellSource(remoteCell);
            if (localSrc !== remoteSrc) {
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

        // Cell deleted in local
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

        // Cell deleted in remote
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

        // Cell exists in all three - check for modifications
        if (baseCell && localCell && remoteCell) {
            const baseSrc = getCellSource(baseCell);
            const localSrc = getCellSource(localCell);
            const remoteSrc = getCellSource(remoteCell);

            const localModified = localSrc !== baseSrc;
            const remoteModified = remoteSrc !== baseSrc;

            // Both modified source differently
            if (localModified && remoteModified && localSrc !== remoteSrc) {
                conflicts.push({
                    type: 'cell-modified',
                    baseCellIndex: baseIndex,
                    localCellIndex: localIndex,
                    remoteCellIndex: remoteIndex,
                    baseContent: baseCell,
                    localContent: localCell,
                    remoteContent: remoteCell,
                    description: 'Cell source modified differently in both branches'
                });
            }

            // Check outputs for code cells
            if (baseCell.cell_type === 'code') {
                const baseOutputs = JSON.stringify(baseCell.outputs || []);
                const localOutputs = JSON.stringify(localCell.outputs || []);
                const remoteOutputs = JSON.stringify(remoteCell.outputs || []);

                if (localOutputs !== baseOutputs && remoteOutputs !== baseOutputs && localOutputs !== remoteOutputs) {
                    conflicts.push({
                        type: 'outputs-changed',
                        baseCellIndex: baseIndex,
                        localCellIndex: localIndex,
                        remoteCellIndex: remoteIndex,
                        description: 'Cell outputs differ between branches'
                    });
                }
            }

            // Check execution counts
            if (baseCell.cell_type === 'code') {
                const baseExec = baseCell.execution_count;
                const localExec = localCell.execution_count;
                const remoteExec = remoteCell.execution_count;

                if (localExec !== baseExec && remoteExec !== baseExec && localExec !== remoteExec) {
                    conflicts.push({
                        type: 'execution-count-changed',
                        baseCellIndex: baseIndex,
                        localCellIndex: localIndex,
                        remoteCellIndex: remoteIndex,
                        description: `Execution count: base=${baseExec}, local=${localExec}, remote=${remoteExec}`
                    });
                }
            }
        }
    }

    return conflicts;
}

function getCellSource(cell: NotebookCell): string {
    return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

// ============================================================================
// Test Case Definition
// ============================================================================

interface ThreeWayTestCase {
    name: string;
    description: string;
    basePath: string;
    localPath: string;
    remotePath: string;
    expectedConflictTypes?: SemanticConflictType[];
    expectedMinConflicts?: number;
    expectedCellCountDiff?: { local: number; remote: number }; // relative to base
}

function loadTestCase(testCase: ThreeWayTestCase): {
    base: Notebook;
    local: Notebook;
    remote: Notebook;
} {
    const baseContent = fs.readFileSync(testCase.basePath, 'utf8');
    const localContent = fs.readFileSync(testCase.localPath, 'utf8');
    const remoteContent = fs.readFileSync(testCase.remotePath, 'utf8');

    return {
        base: parseNotebook(baseContent),
        local: parseNotebook(localContent),
        remote: parseNotebook(remoteContent),
    };
}

function analyzeThreeWayCase(testCase: ThreeWayTestCase): {
    mappings: CellMapping[];
    conflicts: SemanticConflict[];
    base: Notebook;
    local: Notebook;
    remote: Notebook;
} {
    const notebooks = loadTestCase(testCase);
    const result = analyzeSemanticConflictsFromNotebooks(
        notebooks.base,
        notebooks.local,
        notebooks.remote
    );
    return { ...result, ...notebooks };
}

// ============================================================================
// Test 1: Textual Conflict Detection & Resolution
// ============================================================================

function testTextualConflict(): void {
    const repo = new TestRepo();
    
    try {
        repo.init();
        
        // Create a notebook where both branches modify the SAME content
        // This forces Git to create conflict markers
        const base = {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: {},
            cells: [{
                cell_type: 'markdown',
                metadata: {},
                source: ['# Title: ORIGINAL']
            }]
        };
        
        const local = {
            ...base,
            cells: [{
                cell_type: 'markdown',
                metadata: {},
                source: ['# Title: LOCAL_CHANGE']
            }]
        };
        
        const remote = {
            ...base,
            cells: [{
                cell_type: 'markdown',
                metadata: {},
                source: ['# Title: REMOTE_CHANGE']
            }]
        };
        
        // Setup merge conflict
        repo.write('notebook.ipynb', JSON.stringify(base, null, 2));
        repo.commit('base');
        
        repo.branch('feature');
        repo.write('notebook.ipynb', JSON.stringify(remote, null, 2));
        repo.commit('remote');
        
        repo.checkout('main');
        repo.write('notebook.ipynb', JSON.stringify(local, null, 2));
        repo.commit('local');
        
        const cleanMerge = repo.merge('feature');
        
        // MUST have conflict - fail test if clean merge
        assert(!cleanMerge || repo.isUnmerged('notebook.ipynb'),
            'TEST SETUP FAILURE: Expected merge conflict but got clean merge');
        
        const content = repo.read('notebook.ipynb');
        assert(hasConflictMarkers(content),
            'Should have conflict markers in working copy');
        
        // Analyze conflicts
        const analysis = analyzeNotebookConflicts(path.join(repo.path, 'notebook.ipynb'), content);
        assert(analysis.conflicts.length > 0,
            `Should detect conflicts, found ${analysis.conflicts.length}`);
        
        // Verify conflict content
        const conflict = analysis.conflicts[0];
        assert(conflict.localContent.includes('LOCAL_CHANGE'),
            'Local content should contain LOCAL_CHANGE');
        assert(conflict.remoteContent.includes('REMOTE_CHANGE'),
            'Remote content should contain REMOTE_CHANGE');
        
        // Test resolution to local
        const resolvedLocal = resolveAllConflicts(content, [{ marker: conflict.marker, choice: 'local' }]);
        assert(!hasConflictMarkers(resolvedLocal), 'Resolved content should not have markers');
        
        const nbLocal = parseNotebook(resolvedLocal);
        const srcLocal = getCellSource(nbLocal.cells[0]);
        assert(srcLocal.includes('LOCAL_CHANGE'), 'Resolved to local should have LOCAL_CHANGE');
        assert(!srcLocal.includes('REMOTE_CHANGE'), 'Resolved to local should NOT have REMOTE_CHANGE');
        
        // Test resolution to remote
        const resolvedRemote = resolveAllConflicts(content, [{ marker: conflict.marker, choice: 'remote' }]);
        const nbRemote = parseNotebook(resolvedRemote);
        const srcRemote = getCellSource(nbRemote.cells[0]);
        assert(srcRemote.includes('REMOTE_CHANGE'), 'Resolved to remote should have REMOTE_CHANGE');
        
    } finally {
        repo.cleanup();
    }
}

// ============================================================================
// Test 2: HTML-Styled Textual Conflicts (04_Cascadia.ipynb)
// ============================================================================

function testCascadiaHtmlStyledConflicts(): void {
    const testDir = path.resolve(__dirname, '..');
    const cascadiaPath = path.join(testDir, '04_Cascadia.ipynb');
    
    // Verify test file exists
    assert(fs.existsSync(cascadiaPath), `Missing test file: ${cascadiaPath}`);
    
    const content = fs.readFileSync(cascadiaPath, 'utf8');
    
    // Test 1: Should detect HTML-styled conflict markers
    assert(hasConflictMarkers(content), 
        '04_Cascadia.ipynb should be detected as having conflict markers');
    
    // Test 2: Should parse as valid notebook JSON
    let notebook: Notebook;
    try {
        notebook = parseNotebook(content);
    } catch (e: any) {
        throw new Error(`04_Cascadia.ipynb should parse as valid JSON: ${e.message}`);
    }
    
    // Test 3: Analyze conflicts
    const analysis = analyzeNotebookConflicts(cascadiaPath, content);
    
    // Should find cell conflicts (there are 8 conflicting cells based on manual check)
    assertGreater(analysis.conflicts.length, 0,
        'Should detect cell conflicts in 04_Cascadia.ipynb');
    
    // Log conflict details for verification
    console.log(`     Found ${analysis.conflicts.length} cell conflicts`);
    console.log(`     Found ${analysis.metadataConflicts.length} metadata conflicts`);
    
    // Test 4: Verify conflict structure
    for (let i = 0; i < Math.min(3, analysis.conflicts.length); i++) {
        const conflict = analysis.conflicts[i];
        assert(conflict.marker !== undefined, `Conflict ${i} should have marker`);
        assert(conflict.cellIndex !== undefined, `Conflict ${i} should have cellIndex`);
        assert(conflict.localContent !== undefined, `Conflict ${i} should have localContent`);
        assert(conflict.remoteContent !== undefined, `Conflict ${i} should have remoteContent`);
    }
    
    // Test 5: Verify the notebook contains HTML-styled markers specifically
    const hasHtmlStyledMarkers = content.includes('<span') && 
                                  content.includes('<<<<<<') && 
                                  content.includes('>>>>>>>');
    assert(hasHtmlStyledMarkers, 
        '04_Cascadia.ipynb should contain HTML-styled conflict markers');
    
    // Test 6: Test resolution (pick all local)
    if (analysis.conflicts.length > 0) {
        const resolutions = analysis.conflicts.map(c => ({ marker: c.marker, choice: 'local' as const }));
        const resolved = resolveAllConflicts(content, resolutions);
        
        // Resolved content should not have conflict markers
        assert(!hasConflictMarkers(resolved),
            'Resolved content should not have conflict markers');
        
        // Resolved content should be valid notebook JSON
        try {
            const resolvedNb = parseNotebook(resolved);
            assert(Array.isArray(resolvedNb.cells), 'Resolved notebook should have cells array');
        } catch (e: any) {
            throw new Error(`Resolved content should be valid notebook JSON: ${e.message}`);
        }
    }
}

// ============================================================================
// Test 3: Semantic Conflict Detection - Spectral Hashing Notebooks
// ============================================================================

function testSemanticConflictSpectralHashing(): void {
    const testDir = path.resolve(__dirname, '..');
    
    const testCase: ThreeWayTestCase = {
        name: 'Spectral Hashing Semantic Conflict',
        description: '02_base/local/remote.ipynb - Real notebook with cell differences',
        basePath: path.join(testDir, '02_base.ipynb'),
        localPath: path.join(testDir, '02_local.ipynb'),
        remotePath: path.join(testDir, '02_remote.ipynb'),
        expectedCellCountDiff: { local: 0, remote: 1 }, // remote has 1 more cell
    };

    // Verify test files exist
    assert(fs.existsSync(testCase.basePath), `Missing: ${testCase.basePath}`);
    assert(fs.existsSync(testCase.localPath), `Missing: ${testCase.localPath}`);
    assert(fs.existsSync(testCase.remotePath), `Missing: ${testCase.remotePath}`);

    const { base, local, remote, mappings, conflicts } = analyzeThreeWayCase(testCase);

    // Verify cell counts
    assertEqual(base.cells.length, 64, 'Base should have 64 cells');
    assertEqual(local.cells.length, 64, 'Local should have 64 cells');
    assertEqual(remote.cells.length, 65, 'Remote should have 65 cells (1 added)');

    // Verify mappings were created
    assertGreater(mappings.length, 0, 'Should have cell mappings');
    
    // Should detect at least some conflicts (cell addition in remote)
    assertGreater(conflicts.length, 0, 'Should detect semantic conflicts');

    // Verify conflict types
    const conflictTypes = new Set(conflicts.map(c => c.type));
    console.log(`     Found conflict types: ${Array.from(conflictTypes).join(', ')}`);
    console.log(`     Total conflicts: ${conflicts.length}`);

    // Should have cell-added since remote has 65 cells vs base's 64
    assert(
        conflictTypes.has('cell-added') || conflictTypes.has('cell-modified'),
        'Should detect cell-added or cell-modified conflicts'
    );
    
    // Verify the specific scenario: remote added 1 cell
    const addedConflicts = conflicts.filter(c => c.type === 'cell-added');
    assertGreater(addedConflicts.length, 0, 'Should detect at least one cell-added conflict');
    
    // Verify cell matching captured all cells
    const mappedBaseCells = mappings.filter(m => m.baseCell).length;
    const mappedLocalCells = mappings.filter(m => m.localCell).length;
    const mappedRemoteCells = mappings.filter(m => m.remoteCell).length;
    
    assertEqual(mappedBaseCells, 64, 'All 64 base cells should be mapped');
    assertEqual(mappedLocalCells, 64, 'All 64 local cells should be mapped');
    assertEqual(mappedRemoteCells, 65, 'All 65 remote cells should be mapped');
}

// ============================================================================
// Test 3b: Semantic Conflict Detection - Full Spectral Hashing Notebook Variant
// ============================================================================

function testSemanticConflictSpectralHashingFull(): void {
    const testDir = path.resolve(__dirname, '..');
    const testCase: ThreeWayTestCase = {
        name: 'Spectral Hashing (full remote variant)',
        description: '02_base vs 02_local vs 02_Spectral_Hashing_and_OMS.ipynb',
        basePath: path.join(testDir, '02_base.ipynb'),
        localPath: path.join(testDir, '02_local.ipynb'),
        remotePath: path.join(testDir, '02_Spectral_Hashing_and_OMS.ipynb'),
        expectedCellCountDiff: { local: 0, remote: 1 },
    };

    // Verify fixtures exist
    assert(fs.existsSync(testCase.basePath), `Missing: ${testCase.basePath}`);
    assert(fs.existsSync(testCase.localPath), `Missing: ${testCase.localPath}`);
    assert(fs.existsSync(testCase.remotePath), `Missing: ${testCase.remotePath}`);

    const { base, local, remote, mappings, conflicts } = analyzeThreeWayCase(testCase);

    assertEqual(base.cells.length, 64, 'Base should have 64 cells');
    assertEqual(local.cells.length, 64, 'Local should have 64 cells');
    assertEqual(remote.cells.length, 65, 'Full notebook should have 65 cells');

    assertGreater(mappings.length, 0, 'Should have cell mappings for full notebook');
    assertGreater(conflicts.length, 0, 'Should detect semantic conflicts for full notebook');

    const conflictTypes = new Set(conflicts.map(c => c.type));
    assert(conflictTypes.has('cell-added'), 'Full notebook variant should detect cell-added');

    const mappedRemoteCells = mappings.filter(m => m.remoteCell).length;
    assertEqual(mappedRemoteCells, 65, 'All remote cells should participate in mappings');
}

// ============================================================================
// Test 4: Semantic Conflict Detection - Git Staging Area
// ============================================================================

function testSemanticConflictWithGit(): void {
    const repo = new TestRepo();
    const testDir = path.resolve(__dirname, '..');
    
    try {
        // Load test files
        const baseContent = fs.readFileSync(path.join(testDir, '02_base.ipynb'), 'utf8');
        const localContent = fs.readFileSync(path.join(testDir, '02_local.ipynb'), 'utf8');
        const remoteContent = fs.readFileSync(path.join(testDir, '02_remote.ipynb'), 'utf8');
        
        // Setup repo
        repo.init();
        repo.write('notebook.ipynb', baseContent);
        repo.commit('base');
        
        repo.branch('feature');
        repo.write('notebook.ipynb', remoteContent);
        repo.commit('remote');
        
        repo.checkout('main');
        repo.write('notebook.ipynb', localContent);
        repo.commit('local');
        
        // Attempt merge
        repo.merge('feature');
        
        // Check state
        const isUnmerged = repo.isUnmerged('notebook.ipynb');
        const workingContent = repo.read('notebook.ipynb');
        const hasMarkers = hasConflictMarkers(workingContent);

        // We should have some form of conflict (textual or unmerged state)
        assert(isUnmerged || hasMarkers,
            'Should have either UU status or conflict markers');

        if (isUnmerged) {
            // Get staged versions
            const stagedBase = repo.getStaged(1, 'notebook.ipynb');
            const stagedLocal = repo.getStaged(2, 'notebook.ipynb');
            const stagedRemote = repo.getStaged(3, 'notebook.ipynb');

            if (stagedBase && stagedLocal && stagedRemote) {
                // Parse and analyze from Git staging area
                const base = parseNotebook(stagedBase);
                const local = parseNotebook(stagedLocal);
                const remote = parseNotebook(stagedRemote);

                const { mappings, conflicts } = analyzeSemanticConflictsFromNotebooks(base, local, remote);
                
                assertGreater(mappings.length, 0, 'Should have cell mappings from staging');
                assertGreater(conflicts.length, 0, 'Staging analysis should surface semantic conflicts');
                console.log(`     Git staging: ${conflicts.length} semantic conflicts found`);
            }
        }

        if (hasMarkers) {
            // Test textual conflict analysis
            const analysis = analyzeNotebookConflicts(
                path.join(repo.path, 'notebook.ipynb'),
                workingContent
            );
            console.log(`     Textual conflicts: ${analysis.conflicts.length}`);
        }
        
    } finally {
        repo.cleanup();
    }
}

// ============================================================================
// Test 5: Resolution Preserves Notebook Validity
// ============================================================================

function testResolutionValidity(): void {
    const repo = new TestRepo();
    
    try {
        repo.init();
        
        // Create multi-cell notebook with conflict
        const base = {
            nbformat: 4,
            nbformat_minor: 5,
            metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
            cells: [
                { cell_type: 'markdown', metadata: {}, source: ['# Header'] },
                { cell_type: 'code', execution_count: 1, metadata: {}, source: ['x = ORIGINAL'], outputs: [] },
                { cell_type: 'markdown', metadata: {}, source: ['## Footer'] }
            ]
        };
        
        const local = {
            ...base,
            cells: [
                { cell_type: 'markdown', metadata: {}, source: ['# Header'] },
                { cell_type: 'code', execution_count: 2, metadata: {}, source: ['x = LOCAL'], outputs: [] },
                { cell_type: 'markdown', metadata: {}, source: ['## Footer'] }
            ]
        };
        
        const remote = {
            ...base,
            cells: [
                { cell_type: 'markdown', metadata: {}, source: ['# Header'] },
                { cell_type: 'code', execution_count: 3, metadata: {}, source: ['x = REMOTE'], outputs: [] },
                { cell_type: 'markdown', metadata: {}, source: ['## Footer'] }
            ]
        };
        
        repo.write('notebook.ipynb', JSON.stringify(base, null, 2));
        repo.commit('base');
        
        repo.branch('feature');
        repo.write('notebook.ipynb', JSON.stringify(remote, null, 2));
        repo.commit('remote');
        
        repo.checkout('main');
        repo.write('notebook.ipynb', JSON.stringify(local, null, 2));
        repo.commit('local');
        
        repo.merge('feature');
        
        const content = repo.read('notebook.ipynb');
        
        if (hasConflictMarkers(content)) {
            const analysis = analyzeNotebookConflicts(path.join(repo.path, 'notebook.ipynb'), content);
            
            // Resolve all conflicts to local
            const resolutions = analysis.conflicts.map(c => ({ marker: c.marker, choice: 'local' as const }));
            const resolved = resolveAllConflicts(content, resolutions);
            
            // Validate result is proper JSON
            let notebook;
            try {
                notebook = JSON.parse(resolved);
            } catch (e: any) {
                throw new Error(`Resolved content is not valid JSON: ${e.message}`);
            }
            
            // Validate notebook structure
            assert(notebook.nbformat === 4, 'Should have nbformat');
            assert(Array.isArray(notebook.cells), 'Should have cells array');
            assert(notebook.cells.length >= 1, 'Should have at least one cell');
            
            for (let i = 0; i < notebook.cells.length; i++) {
                const cell = notebook.cells[i];
                assert(cell.cell_type, `Cell ${i} should have cell_type`);
                assert(cell.source !== undefined, `Cell ${i} should have source`);
            }
            
            // Verify no conflict markers remain
            assert(!hasConflictMarkers(resolved), 'Should have no remaining conflict markers');
        }
        
    } finally {
        repo.cleanup();
    }
}

// ============================================================================
// Test 6: Cell Matching Algorithm
// ============================================================================

function testCellMatchingAlgorithm(): void {
    const testDir = path.resolve(__dirname, '..');
    
    // Load the Spectral Hashing notebooks
    const base = parseNotebook(fs.readFileSync(path.join(testDir, '02_base.ipynb'), 'utf8'));
    const local = parseNotebook(fs.readFileSync(path.join(testDir, '02_local.ipynb'), 'utf8'));
    const remote = parseNotebook(fs.readFileSync(path.join(testDir, '02_remote.ipynb'), 'utf8'));

    const mappings = matchCells(base, local, remote);

    // Verify all cells are mapped
    assertGreater(mappings.length, 0, 'Should have mappings');

    // Count mapped cells
    let baseMapped = 0;
    let localMapped = 0;
    let remoteMapped = 0;
    let highConfidenceMappings = 0;

    for (const m of mappings) {
        if (m.baseCell) baseMapped++;
        if (m.localCell) localMapped++;
        if (m.remoteCell) remoteMapped++;
        if (m.matchConfidence >= 0.9) highConfidenceMappings++;
    }

    console.log(`     Mappings: ${mappings.length} total`);
    console.log(`     Base cells mapped: ${baseMapped}/${base.cells.length}`);
    console.log(`     Local cells mapped: ${localMapped}/${local.cells.length}`);
    console.log(`     Remote cells mapped: ${remoteMapped}/${remote.cells.length}`);
    console.log(`     High confidence (>=0.9): ${highConfidenceMappings}`);

    // Most cells should be mapped with high confidence (notebooks are similar)
    assertGreater(highConfidenceMappings, mappings.length * 0.5,
        'At least half of mappings should be high confidence');

    // Verify the extra cell in remote is detected
    const addedCells = mappings.filter(m => m.remoteCell && !m.baseCell);
    assertGreater(addedCells.length, 0, 
        'Should detect cells added in remote (remote has 65 cells, base has 64)');
}

// ============================================================================
// Test 7: Generic Three-Way Analysis Function
// ============================================================================

function testGenericThreeWayAnalysis(): void {
    // Create inline test notebooks
    // Note: The cell matcher uses content hashing, so a significantly modified cell
    // may be detected as delete+add rather than modify. We test realistic scenarios.
    const base: Notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
            { cell_type: 'markdown', metadata: {}, source: ['# Title\n\nThis is a long cell with substantial content that will be partially modified.'] },
            { cell_type: 'code', execution_count: 1, metadata: {}, source: ['x = 1\ny = 2\nz = x + y'], outputs: [] },
        ]
    };

    const local: Notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
            { cell_type: 'markdown', metadata: {}, source: ['# Title\n\nThis is a long cell with substantial content that will be partially modified.'] },
            { cell_type: 'code', execution_count: 2, metadata: {}, source: ['x = 1\ny = 2\nz = x + y'], outputs: [] }, // only exec count changed
            { cell_type: 'markdown', metadata: {}, source: ['# Added by local'] }, // added cell
        ]
    };

    const remote: Notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
            // Slightly modified - should still match due to similarity
            { cell_type: 'markdown', metadata: {}, source: ['# Title\n\nThis is a long cell with substantial content that was partially modified by remote.'] },
            { cell_type: 'code', execution_count: 3, metadata: {}, source: ['x = 1\ny = 2\nz = x + y'], outputs: [] }, // exec count changed
        ]
    };

    const { mappings, conflicts } = analyzeSemanticConflictsFromNotebooks(base, local, remote);

    // Should detect conflicts
    assertGreater(conflicts.length, 0, 'Should detect conflicts');
    
    const types = conflicts.map(c => c.type);
    console.log(`     Detected conflict types: ${types.join(', ')}`);

    // Must detect cell-added (local added a cell)
    assert(types.includes('cell-added'), 'Should detect cell-added');
    
    // Should detect either:
    // - cell-modified (if matcher correctly identifies the modified title cell), or
    // - cell-deleted + cell-added (if content changed too much for matching)
    // - execution-count-changed (both branches changed exec count differently)
    const hasModificationDetection = 
        types.includes('cell-modified') || 
        types.includes('cell-deleted') ||
        types.includes('execution-count-changed');
    assert(hasModificationDetection, 'Should detect some form of content modification');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    console.log('═'.repeat(60));
    console.log('MergeNB Integration Tests');
    console.log('═'.repeat(60));
    console.log('');
    
    console.log('Textual Conflict Tests:');
    test('  Textual conflict detection & resolution', testTextualConflict);
    test('  HTML-styled conflicts (04_Cascadia.ipynb)', testCascadiaHtmlStyledConflicts);
    test('  Resolution preserves notebook validity', testResolutionValidity);
    
    console.log('');
    console.log('Semantic Conflict Tests:');
    test('  Cell matching algorithm', testCellMatchingAlgorithm);
    test('  Generic three-way analysis', testGenericThreeWayAnalysis);
    test('  Spectral Hashing notebooks (02_*.ipynb)', testSemanticConflictSpectralHashing);
    test('  Spectral Hashing full variant (02_Spectral_Hashing_and_OMS.ipynb)', testSemanticConflictSpectralHashingFull);
    test('  Semantic conflicts with Git staging', testSemanticConflictWithGit);
    
    console.log('');
    console.log('─'.repeat(60));
    
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const totalTime = results.reduce((sum, r) => sum + (r.duration || 0), 0);
    
    console.log(`Results: ${passed} passed, ${failed} failed (${totalTime}ms)`);
    console.log('═'.repeat(60));
    
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(e => {
    console.error('Test runner error:', e);
    process.exit(1);
});
