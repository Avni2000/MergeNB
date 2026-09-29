import { test, expect } from '../../../test-fixtures/harness/playwright';
import { writeSettingsFile } from '../../../apps/vscode-extension/tests/settingsFile';

for (const autoKernel of [false, true]) {
    test(`notebook fields preserve nested edits and explicit choices (kernel auto-resolve ${autoKernel})`, async ({ conflictRepo, conflictSession, applyAndReadNotebook }) => {
        writeSettingsFile({ 'autoResolve.kernelVersion': autoKernel });
        const workspace = conflictRepo({
            base: 'edge-cases/notebook-fields/base.ipynb',
            current: 'edge-cases/notebook-fields/current.ipynb',
            incoming: 'edge-cases/notebook-fields/incoming.ipynb',
        });
        const { page, conflictFile } = await conflictSession(workspace);
        await expect(page.locator('.conflict-row')).toHaveCount(0);
        await expect(page.locator('.notebook-field-conflict')).toHaveCount(autoKernel ? 2 : 3);
        await expect(page.getByRole('button', { name: 'Apply Resolution', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'All Incoming', exact: true }).click();
        await page.getByRole('button', { name: 'Apply Resolution', exact: true }).waitFor();
        await expect(page.getByRole('button', { name: 'Apply Resolution', exact: true })).toBeEnabled();
        await page.locator('[data-testid="history-undo"]').click();
        await expect(page.getByRole('button', { name: 'Apply Resolution', exact: true })).toBeDisabled();
        await page.locator('[data-testid="history-redo"]').click();

        const fields = JSON.parse((await page.locator('.notebook-fields').getAttribute('data-notebook-fields'))!);
        expect(fields.metadata.language_info.version).toBe(autoKernel ? '3.10' : '3.11');
        expect(fields.metadata.custom).toEqual({ left: 1, right: 2 });
        expect(fields.metadata).not.toHaveProperty('deleted');
        expect(fields.vendor.payload).toEqual(['incoming']);
        expect(fields.added).toEqual({ nested: true });
        expect(fields.untouched).toBeNull();
        const cell = JSON.parse(decodeURIComponent((await page.locator('.identical-row').getAttribute('data-cell'))!));
        const notebook = await applyAndReadNotebook(page, conflictFile);
        expect(notebook).toEqual({ ...fields, nbformat: 4, nbformat_minor: 0, cells: [cell] });
    });
}
