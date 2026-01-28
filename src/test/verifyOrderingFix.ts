/**
 * Standalone test for cell ordering bug fix
 * Run with: npx ts-node src/test/verifyOrderingFix.ts
 */

import { matchCells } from '../cellMatcher';
import { Notebook, NotebookCell } from '../types';

// Create test cells
function createCell(source: string, cellType: 'markdown' | 'code' = 'markdown'): NotebookCell {
    return {
        cell_type: cellType,
        source: [source],
        metadata: {}
    } as NotebookCell;
}

console.log('=== Testing Cell Ordering Bug Fix ===\n');

// Test scenario from the bug report:
// In incoming branch, a NEW cell is inserted at position 16,
// pushing the existing cell down to position 17
const base: Notebook = {
    cells: [
        createCell('Cell 15'),
        createCell('This clearly demonstrates why we need a smaller bin size...'), // index 1 (16 in real file)
        createCell('Cell 17'),
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 0
};

const current: Notebook = {
    cells: [
        createCell('Cell 15'),
        createCell('This clearly demonstrates why we need a smaller bin size...'), // index 1 (unchanged)
        createCell('Cell 17'),
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 0
};

const incoming: Notebook = {
    cells: [
        createCell('Cell 15'),
        createCell('#### Why "collision rate between spectrum pairs"?'), // index 1 (NEW cell inserted)
        createCell('This demonstrates why we need a smaller bin size...'), // index 2 (modified, moved down)
        createCell('Cell 17'),
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 0
};

console.log('Scenario:');
console.log('  Base[1]:     "This clearly demonstrates..."');
console.log('  Current[1]:  "This clearly demonstrates..." (unchanged)');
console.log('  Incoming[1]: "#### Why..." (NEW cell)');
console.log('  Incoming[2]: "This demonstrates..." (modified)\n');

const mappings = matchCells(base, current, incoming);

console.log('Cell Mappings (showing indices):');
mappings.forEach((mapping, idx) => {
    const baseIdx = mapping.baseIndex !== undefined ? String(mapping.baseIndex) : '-';
    const currentIdx = mapping.currentIndex !== undefined ? String(mapping.currentIndex) : '-';
    const incomingIdx = mapping.incomingIndex !== undefined ? String(mapping.incomingIndex) : '-';
    
    console.log(`  [${idx}] base=${baseIdx.padStart(2)}, current=${currentIdx.padStart(2)}, incoming=${incomingIdx.padStart(2)}`);
});

// Find the mappings for the cells in question
const newCellMapping = mappings.find(m => m.incomingIndex === 1 && m.baseIndex === undefined);
const movedCellMapping = mappings.find(m => m.baseIndex === 1);

console.log('\n=== KEY CELLS ===');
console.log('NEW cell (incoming[1] only):');
console.log(`  Source: "${newCellMapping?.incomingCell?.source[0]?.substring(0, 50)}"`);
console.log(`  Position in result: ${mappings.indexOf(newCellMapping!)}`);

console.log('\nMOVED cell (base[1]/current[1]/incoming[2]):');
console.log(`  Source: "${movedCellMapping?.incomingCell?.source[0]?.substring(0, 50)}"`);
console.log(`  Position in result: ${mappings.indexOf(movedCellMapping!)}`);

// Check ordering
const newCellIndex = mappings.indexOf(newCellMapping!);
const movedCellIndex = mappings.indexOf(movedCellMapping!);

console.log('\n=== RESULT ===');
if (newCellIndex < movedCellIndex) {
    console.log('✓ PASS: NEW cell comes BEFORE moved cell (correct order)');
    console.log(`  Order: position ${newCellIndex} < position ${movedCellIndex}`);
    process.exit(0);
} else {
    console.log('✗ FAIL: NEW cell comes AFTER moved cell (BUG!)');
    console.log(`  Order: position ${newCellIndex} >= position ${movedCellIndex}`);
    process.exit(1);
}
