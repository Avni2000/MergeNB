#!/usr/bin/env npx ts-node
/**
 * CLI test script for MergeNB conflict detection and resolution
 * Run with: npx ts-node src/test/cli-test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { hasConflictMarkers, analyzeNotebookConflicts, resolveAllConflicts } from '../conflictDetector';

const testDir = path.dirname(__filename);

function testFile(filename: string, expectedConflicts: number, description: string) {
    const filepath = path.join(testDir, filename);
    
    if (!fs.existsSync(filepath)) {
        console.log(`⚠️  SKIP: ${filename} - file not found`);
        return;
    }
    
    const content = fs.readFileSync(filepath, 'utf8');
    console.log(`\n📁 Testing: ${filename}`);
    console.log(`   ${description}`);
    
    // Test detection
    const detected = hasConflictMarkers(content);
    console.log(`   Detected conflicts: ${detected ? '✅ Yes' : '❌ No'}`);
    
    if (!detected && expectedConflicts > 0) {
        console.log(`   ❌ FAIL: Expected to detect conflicts but didn't!`);
        return;
    }
    
    // Test analysis
    const analysis = analyzeNotebookConflicts(filepath, content);
    console.log(`   Found ${analysis.conflicts.length} conflict region(s)`);
    
    if (analysis.conflicts.length !== expectedConflicts) {
        console.log(`   ⚠️  WARNING: Expected ${expectedConflicts}, found ${analysis.conflicts.length}`);
    }
    
    for (let i = 0; i < analysis.conflicts.length; i++) {
        const c = analysis.conflicts[i];
        const isCellLevel = c.marker.start > 0;
        console.log(`   Conflict ${i + 1}:`);
        console.log(`     Type: ${isCellLevel ? 'cell-level' : 'inline'}`);
        if (isCellLevel) {
            console.log(`     Cells ${c.marker.start + 1} → ${c.marker.end + 1}`);
        } else {
            console.log(`     Cell ${c.cellIndex + 1}, field: ${c.field}`);
        }
        console.log(`     Local: ${c.localContent.substring(0, 50).replace(/\n/g, '\\n')}...`);
        console.log(`     Remote: ${c.remoteContent.substring(0, 50).replace(/\n/g, '\\n')}...`);
    }
    
    // Test resolution
    if (analysis.conflicts.length > 0) {
        // Test local resolution
        const localRes = analysis.conflicts.map(c => ({
            marker: c.marker,
            choice: 'local' as const
        }));
        
        try {
            const resolvedLocal = resolveAllConflicts(content, localRes);
            const stillHasConflicts = hasConflictMarkers(resolvedLocal);
            console.log(`   Resolution (local): ${stillHasConflicts ? '❌ Still has conflicts!' : '✅ Clean'}`);
            
            // Verify it's valid JSON
            JSON.parse(resolvedLocal);
            console.log(`   JSON valid: ✅ Yes`);
        } catch (e) {
            console.log(`   Resolution (local): ❌ Error: ${e}`);
        }
        
        // Test remote resolution
        const remoteRes = analysis.conflicts.map(c => ({
            marker: c.marker,
            choice: 'remote' as const
        }));
        
        try {
            const resolvedRemote = resolveAllConflicts(content, remoteRes);
            const stillHasConflicts = hasConflictMarkers(resolvedRemote);
            console.log(`   Resolution (remote): ${stillHasConflicts ? '❌ Still has conflicts!' : '✅ Clean'}`);
            
            // Verify it's valid JSON  
            JSON.parse(resolvedRemote);
            console.log(`   JSON valid: ✅ Yes`);
        } catch (e) {
            console.log(`   Resolution (remote): ❌ Error: ${e}`);
        }
    }
}

console.log('='.repeat(60));
console.log('MergeNB Conflict Detection & Resolution Tests');
console.log('='.repeat(60));

// Test files
testFile('04_Cascadia.ipynb', 1, 'Cell-level conflicts with HTML-styled markers');
testFile('real-conflict.ipynb', 1, 'Raw Git conflict markers that break JSON');
testFile('02_Spectral_Hashing_and_OMS.ipynb', 0, 'No conflicts expected');
testFile('test-file.ipynb', 2, 'Inline conflicts in cell source with output conflicts');

console.log('\n' + '='.repeat(60));
console.log('Tests complete!');
console.log('='.repeat(60));
