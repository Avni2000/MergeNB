/**
 * @file syntaxHighlighting.test.ts
 * @description Integration test verifying that the resolved-content editor renders
 * with CodeMirror syntax highlighting for Python cells.
 *
 * Checks:
 * 1. The textarea has been replaced by a .cm-editor element.
 * 2. At least one .tok-keyword span exists inside the editor (confirms the Python
 *    language extension was applied and the code was actually parsed).
 * 3. The keyword span text matches a real Python keyword (def/return/import/etc.).
 */

import * as vscode from 'vscode';
import { readTestConfig, setupConflictResolver } from './testHarness';

export async function run(): Promise<void> {
    console.log('Starting syntax highlighting integration test...');

    let browser: import('playwright').Browser | undefined;
    let page: import('playwright').Page | undefined;

    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousAutoResolveExecutionCount = mergeNBConfig.get<boolean>('autoResolve.executionCount');
    const previousStripOutputs = mergeNBConfig.get<boolean>('autoResolve.stripOutputs');

    try {
        await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);

        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        // ── 1. Find the first conflict row ──────────────────────────────────────
        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRows.count();
        if (conflictCount === 0) {
            throw new Error('Expected at least one conflict row in the syntax fixture');
        }
        const firstRow = conflictRows.first();

        // ── 2. Select "Use Current" so the resolved editor appears ───────────────
        const useCurrentBtn = firstRow.locator('button', { hasText: 'Use Current' });
        await useCurrentBtn.waitFor({ timeout: 10_000 });
        await useCurrentBtn.click();

        const resolvedCell = firstRow.locator('.resolved-cell');
        await resolvedCell.waitFor({ timeout: 10_000 });
        console.log('✓ Resolved cell appeared after clicking Use Current');

        // ── 3. Assert CodeMirror editor is present (textarea was replaced) ────────
        const textarea = resolvedCell.locator('textarea.resolved-content-input');
        const textareaCount = await textarea.count();
        if (textareaCount > 0) {
            throw new Error(
                'Found a <textarea class="resolved-content-input"> — CodeMirror editor did NOT replace the textarea'
            );
        }

        const cmEditor = resolvedCell.locator('.cm-editor');
        await cmEditor.waitFor({ timeout: 10_000 });
        console.log('✓ .cm-editor element is present (textarea replaced by CodeMirror)');

        // ── 4. Assert syntax-highlighted keyword tokens appear ───────────────────
        // classHighlighter (added alongside the language pack) produces .tok-keyword spans
        // for Python keywords like def/return/import/if/for.
        // We give it up to 8 s for the async language pack to load and the editor to re-parse.
        const keywordSpan = cmEditor.locator('.tok-keyword').first();
        await keywordSpan.waitFor({ timeout: 8_000 });

        // Verify it actually has a color style applied
        const color = await keywordSpan.evaluate(
        el => window.getComputedStyle(el).color
        );

        console.log(`Found .tok-keyword span with color: ${color}`);
        if (color === 'rgb(239, 231, 219)') {
            throw new Error(
                `.tok-keyword exists but has no highlight color applied (got: ${color}) — theme extension missing`
        );
        }
        console.log(`✓ Keyword span has color: ${color}`);
        // ── 5. Spot-check the keyword text is a real Python keyword ──────────────
        const PYTHON_KEYWORDS = new Set(['def', 'return', 'import', 'from', 'if', 'else', 'for',
            'while', 'class', 'with', 'as', 'in', 'not', 'and', 'or', 'True', 'False', 'None',
            'pass', 'break', 'continue', 'yield', 'lambda', 'try', 'except', 'raise', 'finally']);

        const allKeywordSpans = cmEditor.locator('.tok-keyword');
        const spanCount = await allKeywordSpans.count();
        let foundRealKeyword = false;
        for (let i = 0; i < spanCount; i++) {
            const text = ((await allKeywordSpans.nth(i).textContent()) ?? '').trim();
            if (PYTHON_KEYWORDS.has(text)) {
                foundRealKeyword = true;
                console.log(`✓ Confirmed real Python keyword: "${text}"`);
                break;
            }
        }
        if (!foundRealKeyword) {
            const allTexts = await Promise.all(
                Array.from({ length: spanCount }, (_, i) =>
                    allKeywordSpans.nth(i).textContent().then(t => t?.trim() ?? '')
                )
            );
            throw new Error(
                `No .tok-keyword span matched a known Python keyword. Found: [${allTexts.join(', ')}]`
            );
        }

        console.log('✓ Syntax highlighting test passed');
    } finally {
        try {
            await mergeNBConfig.update('autoResolve.executionCount', previousAutoResolveExecutionCount, vscode.ConfigurationTarget.Workspace);
        } catch { /* ignore */ }
        try {
            await mergeNBConfig.update('autoResolve.stripOutputs', previousStripOutputs, vscode.ConfigurationTarget.Workspace);
        } catch { /* ignore */ }

        if (page) {
            try { await page.close(); } catch { /* ignore */ }
        }
        if (browser) {
            try { await browser.close(); } catch { /* ignore */ }
        }
    }
}
