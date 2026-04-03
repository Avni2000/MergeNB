/**
 * @file syntaxHighlighting.spec.ts
 * @description Playwright Test verifying that the resolved-content editor renders
 * with CodeMirror syntax highlighting for Python cells.
 */

import { test, expect } from './fixtures';
import * as logger from '../../core/src';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from '../../../apps/vscode-extension/tests/settingsFile';

test.describe('Syntax Highlighting', () => {
    test('Resolved editor shows .cm-editor and .tok-keyword spans for Python code', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting syntax highlighting integration test...');

        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
            });

            // Create merge conflict repo with syntax highlighting fixture
            const workspacePath = conflictRepo({
                base: '07_syntax_base.ipynb',
                current: '07_syntax_current.ipynb',
                incoming: '07_syntax_incoming.ipynb',
            });

            // Set up conflict resolver
            const session = await conflictSession(workspacePath);
            const { page } = session;

            // Find the first conflict row
            const conflictRows = page.locator('.merge-row.conflict-row');
            const conflictCount = await conflictRows.count();
            expect(conflictCount).toBeGreaterThan(0);

            const firstRow = conflictRows.first();

            // Select "Use Current" so the resolved editor appears
            const useCurrentBtn = firstRow.locator('button', { hasText: 'Use Current' });
            await useCurrentBtn.waitFor({ timeout: 10_000 });
            await useCurrentBtn.click();

            const resolvedCell = firstRow.locator('.resolved-cell');
            await resolvedCell.waitFor({ timeout: 10_000 });
            logger.info('✓ Resolved cell appeared after clicking Use Current');

            // Assert CodeMirror editor is present (textarea was replaced)
            const textarea = resolvedCell.locator('textarea.resolved-content-input');
            const textareaCount = await textarea.count();
            if (textareaCount > 0) {
                throw new Error(
                    'Found a <textarea class="resolved-content-input"> — CodeMirror editor did NOT replace the textarea'
                );
            }

            const cmEditor = resolvedCell.locator('.cm-editor');
            await cmEditor.waitFor({ timeout: 10_000 });
            logger.info('✓ .cm-editor element is present (textarea replaced by CodeMirror)');

            // Assert syntax-highlighted keyword tokens appear
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
            expect(keywordInfo).not.toBeNull();
            logger.info(`✓ Highlighted keyword "${keywordInfo.text}" has color: ${keywordInfo.color}`);

            logger.info('✓ Syntax highlighting test passed');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
