/** Chromium setup and readiness checks for the conflict resolver UI. */

import { chromium, type Browser, type Page } from 'playwright';

export interface BrowserOptions {
    headless?: boolean;
    afterNavigateDelayMs?: number;
    postHeaderDelayMs?: number;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Launch a browser and wait for the resolver header and optional session connection. */
export async function openConflictResolverPage(
    sessionUrl: string,
    options: BrowserOptions = {},
    connectionPromise?: Promise<unknown>
): Promise<{ browser: Browser; page: Page }> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        const page = await browser.newPage();
        await page.goto(sessionUrl + '&noLightweight=1');
        await sleep(options.afterNavigateDelayMs ?? 3000);

        await page.waitForSelector('.header-title', { timeout: 15000 });
        const title = await page.locator('.header-title').textContent();
        if (title?.trim() !== 'MergeNB') {
            throw new Error(`Expected header 'MergeNB', got '${title}'`);
        }

        if (connectionPromise) {
            const connectionTimeoutMs = 30000;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    connectionPromise,
                    new Promise<void>((_, reject) => {
                        timer = setTimeout(() => reject(new Error(
                            `Browser connection timeout after ${connectionTimeoutMs}ms`
                        )), connectionTimeoutMs);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        }

        await sleep(options.postHeaderDelayMs ?? 1000);
        return { browser, page };
    } catch (error) {
        await browser.close();
        throw error;
    }
}
