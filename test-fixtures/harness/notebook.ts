/** Apply UI resolutions and compare notebooks on disk with expected UI content. */

import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import * as logger from '../../packages/core/src';
import { type ExpectedCell, getCellSource, waitForFileWrite } from '../shared/testHelpers';
import { ensureCheckboxChecked } from '../shared/integrationUtils';
import { sleep } from './browser';

export interface ApplyOptions {
    markResolved?: boolean;
    postClickDelayMs?: number;
    writeTimeoutMs?: number;
}

export interface NotebookMatchOptions {
    expectedLabel?: string;
    compareMetadata?: boolean;
    compareExecutionCounts?: boolean;
    renumberEnabled?: boolean;
    logCounts?: boolean;
}

/**
 * Check "Mark as resolved", click Apply, wait for the file to be written,
 * then read and return the resolved notebook from disk.
 */
export async function applyResolutionAndReadNotebook(
    page: Page,
    conflictFile: string,
    options: ApplyOptions = {}
): Promise<any> {
    if (options.markResolved ?? true) {
        await ensureCheckboxChecked(page, 'Mark as resolved');
    }

    logger.info('\n=== Applying resolution ===');
    const applyButton = page.locator('button.btn-primary:has-text("Apply Resolution")');
    await applyButton.waitFor({ timeout: 5000 });

    if (await applyButton.isDisabled()) {
        throw new Error('Apply Resolution button is disabled');
    }

    const initialMtime = (() => {
        try { return fs.statSync(conflictFile).mtimeMs; } catch { return 0; }
    })();

    await applyButton.click();
    await sleep(options.postClickDelayMs ?? 3000);

    const fileWritten = await waitForFileWrite(conflictFile, fs, options.writeTimeoutMs, initialMtime);
    if (!fileWritten) {
        logger.info('Warning: Could not confirm file write, proceeding anyway');
    }

    const notebookContent = fs.readFileSync(conflictFile, 'utf8');
    return JSON.parse(notebookContent);
}

/**
 * Assert that a resolved notebook on disk matches the expected cell list.
 *
 * Checks (in order): cell count, source, cell_type, metadata (if
 * `compareMetadata`), outputs, and execution counts (if `compareExecutionCounts`).
 * When `renumberEnabled` is true, execution counts are expected to increment
 * from 1 for every code cell that has outputs.
 *
 * Throws a descriptive error on the first category of mismatch found.
 */
export function assertNotebookMatches(
    expectedCells: ExpectedCell[],
    resolvedNotebook: any,
    options: NotebookMatchOptions = {}
): void {
    const expectedNonDeleted = expectedCells.filter(c => !c.isDeleted);
    const label = options.expectedLabel || 'Expected';
    const logCounts = options.logCounts ?? true;

    if (!resolvedNotebook || !Array.isArray(resolvedNotebook.cells)) {
        throw new Error('Resolved notebook is missing cells');
    }

    if (logCounts) {
        logger.info(`Notebook on disk: ${resolvedNotebook.cells.length} cells`);
        logger.info(`${label}: ${expectedNonDeleted.length} cells`);
    }

    if (resolvedNotebook.cells.length !== expectedNonDeleted.length) {
        logger.info('Cell count mismatch:');
        logger.info('Expected cells:');
        for (const cell of expectedNonDeleted) {
            logger.info(`  Row ${cell.rowIndex}: ${cell.cellType}, ${cell.source.length} chars`);
        }
        logger.info('Actual cells:');
        for (let i = 0; i < resolvedNotebook.cells.length; i++) {
            const src = getCellSource(resolvedNotebook.cells[i]);
            logger.info(`  Cell ${i}: ${resolvedNotebook.cells[i].cell_type}, ${src.length} chars`);
        }
        throw new Error(`Cell count mismatch: expected ${expectedNonDeleted.length}, got ${resolvedNotebook.cells.length}`);
    }

    let sourceMismatches = 0;
    let typeMismatches = 0;
    let metadataMismatches = 0;
    let executionMismatches = 0;
    let outputMismatches = 0;
    let nextExecutionCount = 1;

    for (let i = 0; i < expectedNonDeleted.length; i++) {
        const expected = expectedNonDeleted[i];
        const actual = resolvedNotebook.cells[i];
        const actualSource = getCellSource(actual);

        if (expected.source !== actualSource) {
            sourceMismatches++;
            logger.info(`Source mismatch at cell ${i}:`);
            logger.info(`  Expected: "${expected.source.substring(0, 80).replace(/\n/g, '\\n')}..."`);
            logger.info(`  Actual:   "${actualSource.substring(0, 80).replace(/\n/g, '\\n')}..."`);
        }

        if (expected.cellType !== actual.cell_type) {
            typeMismatches++;
            logger.info(`Type mismatch at cell ${i}: expected ${expected.cellType}, got ${actual.cell_type}`);
        }

        if (options.compareMetadata) {
            const expectedMetadata = expected.metadata || {};
            const actualMetadata = actual.metadata || {};
            if (JSON.stringify(expectedMetadata) !== JSON.stringify(actualMetadata)) {
                metadataMismatches++;
                logger.info(`Metadata mismatch at cell ${i}`);
            }
        }

        if (expected.outputs !== undefined) {
            const actualOutputs = (actual as any).outputs || [];
            // Strip execution_count from execute_result outputs before comparing —
            // renumberExecutionCounts() updates that field on the disk copy, but the
            // expected snapshot captured from the UI still carries the original value.
            // Cell-level execution_count is already verified separately above.
            const stripExecCount = (outs: any[]) =>
                outs.map(o => o.output_type === 'execute_result'
                    ? (({ execution_count: _ec, ...rest }) => rest)(o)
                    : o);
            if (JSON.stringify(stripExecCount(expected.outputs)) !== JSON.stringify(stripExecCount(actualOutputs))) {
                outputMismatches++;
                logger.info(`Outputs mismatch at cell ${i}:`);
                logger.info(`  Expected: ${JSON.stringify(expected.outputs).substring(0, 100)}...`);
                logger.info(`  Actual:   ${JSON.stringify(actualOutputs).substring(0, 100)}...`);
            }
        }

        if (options.compareExecutionCounts && expected.cellType === 'code') {
            const expectedExecutionCount = options.renumberEnabled
                ? (expected.hasOutputs ? nextExecutionCount++ : null)
                : (expected.execution_count ?? null);
            const actualExecutionCount = actual.execution_count ?? null;
            if (expectedExecutionCount !== actualExecutionCount) {
                executionMismatches++;
                logger.info(`Execution count mismatch at cell ${i}: expected ${expectedExecutionCount}, got ${actualExecutionCount}`);
            }
        }
    }

    if (sourceMismatches > 0) {
        throw new Error(`${sourceMismatches} cells have source mismatches`);
    }

    if (typeMismatches > 0) {
        throw new Error(`${typeMismatches} cells have type mismatches`);
    }

    if (metadataMismatches > 0) {
        throw new Error(`${metadataMismatches} cells have metadata mismatches`);
    }

    if (outputMismatches > 0) {
        throw new Error(`${outputMismatches} cells have output mismatches`);
    }

    if (executionMismatches > 0) {
        throw new Error(`${executionMismatches} cells have execution count mismatches`);
    }
}

/**
 * Build an `ExpectedCell[]` directly from a notebook file.
 */
export function buildExpectedCellsFromNotebook(notebook: any): ExpectedCell[] {
    if (!notebook || !Array.isArray(notebook.cells)) {
        return [];
    }
    return notebook.cells.map((cell: any, index: number) => {
        const cellType = cell?.cell_type || 'code';
        const hasOutputs = cellType === 'code' &&
            Array.isArray(cell.outputs) &&
            cell.outputs.length > 0;
        return {
            rowIndex: index,
            source: getCellSource(cell),
            cellType,
            metadata: cell?.metadata || {},
            hasOutputs,
            execution_count: cellType === 'code' ? (cell.execution_count ?? null) : undefined,
        };
    });
}

/**
 * Read a notebook fixture from this repository's `test-fixtures/` directory.
 */
export function readNotebookFixtureFromRepo(fileName: string): any {
    const fixturePath = path.resolve(__dirname, '..', fileName);
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}
