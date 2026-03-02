/**
 * @file codemirrorRenderFlicker.test.ts
 * @description Regression test for the layout flicker caused by async CodeMirror
 * language-extension loading in the conflict resolver.
 *
 * Background:
 *   CellContentInner initialises `langExtension` as an empty array and loads the
 *   language pack in a useEffect that fires after mount.  When the async load
 *   resolves, `setLangExtension([lang])` triggers a React re-render of every
 *   CodeMirror instance on the page.  TanStack Virtualizer's `measureElement`
 *   callback then observes the briefly-changed row heights and recalculates
 *   `getTotalSize()`.  This causes `.main-content`'s scrollHeight to drop
 *   sharply and then recover — a visible "flicker" that hides all content below
 *   the first half-cell for ~100–300 ms.
 *
 * Detection strategy:
 *   `page.addInitScript` (runs before any page JS) injects a `setInterval`
 *   that samples `.main-content` scrollHeight every 50 ms for 15 seconds.
 *   (requestAnimationFrame is throttled to ~4 fps in headless Chromium, making
 *   it unreliable for sub-second flicker detection; setInterval fires at the
 *   requested rate regardless of frame visibility.)
 *   After the observation window the test fails if
 *   scrollHeight ever dropped to <50% of its final stable value after having
 *   first appeared.  A natural, gradual measurement-driven decrease does NOT
 *   trigger this condition; only a sudden collapse-and-recover does.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page } from 'playwright';
import { readTestConfig } from './testHarness';
import { waitForServer, waitForSessionUrl } from './testHelpers';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Sample window at the end of the tracking period, used as the "stable" height. */
const STABLE_SAMPLE_COUNT = 30;
/**
 * If minHeight after rows appear < finalStableHeight * FLICKER_RATIO_THRESHOLD,
 * we declare a flicker.  0.5 means "height dropped to less than half its final
 * value", which is a clear sign of a temporary collapse.
 */
const FLICKER_RATIO_THRESHOLD = 0.5;

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

        if (samplesAfterRender.length < STABLE_SAMPLE_COUNT + 5) {
            throw new Error(
                `Too few post-render height samples (${samplesAfterRender.length}). ` +
                'Cannot reliably analyse for flicker.'
            );
        }

        // "Stable height" = median of the last STABLE_SAMPLE_COUNT samples.
        // Using the last samples avoids any transient at the start.
        const lastSamples = samplesAfterRender.slice(-STABLE_SAMPLE_COUNT);
        const sortedLast = [...lastSamples].sort((a, b) => a - b);
        const stableHeight = sortedLast[Math.floor(sortedLast.length / 2)];

        const minHeight = Math.min(...samplesAfterRender);
        const maxHeight = Math.max(...samplesAfterRender);

        console.log(
            `[FlickerTest] stableHeight=${stableHeight}px  ` +
            `min=${minHeight}px  max=${maxHeight}px`
        );

        // ── 6. Fail if a flicker drop is detected ────────────────────────────────
        //
        // Flicker signature: minHeight dropped to less than FLICKER_RATIO_THRESHOLD
        // of the final stable height after rows had appeared.
        //
        // Counter-examples that should NOT trigger:
        //   - gradual decrease from estimate (7200px) → measured (2400px): min ≈ stable ✓
        //   - brief dip while rows are first being measured: still large relative to stable ✓
        if (stableHeight < 50) {
            throw new Error(
                `Stable height (${stableHeight}px) is unexpectedly small — ` +
                'something may be wrong with the test setup itself.'
            );
        }

        if (minHeight < stableHeight * FLICKER_RATIO_THRESHOLD) {
            const dropPct = ((stableHeight - minHeight) / stableHeight) * 100;
            throw new Error(
                `[FLICKER DETECTED] .main-content scrollHeight dropped from a stable ` +
                `${stableHeight}px to ${minHeight}px ` +
                `(${dropPct.toFixed(0)}% below stable height) during the observation window. ` +
                `This is the async CodeMirror language-extension load flicker: ` +
                `setLangExtension([lang]) in CellContentInner triggers a React re-render ` +
                `that temporarily collapses row heights, causing the virtualizer's ` +
                `getTotalSize() to collapse and hiding most of the conflict list.`
            );
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
