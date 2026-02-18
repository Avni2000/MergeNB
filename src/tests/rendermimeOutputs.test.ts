/**
 * @file rendermimeOutputs.test.ts
 * @description Integration test for JupyterLab rendermime output rendering in the web UI.
 *
 * Verifies that common MIME outputs render through @jupyterlab/rendermime and that
 * unsupported MIME data uses the plain-text fallback.
 */

import type { Locator } from 'playwright';
import * as vscode from 'vscode';
import {
    readTestConfig,
    setupConflictResolver,
} from './testHarness';

type RenderMimeTestMode = 'full' | 'markdownOnly';

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

async function assertMarkdownLogoRendered(page: import('playwright').Page): Promise<void> {
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

async function assertMarkdownKatexRendered(page: import('playwright').Page): Promise<void> {
    const katexNode = page
        .locator('.merge-row.identical-row .markdown-content .katex')
        .first();
    await katexNode.waitFor({ timeout: 15000 });

    const katexText = ((await katexNode.textContent()) ?? '').trim();
    if (!katexText) {
        throw new Error('Expected non-empty KaTeX-rendered markdown content');
    }
}

export async function run(): Promise<void> {
    console.log('Starting rendermime outputs integration test...');

    let browser: import('playwright').Browser | undefined;
    let page: import('playwright').Page | undefined;
    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const previousHideOutputs = mergeNBConfig.get<boolean>('ui.hideNonConflictOutputs');
    const previousStripOutputs = mergeNBConfig.get<boolean>('autoResolve.stripOutputs');

    try {
        await mergeNBConfig.update('ui.hideNonConflictOutputs', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);

        const config = readTestConfig();
        const mode: RenderMimeTestMode = config.params?.mode === 'markdownOnly' ? 'markdownOnly' : 'full';
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRows.count();
        if (conflictCount === 0) {
            throw new Error('Expected at least one conflict row for MIME fixture');
        }

        await assertMarkdownLogoRendered(page);
        console.log('✓ Markdown local SVG asset rendered through notebook-asset endpoint');
        await assertMarkdownKatexRendered(page);
        console.log('✓ Markdown KaTeX content rendered');
        if (mode === 'markdownOnly') {
            return;
        }

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
        if (currentConflictSource !== incomingConflictSource) {
            throw new Error('Expected rich MIME conflict row to keep identical source on both branches');
        }
        if (!currentConflictSource.includes('MIME_CONFLICT_OUTPUT_SENTINEL')) {
            throw new Error(`Expected rich MIME conflict row source marker, got "${currentConflictSource}"`);
        }

        const currentConflictOutputs = richConflictRow.locator('.current-column .cell-outputs').first();
        const incomingConflictOutputs = richConflictRow.locator('.incoming-column .cell-outputs').first();
        await currentConflictOutputs.waitFor({ timeout: 10000 });
        await incomingConflictOutputs.waitFor({ timeout: 10000 });
        await assertSvgMarkerRendered(currentConflictOutputs, 'SVG_CONFLICT_CURRENT');
        await assertSvgMarkerRendered(incomingConflictOutputs, 'SVG_CONFLICT_INCOMING');
        console.log('✓ Same MIME type with different SVG payloads surfaced as rich conflict output');

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
        if (currentInputConflictSource === incomingInputConflictSource) {
            throw new Error('Expected input payload conflict row to preserve differing source payloads');
        }
        if (!currentInputConflictSource.includes('INPUT_SVG_CURRENT')) {
            throw new Error(`Expected current input payload marker, got "${currentInputConflictSource}"`);
        }
        if (!incomingInputConflictSource.includes('INPUT_SVG_INCOMING')) {
            throw new Error(`Expected incoming input payload marker, got "${incomingInputConflictSource}"`);
        }
        console.log('✓ Input payload differences surfaced as source conflict');

        const mimeRow = page.locator('.merge-row.identical-row').filter({
            hasText: 'MIME_OUTPUT_SENTINEL',
        }).first();

        await mimeRow.waitFor({ timeout: 15000 });
        await mimeRow.scrollIntoViewIfNeeded();

        const rowCell = decodeRowCell(await mimeRow.getAttribute('data-cell'));
        const outputs = rowCell?.outputs;
        if (!Array.isArray(outputs) || outputs.length < 7) {
            throw new Error(`Fixture precondition failed: expected >= 7 outputs, got ${Array.isArray(outputs) ? outputs.length : 'none'}`);
        }

        const outputRoot = mimeRow.locator('.cell-outputs');
        await outputRoot.waitFor({ timeout: 10000 });

        // Stream + text/plain array payloads should render as normalized text.
        await waitForText(outputRoot, 'STREAM_ARRAY_LINE_1');
        await waitForText(outputRoot, 'STREAM_ARRAY_LINE_2');
        await waitForText(outputRoot, 'PLAIN_ARRAY_LINE_1');
        await waitForText(outputRoot, 'PLAIN_ARRAY_LINE_2');

        // HTML renderer output
        const htmlNode = outputRoot.locator('.cell-output-host .jp-RenderedHTMLCommon [data-mime-test="html-array"]');
        await htmlNode.first().waitFor({ timeout: 10000 });
        const htmlText = (await htmlNode.first().textContent())?.trim() || '';
        if (htmlText !== 'HTML_RENDER_OK') {
            throw new Error(`Expected HTML renderer marker, got "${htmlText}"`);
        }

        // PNG image renderer output
        const pngImage = outputRoot.locator('.cell-output-host .jp-RenderedImage img[src^="data:image/png;base64,"]');
        await pngImage.first().waitFor({ timeout: 10000 });

        // SVG renderer output
        await assertSvgMarkerRendered(outputRoot, 'SVG_RENDER_OK');

        // JSON renderer output
        await waitForText(outputRoot, 'JSON_RENDER_OK');

        // Unsupported MIME should use fallback text.
        const fallbackNodes = outputRoot.locator('.cell-output-fallback');
        await fallbackNodes.first().waitFor({ timeout: 10000 });
        const fallbackCount = await fallbackNodes.count();
        if (fallbackCount !== 1) {
            throw new Error(`Expected exactly 1 fallback output, got ${fallbackCount}`);
        }
        const fallbackText = (await fallbackNodes.first().textContent())?.trim() || '';
        if (!fallbackText.includes('[Unsupported output]')) {
            throw new Error(`Expected unsupported MIME fallback text, got "${fallbackText}"`);
        }

        console.log('✓ Rendermime rendered text/html/png/svg/json outputs');
        console.log('✓ Unsupported MIME output used fallback text');
    } finally {
        await mergeNBConfig.update(
            'ui.hideNonConflictOutputs',
            previousHideOutputs,
            vscode.ConfigurationTarget.Workspace
        );
        await mergeNBConfig.update(
            'autoResolve.stripOutputs',
            previousStripOutputs,
            vscode.ConfigurationTarget.Workspace
        );
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
