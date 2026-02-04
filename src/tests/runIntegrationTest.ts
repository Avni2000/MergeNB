/**
 * @file runIntegrationTest.ts
 * @description Runner script that launches VS Code with the extension and runs the integration test.
 * 
 * This script:
 * 1. Creates a git repo with merge conflicts (like simulate_merge_uu.sh)
 * 2. Launches VS Code with the extension loaded
 * 3. Runs the test suite inside the VS Code extension host
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

/** Helper to run git commands */
function git(cwd: string, ...args: string[]): string {
    const cmd = `git ${args.join(' ')}`;
    try {
        return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error: any) {
        // Some git commands exit non-zero but are still useful (e.g., merge with conflicts)
        return error.stdout || '';
    }
}

/** Create a temporary git repo with merge conflicts */
function createMergeConflictRepo(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergeNB-integration-'));
    
    const testDir = path.resolve(__dirname, '../../test');
    const baseFile = path.join(testDir, '02_base.ipynb');
    const currentFile = path.join(testDir, '02_current.ipynb');
    const incomingFile = path.join(testDir, '02_incoming.ipynb');
    
    // Initialize git repo
    git(tmpDir, 'init');
    git(tmpDir, 'config', 'user.email', '"test@mergenb.test"');
    git(tmpDir, 'config', 'user.name', '"MergeNB Test"');
    
    // Create base commit
    fs.copyFileSync(baseFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"base"');
    
    const baseBranch = git(tmpDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    
    // Create current branch
    git(tmpDir, 'checkout', '-b', 'current');
    fs.copyFileSync(currentFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"current"');
    
    // Create incoming branch
    git(tmpDir, 'checkout', baseBranch);
    git(tmpDir, 'checkout', '-b', 'incoming');
    fs.copyFileSync(incomingFile, path.join(tmpDir, 'conflict.ipynb'));
    git(tmpDir, 'add', 'conflict.ipynb');
    git(tmpDir, 'commit', '-m', '"incoming"');
    
    // Merge to create conflict
    git(tmpDir, 'checkout', 'current');
    git(tmpDir, 'merge', 'incoming');
    
    return tmpDir;
}

async function main() {
    let testWorkspacePath: string | undefined;
    
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../..');
        const extensionTestsPath = path.resolve(__dirname, './vscodeIntegration.test.js');
        
        // Create the merge conflict repo
        testWorkspacePath = createMergeConflictRepo();
        console.log(`Created test workspace at: ${testWorkspacePath}`);
        
        // Write workspace path to a temp file so the test can read it
        const configPath = path.join(os.tmpdir(), 'mergenb-test-config.json');
        fs.writeFileSync(configPath, JSON.stringify({ workspacePath: testWorkspacePath }));
        
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                testWorkspacePath,
                '--disable-extensions', // Disable other extensions
                '--skip-welcome',
                '--skip-release-notes',
            ],
        });
        
        // Cleanup
        fs.rmSync(testWorkspacePath, { recursive: true, force: true });
        fs.unlinkSync(configPath);
        
    } catch (err) {
        console.error('Failed to run tests:', err);
        // Cleanup on failure too
        if (testWorkspacePath) {
            try {
                fs.rmSync(testWorkspacePath, { recursive: true, force: true });
            } catch { /* ignore */ }
        }
        process.exit(1);
    }
}

main();
