/**
 * Test with real notebooks from the bug report
 * Run with: npx ts-node src/test/verifyRealNotebooks.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { matchCells } from '../cellMatcher';
import { Notebook } from '../types';

console.log('=== Testing with Real Notebooks ===\n');

// Load the actual notebooks
const testDir = path.join(__dirname, '../../src/test');
const basePath = path.join(testDir, '02_base.ipynb');
const currentPath = path.join(testDir, '02_current.ipynb');
const incomingPath = path.join(testDir, '02_incoming.ipynb');

const base: Notebook = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const current: Notebook = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
const incoming: Notebook = JSON.parse(fs.readFileSync(incomingPath, 'utf8'));

console.log(`Loaded notebooks:`);
console.log(`  Base:     ${base.cells.length} cells`);
console.log(`  Current:  ${current.cells.length} cells`);
console.log(`  Incoming: ${incoming.cells.length} cells\n`);

// Match cells
const mappings = matchCells(base, current, incoming);

console.log(`Generated ${mappings.length} cell mappings\n`);

// Find the specific cells mentioned in the bug report
// Looking for:
// - Incoming[16]: "#### Why "collision rate between spectrum pairs"?" (NEW)
// - Base[16]/Current[16]: "This clearly demonstrates..." 
// - Incoming[17]: "This demonstrates..." (modified version)

console.log('Searching for the cells mentioned in the bug report...\n');

// Find incoming cell 16 (the new cell)
const incomingCell16 = incoming.cells[16];
const incomingCell16Src = Array.isArray(incomingCell16.source) ? incomingCell16.source.join('') : incomingCell16.source;
console.log(`Incoming[16]: "${incomingCell16Src.substring(0, 60)}..."`);

// Find incoming cell 17 (the moved cell)
const incomingCell17 = incoming.cells[17];
const incomingCell17Src = Array.isArray(incomingCell17.source) ? incomingCell17.source.join('') : incomingCell17.source;
console.log(`Incoming[17]: "${incomingCell17Src.substring(0, 60)}..."`);

// Find base/current cell 16
const baseCell16 = base.cells[16];
const baseCell16Src = Array.isArray(baseCell16.source) ? baseCell16.source.join('') : baseCell16.source;
console.log(`Base[16]:     "${baseCell16Src.substring(0, 60)}..."\n`);

// Find these cells in the mappings
const newCellMapping = mappings.find(m => m.incomingIndex === 16 && m.baseIndex === undefined);
const movedCellMapping = mappings.find(m => m.baseIndex === 16 && m.incomingIndex === 17);

if (!newCellMapping) {
    console.log('ERROR: Could not find mapping for NEW cell (incoming[16])');
    process.exit(1);
}

if (!movedCellMapping) {
    console.log('ERROR: Could not find mapping for MOVED cell (base[16]/incoming[17])');
    process.exit(1);
}

const newCellPosition = mappings.indexOf(newCellMapping);
const movedCellPosition = mappings.indexOf(movedCellMapping);

console.log('=== CELL POSITIONS IN SORTED MAPPINGS ===');
console.log(`NEW cell (incoming[16] only):`);
console.log(`  Position: ${newCellPosition}`);
console.log(`  Source: "${incomingCell16Src.substring(0, 60)}..."`);

console.log(`\nMOVED cell (base[16]/current[16]/incoming[17]):`);
console.log(`  Position: ${movedCellPosition}`);
console.log(`  Source: "${incomingCell17Src.substring(0, 60)}..."`);

console.log('\n=== RESULT ===');
if (newCellPosition < movedCellPosition) {
    console.log(`✓ PASS: NEW cell (pos ${newCellPosition}) comes BEFORE moved cell (pos ${movedCellPosition})`);
    console.log('The bug is FIXED! Cells appear in the correct order.');
    process.exit(0);
} else {
    console.log(`✗ FAIL: NEW cell (pos ${newCellPosition}) comes AFTER moved cell (pos ${movedCellPosition})`);
    console.log('The bug is NOT fixed. Cells are still in wrong order.');
    process.exit(1);
}
