/**
 * @file unmatchGuardNoReorder.test.ts
 * @description Guard test: non-reorder fixtures must not expose Unmatch actions.
 */

import type { Page } from 'playwright';
import { waitForResolvedCount } from './integrationUtils';
import { readTestConfig, setupConflictResolver } from './testHarness';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from './settingsFile';

async function findUnmatchButtonWhileScrolling(page: Page): Promise<{ found: boolean; count: number; scrollTop: number }> {
    const mainContent = page.locator('.main-content');
    await mainContent.waitFor({ timeout: 5000 });

    const dimensions = await mainContent.evaluate(el => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
    }));
    const step = Math.max(200, Math.floor(dimensions.clientHeight * 0.8));

    for (let top = 0; top <= dimensions.scrollHeight; top += step) {
        await mainContent.evaluate((el, value) => {
            (el as HTMLElement).scrollTop = value;
        }, top);
        await page.waitForTimeout(80);

        const count = await page.locator('[data-testid="unmatch-btn"]').count();
        if (count > 0) {
            return { found: true, count, scrollTop: top };
        }
    }

    return { found: false, count: 0, scrollTop: 0 };
}

export async function run(): Promise<void> {
    console.log('Starting MergeNB Non-Reorder Unmatch Guard Test...');

    let browser;
    let page: Page | undefined;
    const settingsSnapshot = readSettingsFileSnapshot();

    try {
        writeSettingsFile({
            'autoResolve.executionCount': false,
            'autoResolve.stripOutputs': false,
            'autoResolve.whitespace': false,
        });

        const config = readTestConfig();
        const session = await setupConflictResolver(config);
        browser = session.browser;
        page = session.page;

        await page.locator('.merge-row').first().waitFor({ timeout: 5000 });
        const counter = await waitForResolvedCount(page, 0, 5000);
        if (counter.total <= 0) {
            throw new Error(`Expected initialized conflict counter, got ${counter.resolved}/${counter.total}`);
        }

        const found = await findUnmatchButtonWhileScrolling(page);
        if (found.found) {
            throw new Error(
                `Expected 0 Unmatch buttons for non-reorder fixtures, but found ${found.count} at scrollTop=${found.scrollTop}`
            );
        }

        console.log('  \u2713 No Unmatch button exposed for non-reorder fixtures');
        console.log('\n=== TEST PASSED ===');
    } finally {
        restoreSettingsFileSnapshot(settingsSnapshot);
        if (page) await page.close();
        if (browser) await browser.close();
    }
}
