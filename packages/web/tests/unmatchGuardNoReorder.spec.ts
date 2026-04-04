/**
 * @file unmatchGuardNoReorder.spec.ts
 * @description Playwright Test: Guard test for non-reorder fixtures.
 *
 * Verifies that non-reorder fixtures do not expose Unmatch actions.
 */

import type { Page } from 'playwright';
import { test, expect } from './fixtures';
import { waitForResolvedCount } from '../../../test-fixtures/shared/integrationUtils';
import * as logger from '../../core/src';
import {
    readSettingsFileSnapshot,
    restoreSettingsFileSnapshot,
    writeSettingsFile,
} from '../../../apps/vscode-extension/tests/settingsFile';

// ─── Helper Functions ───────────────────────────────────────────────────────

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

// ─── Test Definitions ───────────────────────────────────────────────────────

test.describe('Unmatch Guard - No Reorder', () => {
    test('Guard: non-reorder fixtures must not show Unmatch buttons', async ({ conflictRepo, conflictSession }) => {
        logger.info('Starting MergeNB Non-Reorder Unmatch Guard Test...');

        const settingsSnapshot = readSettingsFileSnapshot();

        try {
            writeSettingsFile({
                'autoResolve.executionCount': false,
                'autoResolve.stripOutputs': false,
                'autoResolve.whitespace': false,
            });

            const workspacePath = conflictRepo({
                base: '02_base.ipynb',
                current: '02_current.ipynb',
                incoming: '02_incoming.ipynb',
            });

            const session = await conflictSession(workspacePath);
            const { page } = session;

            await page.locator('.merge-row').first().waitFor({ timeout: 5000 });
            const counter = await waitForResolvedCount(page, 0, 5000);
            expect(counter.total).toBeGreaterThan(0);

            const found = await findUnmatchButtonWhileScrolling(page);
            if (found.found) {
                throw new Error(
                    `Expected 0 Unmatch buttons for non-reorder fixtures, but found ${found.count} at scrollTop=${found.scrollTop}`
                );
            }

            logger.info('  \u2713 No Unmatch button exposed for non-reorder fixtures');
            logger.info('\n=== TEST PASSED ===');
        } finally {
            restoreSettingsFileSnapshot(settingsSnapshot);
        }
    });
});
