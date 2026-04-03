/**
 * @file rendermimeOutputs.spec.ts
 * @description Playwright Test for JupyterLab rendermime output rendering in the web UI.
 *
 * Verifies that common MIME outputs render through @jupyterlab/rendermime and that
 * unsupported MIME data uses the plain-text fallback.
 */

import { test, expect } from './fixtures';
import type { Locator, Page } from 'playwright';
import * as logger from '../../core/src';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from '../../../apps/vscode-extension/tests/settingsFile';

// ─── Helper Functions ───────────────────────────────────────────────────────

function decodeRowCell(rowCellAttr: string | null): any {
    if (!rowCellAttr) {
        throw new Error('Missing data-cell attribute on identical row');
    }
    return JSON.parse(decodeURIComponent(rowCellAttr));
}

function decodeCellAttr(cellAttr: string | null, context: string): any {
    if (!cellAttr) {
        throw new Error(`Missing data-cell attribute on ${context}`);
    }
    return JSON.parse(decodeURIComponent(cellAttr));
}

function normalizeSource(source: unknown): string {
    if (Array.isArray(source)) {
        return source.join('');
    }
    return typeof source === 'string' ? source : '';
}

async function waitForText(root: Locator, text: string): Promise<void> {
    const node = root.getByText(text).first();
    await node.waitFor({ timeout: 10000 });
}

async function assertSvgMarkerRendered(root: Locator, expectedMarker: string): Promise<void> {
    const svgContainer = root.locator('.cell-output-host .jp-RenderedSVG').first();
    await svgContainer.waitFor({ timeout: 10000 });

    const inlineSvg = svgContainer.locator('svg');
    const inlineSvgCount = await inlineSvg.count();
    if (inlineSvgCount > 0) {
        const inlineSvgText = (await inlineSvg.first().textContent()) ?? '';
        if (!inlineSvgText.includes(expectedMarker)) {
            throw new Error(`Inline SVG missing marker "${expectedMarker}". text="${inlineSvgText}"`);
        }
        return;
    }

    const svgImg = svgContainer.locator('img[src^="data:image/svg+xml"]');
    await svgImg.first().waitFor({ timeout: 10000 });
    const svgSrc = (await svgImg.first().getAttribute('src')) ?? '';
    if (!svgSrc.includes(expectedMarker) && !decodeURIComponent(svgSrc).includes(expectedMarker)) {
        throw new Error(`SVG data URL missing marker "${expectedMarker}". src prefix="${svgSrc.slice(0, 80)}"`);
    }
}

async function assertMarkdownLogoRendered(page: Page): Promise<void> {
    const markdownLogo = page
        .locator('.merge-row.identical-row .markdown-content img[alt="logo"]')
        .first();
    await markdownLogo.waitFor({ timeout: 15000 });

    const markdownLogoSrc = (await markdownLogo.getAttribute('src')) ?? '';
    if (!markdownLogoSrc.includes('/notebook-asset?')) {
        throw new Error(`Expected markdown logo src to use /notebook-asset, got "${markdownLogoSrc}"`);
    }

    const markdownLogoLoaded = await markdownLogo.evaluate((node) => {
        const img = node as { complete?: boolean; naturalWidth?: number };
        return Boolean(img.complete) && Number(img.naturalWidth ?? 0) > 0;
    });
    if (!markdownLogoLoaded) {
        throw new Error('Markdown logo image did not load (naturalWidth=0)');
    }
}

async function assertMarkdownKatexRendered(page: Page): Promise<void> {
    const katexNode = page
        .locator('.merge-row.identical-row .markdown-content .katex')
        .first();
    await katexNode.waitFor({ timeout: 15000 });

    const katexText = ((await katexNode.textContent()) ?? '').trim();
    if (!katexText) {
        throw new Error('Expected non-empty KaTeX-rendered markdown content');
    }
}

// ─── Test Definitions ───────────────────────────────────────────────────────

test.describe('RenderMime Outputs', () => {
    test('Render markdown local SVG assets (logo.svg) in fixture 02', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting rendermime outputs integration test...');

        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'ui.hideNonConflictOutputs': false,
                'autoResolve.stripOutputs': false,
            });

            const workspacePath = conflictRepo({
                base: '02_base.ipynb',
                current: '02_current.ipynb',
                incoming: '02_incoming.ipynb',
            });

            const session = await conflictSession(workspacePath);
            const { page } = session;

            const conflictRows = page.locator('.merge-row.conflict-row');
            const conflictCount = await conflictRows.count();
            expect(conflictCount).toBeGreaterThan(0);

            await assertMarkdownLogoRendered(page);
            logger.info('✓ Markdown local SVG asset rendered through notebook-asset endpoint');

            await assertMarkdownKatexRendered(page);
            logger.info('✓ Markdown KaTeX content rendered');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });

    test('Render text/html/png/svg/json outputs and unsupported fallback (05 notebooks)', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting rendermime outputs integration test...');

        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'ui.hideNonConflictOutputs': false,
                'autoResolve.stripOutputs': false,
            });

            const workspacePath = conflictRepo({
                base: '05_mime_base.ipynb',
                current: '05_mime_current.ipynb',
                incoming: '05_mime_incoming.ipynb',
            });

            const session = await conflictSession(workspacePath);
            const { page } = session;

            const conflictRows = page.locator('.merge-row.conflict-row');
            const conflictCount = await conflictRows.count();
            expect(conflictCount).toBeGreaterThan(0);

            // Verify markdown rendering
            await assertMarkdownLogoRendered(page);
            logger.info('✓ Markdown local SVG asset rendered through notebook-asset endpoint');

            await assertMarkdownKatexRendered(page);
            logger.info('✓ Markdown KaTeX content rendered');

            // Find rich conflict row (same source, different output SVG payloads)
            const richConflictRow = conflictRows.filter({
                hasText: 'MIME_CONFLICT_OUTPUT_SENTINEL',
            }).first();
            await richConflictRow.waitFor({ timeout: 15000 });
            await richConflictRow.scrollIntoViewIfNeeded();

            const currentConflictCell = decodeCellAttr(
                await richConflictRow.locator('.current-column .notebook-cell').first().getAttribute('data-cell'),
                'current conflict column'
            );
            const incomingConflictCell = decodeCellAttr(
                await richConflictRow.locator('.incoming-column .notebook-cell').first().getAttribute('data-cell'),
                'incoming conflict column'
            );
            const currentConflictSource = normalizeSource(currentConflictCell?.source);
            const incomingConflictSource = normalizeSource(incomingConflictCell?.source);

            expect(currentConflictSource).toBe(incomingConflictSource);
            expect(currentConflictSource).toContain('MIME_CONFLICT_OUTPUT_SENTINEL');

            const currentConflictOutputs = richConflictRow.locator('.current-column .cell-outputs').first();
            const incomingConflictOutputs = richConflictRow.locator('.incoming-column .cell-outputs').first();
            await currentConflictOutputs.waitFor({ timeout: 10000 });
            await incomingConflictOutputs.waitFor({ timeout: 10000 });
            await assertSvgMarkerRendered(currentConflictOutputs, 'SVG_CONFLICT_CURRENT');
            await assertSvgMarkerRendered(incomingConflictOutputs, 'SVG_CONFLICT_INCOMING');
            logger.info('✓ Same MIME type with different SVG payloads surfaced as rich conflict output');

            // Find input payload conflict row
            const inputPayloadConflictRow = conflictRows.filter({
                hasText: 'MIME_INPUT_PAYLOAD_CONFLICT_SENTINEL',
            }).first();
            await inputPayloadConflictRow.waitFor({ timeout: 15000 });
            await inputPayloadConflictRow.scrollIntoViewIfNeeded();

            const currentInputConflictCell = decodeCellAttr(
                await inputPayloadConflictRow.locator('.current-column .notebook-cell').first().getAttribute('data-cell'),
                'current input payload conflict column'
            );
            const incomingInputConflictCell = decodeCellAttr(
                await inputPayloadConflictRow.locator('.incoming-column .notebook-cell').first().getAttribute('data-cell'),
                'incoming input payload conflict column'
            );
            const currentInputConflictSource = normalizeSource(currentInputConflictCell?.source);
            const incomingInputConflictSource = normalizeSource(incomingInputConflictCell?.source);

            expect(currentInputConflictSource).not.toBe(incomingInputConflictSource);
            expect(currentInputConflictSource).toContain('INPUT_SVG_CURRENT');
            expect(incomingInputConflictSource).toContain('INPUT_SVG_INCOMING');
            logger.info('✓ Input payload differences surfaced as source conflict');

            // Find MIME output row with various output types
            const mimeRow = page.locator('.merge-row.identical-row').filter({
                hasText: 'MIME_OUTPUT_SENTINEL',
            }).first();

            await mimeRow.waitFor({ timeout: 15000 });
            await mimeRow.scrollIntoViewIfNeeded();

            const rowCell = decodeRowCell(await mimeRow.getAttribute('data-cell'));
            const outputs = rowCell?.outputs;
            expect(Array.isArray(outputs)).toBe(true);
            expect(outputs.length).toBeGreaterThanOrEqual(7);

            const outputRoot = mimeRow.locator('.cell-outputs');
            await outputRoot.waitFor({ timeout: 10000 });

            // Stream + text/plain array payloads should render as normalized text
            await waitForText(outputRoot, 'STREAM_ARRAY_LINE_1');
            await waitForText(outputRoot, 'STREAM_ARRAY_LINE_2');
            await waitForText(outputRoot, 'PLAIN_ARRAY_LINE_1');
            await waitForText(outputRoot, 'PLAIN_ARRAY_LINE_2');

            // HTML renderer output
            const htmlNode = outputRoot
                .locator('.cell-output-host .jp-RenderedHTMLCommon')
                .filter({ hasText: 'HTML_RENDER_OK' })
                .first();
            await htmlNode.waitFor({ timeout: 10000 });
            const htmlText = ((await htmlNode.textContent()) ?? '').trim();
            expect(htmlText).toContain('HTML_RENDER_OK');

            const htmlScriptExecuted = await page.evaluate(() => {
                const win = window as Window & { __MERGENB_HTML_SCRIPT_EXECUTED__?: boolean };
                return Boolean(win.__MERGENB_HTML_SCRIPT_EXECUTED__);
            });
            expect(htmlScriptExecuted).toBe(false);

            // PNG image renderer output
            const pngImage = outputRoot.locator('.cell-output-host .jp-RenderedImage img[src^="data:image/png;base64,"]');
            await pngImage.first().waitFor({ timeout: 10000 });
            const pngLoaded = await pngImage.first().evaluate((node) => {
                const img = node as { complete?: boolean; naturalWidth?: number };
                return Boolean(img.complete) && Number(img.naturalWidth ?? 0) > 0;
            });
            expect(pngLoaded).toBe(true);

            // SVG renderer output
            await assertSvgMarkerRendered(outputRoot, 'SVG_RENDER_OK');

            // JSON renderer output
            await waitForText(outputRoot, 'JSON_RENDER_OK');

            // Unsupported MIME should use fallback text
            const fallbackNodes = outputRoot.locator('.cell-output-fallback');
            await fallbackNodes.first().waitFor({ timeout: 10000 });
            const fallbackCount = await fallbackNodes.count();
            expect(fallbackCount).toBe(1);

            const fallbackText = (await fallbackNodes.first().textContent())?.trim() || '';
            expect(fallbackText).toContain('[Unsupported output]');

            logger.info('✓ Rendermime rendered text/html/png/svg/json outputs');
            logger.info('✓ Unsupported MIME output used fallback text');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
