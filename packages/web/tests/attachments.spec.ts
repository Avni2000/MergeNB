import { test, expect } from '../../../test-fixtures/harness/playwright';
import { normalizeMimeValue } from '../../core/src';
import { writeSettingsFile } from '../../../apps/vscode-extension/tests/settingsFile';

test('attachment previews retain complete MIME bundles on disk in nbformat 4.0', async ({ conflictRepo, conflictSession, applyAndReadNotebook }) => {
    writeSettingsFile({ 'autoResolve.stripOutputs': true, 'security.trustContent': false });
    const workspace = conflictRepo({
        base: 'edge-cases/attachments/base.ipynb',
        current: 'edge-cases/attachments/current.ipynb',
        incoming: 'edge-cases/attachments/incoming.ipynb',
    });
    const { page, conflictFile } = await conflictSession(workspace);
    const row = page.locator('.conflict-row').first();
    const incoming = JSON.parse(decodeURIComponent((await row.locator('.incoming-column .notebook-cell').getAttribute('data-cell'))!));
    await row.locator('.btn-incoming').click();
    const image = row.locator('.markdown-content img');
    await expect(image).toHaveAttribute('src', /data:image\/svg\+xml/);
    expect(decodeURIComponent((await image.getAttribute('src'))!)).toContain('fill="blue"');
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(20);

    const raw = JSON.parse(decodeURIComponent((await page.locator('.identical-row').getAttribute('data-cell'))!));
    const notebook = await applyAndReadNotebook(page, conflictFile);
    expect(notebook.nbformat_minor).toBe(0);
    expect(notebook.cells[0]).toEqual(incoming);
    expect(notebook.cells[1]).toEqual(raw);
    for (const mime of ['application/json', 'application/vnd.test+json']) {
        const value = notebook.cells[0].attachments['unused.json'][mime];
        expect(normalizeMimeValue(mime, value)).toEqual(value);
        expect(Array.isArray(value)).toBe(true);
    }
});
