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

function decodeRowCell(rowCellAttr: string | null): any {
    if (!rowCellAttr) {
        throw new Error('Missing data-cell attribute on identical row');
    }
    return JSON.parse(decodeURIComponent(rowCellAttr));
}

async function waitForText(root: Locator, text: string): Promise<void> {
    const node = root.getByText(text).first();
    await node.waitFor({ timeout: 10000 });
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
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        const conflictRows = page.locator('.merge-row.conflict-row');
        const conflictCount = await conflictRows.count();
        if (conflictCount === 0) {
            throw new Error('Expected at least one conflict row for MIME fixture');
        }

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

        // SVG renderer output — JupyterLab 4.x renders SVG as <img data-URL>,
        // not as an inline <svg> element. Verify the img element exists and that
        // its src is a data-URL containing the expected SVG markup.
        const svgImg = outputRoot.locator('.cell-output-host .jp-RenderedSVG img[src^="data:image/svg+xml"]');
        await svgImg.first().waitFor({ timeout: 10000 });
        const svgSrc = (await svgImg.first().getAttribute('src')) ?? '';
        if (!svgSrc.includes('SVG_RENDER_OK') && !decodeURIComponent(svgSrc).includes('SVG_RENDER_OK')) {
            throw new Error(`SVG data-URL does not contain expected marker. src prefix: "${svgSrc.slice(0, 80)}"`);
        }

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
            previousHideOutputs ?? false,
            vscode.ConfigurationTarget.Workspace
        );
        await mergeNBConfig.update(
            'autoResolve.stripOutputs',
            previousStripOutputs ?? true,
            vscode.ConfigurationTarget.Workspace
        );
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
