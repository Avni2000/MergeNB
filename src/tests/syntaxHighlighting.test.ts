/**
 * @file syntaxHighlighting.test.ts
 * @description Integration test verifying that the resolved-content editor renders
 * with CodeMirror syntax highlighting for Python cells.
 *
 * Checks:
 * 1. The textarea has been replaced by a .cm-editor element.
 * 2. At least one syntax-highlighted span exists inside the editor (confirms the Python
 *    language extension was applied and the code was actually parsed).
 * 3. The highlighted span text matches a real Python keyword (def/return/import/etc.).
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
        // We give it up to 8 s for the async language pack to load and the editor to re-parse.
        const PYTHON_KEYWORDS = ['def', 'return', 'import', 'from', 'if', 'else', 'for',
            'while', 'class', 'with', 'as', 'in', 'not', 'and', 'or', 'True', 'False', 'None',
            'pass', 'break', 'continue', 'yield', 'lambda', 'try', 'except', 'raise', 'finally'];

        const keywordInfoHandle = await page.waitForFunction(
            (keywords) => {
                const content = document.querySelector(
                    '.merge-row.conflict-row .resolved-cell .cm-editor .cm-content'
                );
                if (!content) return null;
                const defaultColor = getComputedStyle(content).color;
                const spans = content.querySelectorAll('span');
                for (let i = 0; i < spans.length; i++) {
                    const span = spans[i];
                    const text = (span.textContent || '').trim();
                    if (!text || !keywords.includes(text)) continue;
                    const color = getComputedStyle(span).color;
                    if (color !== defaultColor) return { text, color };
                }
                return null;
            },
            PYTHON_KEYWORDS,
            { timeout: 8_000 }
        );

        const keywordInfo = await keywordInfoHandle.jsonValue() as { text: string; color: string };
        console.log(`✓ Highlighted keyword "${keywordInfo.text}" has color: ${keywordInfo.color}`);

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
