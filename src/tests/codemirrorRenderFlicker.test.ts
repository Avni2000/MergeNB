/**
 * @file codemirrorRenderFlicker.test.ts
 * @description Regression test for the layout flicker caused by async CodeMirror
 * language-extension loading in the conflict resolver.
 *
 * Background:
 *   Async CodeMirror language-extension activation can trigger a broad re-render
 *   of mounted editors after initial row paint. TanStack Virtualizer's
 *   `measureElement` callback then observes temporarily changed row heights and
 *   recalculates `getTotalSize()`, which can cause `.main-content` scrollHeight
 *   to collapse and recover briefly (visible flicker).
 *
 * Detection strategy:
 *   `page.addInitScript` (runs before any page JS) injects a `setInterval`
 *   that samples `.main-content` scrollHeight every 50 ms for 15 seconds.
 *   (requestAnimationFrame is throttled to ~4 fps in headless Chromium, making
 *   it unreliable for sub-second flicker detection; setInterval fires at the
 *   requested rate regardless of frame visibility.)
 *   After the observation window, the test tracks the rolling peak height and
 *   fails if any sample drops to less than 50% of that peak. Gradual downward
 *   drift from TanStack measurement refinement is expected and tolerated; only
 *   a sudden large collapse (the original flicker symptom) triggers failure.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page } from 'playwright';
import { readTestConfig } from './testHarness';
import { waitForServer, waitForSessionUrl } from './testHelpers';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function run(): Promise<void> {
    console.log('Starting CodeMirror render-flicker regression test...');

    let browser: Browser | undefined;
    let page: Page | undefined;

    const mergeNBConfig = vscode.workspace.getConfiguration('mergeNB');
    const prevAutoResolveExecCount = mergeNBConfig.get<boolean>('autoResolve.executionCount');
    const prevStripOutputs = mergeNBConfig.get<boolean>('autoResolve.stripOutputs');

    try {
        await mergeNBConfig.update('autoResolve.executionCount', false, vscode.ConfigurationTarget.Workspace);
        await mergeNBConfig.update('autoResolve.stripOutputs', false, vscode.ConfigurationTarget.Workspace);

        const config = readTestConfig();
        const workspacePath = config.workspacePath;

        // ── 1. Open the conflict file and trigger findConflicts ──────────────────
        const conflictFile = path.join(workspacePath, 'conflict.ipynb');
        const doc = await vscode.workspace.openTextDocument(conflictFile);
        await vscode.window.showTextDocument(doc);
        await sleep(1000);

        console.log('[FlickerTest] Executing merge-nb.findConflicts...');
        await vscode.commands.executeCommand('merge-nb.findConflicts');

        // ── 2. Wait for the web server and session URL ───────────────────────────
        const serverPort = await waitForServer(
            () => Promise.resolve(vscode.commands.executeCommand<number>('merge-nb.getWebServerPort'))
        );
        console.log(`[FlickerTest] Server on port ${serverPort}`);

        const sessionUrl = await waitForSessionUrl(
            () => Promise.resolve(vscode.commands.executeCommand<string>('merge-nb.getLatestWebSessionUrl'))
        );
        console.log(`[FlickerTest] Session URL: ${sessionUrl}`);

        // ── 3. Create a browser page with a height-sampling init script ──────────
        //
        // IMPORTANT: addInitScript must be called BEFORE page.goto so the sampling
        // loop starts from the very first frame — before React mounts and before
        // the async language-extension load fires.
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();

        await page.addInitScript(() => {
            // Runs in browser context before any page scripts.
            // NOTE: requestAnimationFrame is throttled to ~4 fps in headless Chromium
            // (no visible frame), so we use setInterval for reliable 20 fps sampling.
            (window as any).__flickerHeightLog = [] as number[];
            const start = Date.now();
            const interval = setInterval(() => {
                const el = document.querySelector<HTMLElement>('.main-content');
                (window as any).__flickerHeightLog.push(el ? el.scrollHeight : 0);
                if (Date.now() - start >= 15_000) {
                    clearInterval(interval);
                }
            }, 50); // 50 ms → up to 300 samples over 15 s
        });

        await page.goto(sessionUrl);

        // ── 4. Wait for the React app to render rows ─────────────────────────────
        await page.waitForSelector('.header-title', { timeout: 15_000 });
        console.log('[FlickerTest] ✓ Header appeared');

        await page.waitForSelector('.merge-row', { timeout: 10_000 });
        console.log('[FlickerTest] ✓ Merge rows appeared');

        // Wait for the language-extension async load + potential flicker to occur.
        // The flicker typically fires ~200–700 ms after rows appear.
        // We also need ≥ STABLE_SAMPLE_COUNT × 50 ms = 1.5 s of stable samples at
        // the end, so 5.5 s total is a comfortable margin.
        await sleep(5500);

        // ── 5. Collect height log from the browser ───────────────────────────────
        const heightLog = await page.evaluate(
            () => (window as any).__flickerHeightLog as number[]
        );
        console.log(`[FlickerTest] Collected ${heightLog.length} height samples`);

        // Drop leading zeros (before React rendered anything).
        const firstNonZero = heightLog.findIndex(h => h > 0);
        if (firstNonZero === -1) {
            throw new Error(
                'scrollHeight was never non-zero. ' +
                '.main-content may not have rendered during the observation window.'
            );
        }
        const samplesAfterRender = heightLog.slice(firstNonZero);
        console.log(`[FlickerTest] Switched to post-render height analysis`);

        if (samplesAfterRender.length < 5) {
            throw new Error(
                `Too few post-render height samples (${samplesAfterRender.length}). ` +
                'Cannot reliably analyse for flicker.'
            );
        }

        // Log height samples for diagnostics
        const minHeight = Math.min(...samplesAfterRender);
        const maxHeight = Math.max(...samplesAfterRender);

        console.log(
            `[FlickerTest] Height range: min=${minHeight}px, max=${maxHeight}px`
        );

        // ── 6. Fail if height collapses suddenly ─────────────────────────────────
        // TanStack Virtualizer refines over-estimated row heights downward as it
        // measures the real DOM — a gradual decrease is expected and not a flicker.
        // A real flicker is a sudden large drop (>50% of the rolling peak), which
        // indicates a momentary layout collapse from async CodeMirror activation.
        let rollingPeak = samplesAfterRender[0];
        for (let i = 1; i < samplesAfterRender.length; i++) {
            const h = samplesAfterRender[i];
            if (h > rollingPeak) {
                rollingPeak = h;
            }
            if (rollingPeak > 0 && h < rollingPeak * 0.5) {
                const dropPct = ((rollingPeak - h) / rollingPeak) * 100;
                throw new Error(
                    `[FLICKER DETECTED] .main-content scrollHeight dropped from ` +
                    `${rollingPeak}px to ${h}px (${dropPct.toFixed(0)}% drop) ` +
                    `at sample index ${firstNonZero + i}. ` +
                    `This indicates a layout collapse, likely from async CodeMirror language-extension activation.`
                );
            }
        }

        console.log('[FlickerTest] ✓ No render flicker detected');
    } finally {
        try {
            await mergeNBConfig.update(
                'autoResolve.executionCount',
                prevAutoResolveExecCount,
                vscode.ConfigurationTarget.Workspace
            );
        } catch { /* ignore */ }
        try {
            await mergeNBConfig.update(
                'autoResolve.stripOutputs',
                prevStripOutputs,
                vscode.ConfigurationTarget.Workspace
            );
        } catch { /* ignore */ }

        if (page) { try { await page.close(); } catch { /* ignore */ } }
        if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    }
}
