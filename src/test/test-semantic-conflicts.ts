#!/usr/bin/env ts-node
/**
 * Test script for semantic conflict detection
 * Run with: npx ts-node src/test/test-semantic-conflicts.ts
 */

import { detectSemanticConflicts } from '../conflictDetector';
import * as path from 'path';

async function main() {
    console.log('Testing Semantic Conflict Detection\n');
    console.log('=====================================\n');

    // Test with the 02_Spectral_Hashing_and_OMS.ipynb file
    // This file should have base, local, and remote versions available
    const testFile = path.resolve(__dirname, '02_Spectral_Hashing_and_OMS.ipynb');
    
    console.log(`Testing file: ${testFile}\n`);

    try {
        const result = await detectSemanticConflicts(testFile);
        
        if (!result) {
            console.log('❌ No semantic conflicts detected (file may not be in unmerged state)');
            console.log('\nTo test semantic conflict detection:');
            console.log('1. Create a merge conflict: git merge <branch>');
            console.log('2. Stage the conflicted notebook without resolving markers');
            console.log('3. Run this test again');
            return;
        }

        console.log('✅ Semantic conflict detected!\n');
        
        console.log(`File: ${result.filePath}`);
        console.log(`Has textual conflicts: ${result.hasTextualConflicts}`);
        console.log(`Branch info: ${result.localBranch} ← ${result.remoteBranch}\n`);

        console.log('Cell counts:');
        console.log(`  Base:   ${result.base?.cells.length || 0} cells`);
        console.log(`  Local:  ${result.local?.cells.length || 0} cells`);
        console.log(`  Remote: ${result.remote?.cells.length || 0} cells\n`);

        console.log(`Found ${result.semanticConflicts.length} semantic conflict(s):\n`);

        // Group conflicts by type
        const conflictsByType = new Map<string, number>();
        for (const conflict of result.semanticConflicts) {
            conflictsByType.set(conflict.type, (conflictsByType.get(conflict.type) || 0) + 1);
        }

        for (const [type, count] of conflictsByType) {
            console.log(`  • ${count}× ${type.replace(/-/g, ' ')}`);
        }

        console.log('\nDetailed conflicts:\n');
        for (let i = 0; i < Math.min(5, result.semanticConflicts.length); i++) {
            const conflict = result.semanticConflicts[i];
            console.log(`${i + 1}. ${conflict.type}`);
            if (conflict.description) {
                console.log(`   ${conflict.description}`);
            }
            console.log(`   Base: ${conflict.baseCellIndex ?? 'N/A'}, Local: ${conflict.localCellIndex ?? 'N/A'}, Remote: ${conflict.remoteCellIndex ?? 'N/A'}`);
            console.log('');
        }

        if (result.semanticConflicts.length > 5) {
            console.log(`   ... and ${result.semanticConflicts.length - 5} more conflicts\n`);
        }

        console.log('Cell mappings:');
        console.log(`  Total mappings: ${result.cellMappings.length}`);
        console.log(`  High confidence: ${result.cellMappings.filter(m => m.matchConfidence >= 0.9).length}`);
        console.log(`  Medium confidence: ${result.cellMappings.filter(m => m.matchConfidence >= 0.7 && m.matchConfidence < 0.9).length}`);
        console.log(`  Low confidence: ${result.cellMappings.filter(m => m.matchConfidence < 0.7).length}`);

    } catch (error) {
        console.error('❌ Error during testing:', error);
        if (error instanceof Error) {
            console.error(error.stack);
        }
    }
}

main().catch(console.error);
