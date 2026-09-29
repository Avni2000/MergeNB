import type { Notebook } from './types';
import { isDictionary } from './json';
import { isValidCellId } from './cellIds';

export function isKnownCellType(type: string): boolean {
    return type === 'code' || type === 'markdown' || type === 'raw';
}

function requireField(condition: boolean, path: string, description: string): void {
    if (!condition) throw new Error(`Invalid notebook: ${path} ${description}`);
}

function isMultiline(value: unknown): boolean {
    return typeof value === 'string' || (Array.isArray(value) && value.every(line => typeof line === 'string'));
}

function isExecutionCount(value: unknown): boolean {
    return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function validateMimeBundle(value: unknown, path: string): void {
    requireField(isDictionary(value), path, 'must be a MIME bundle');
    for (const [mime, data] of Object.entries(value as Record<string, unknown>)) {
        if (mime === 'application/json' || mime.endsWith('+json')) continue;
        requireField(isMultiline(data), `${path}[${JSON.stringify(mime)}]`, 'must be a string or string array');
    }
}

function validateOutput(value: unknown, path: string): void {
    requireField(isDictionary(value), path, 'must be an object');
    const output = value as Record<string, unknown>;
    requireField(typeof output.output_type === 'string', `${path}.output_type`, 'must be a string');
    switch (output.output_type) {
        case 'stream':
            requireField(typeof output.name === 'string', `${path}.name`, 'must be a string');
            requireField(isMultiline(output.text), `${path}.text`, 'must be a string or string array');
            break;
        case 'execute_result':
            requireField(isExecutionCount(output.execution_count), `${path}.execution_count`, 'must be a nonnegative integer or null');
            // The authoritative schema permits null here, as it does for code cells.
            validateMimeBundle(output.data, `${path}.data`);
            requireField(isDictionary(output.metadata), `${path}.metadata`, 'must be an object');
            break;
        case 'display_data':
            validateMimeBundle(output.data, `${path}.data`);
            requireField(isDictionary(output.metadata), `${path}.metadata`, 'must be an object');
            break;
        case 'error':
            requireField(typeof output.ename === 'string' && typeof output.evalue === 'string', path, 'must contain string ename and evalue');
            requireField(Array.isArray(output.traceback) && output.traceback.every(frame => typeof frame === 'string'), `${path}.traceback`, 'must be a string array');
            break;
        // Unknown output types are opaque and retained for future minor versions.
    }
}

/** Validate understood structure without rejecting extension fields or future types. */
export function validateNotebook(value: unknown, requireCellIds: boolean = true): asserts value is Notebook {
    requireField(isDictionary(value), 'document', 'must be an object');
    const notebook = value as Notebook;
    if (notebook.nbformat !== 4) throw new Error(`Unsupported notebook major version: ${notebook.nbformat}. MergeNB supports nbformat 4.x; no conversion was performed.`);
    requireField(Number.isInteger(notebook.nbformat_minor) && notebook.nbformat_minor >= 0, 'nbformat_minor', 'must be a nonnegative integer');
    requireField(isDictionary(notebook.metadata), 'metadata', 'must be an object');
    requireField(Array.isArray(notebook.cells), 'cells', 'must be an array');
    const ids = new Set<string>();
    notebook.cells.forEach((cell, index) => {
        const path = `cells[${index}]`;
        requireField(isDictionary(cell), path, 'must be an object');
        requireField(typeof cell.cell_type === 'string', `${path}.cell_type`, 'must be a string');
        requireField(isDictionary(cell.metadata), `${path}.metadata`, 'must be an object');
        if (requireCellIds && notebook.nbformat_minor >= 5) {
            requireField(isValidCellId(cell.id), `${path}.id`, 'must contain 1–64 letters, digits, hyphens, or underscores');
            requireField(!ids.has(cell.id!), `${path}.id`, 'must be unique');
            ids.add(cell.id!);
        }
        if (!isKnownCellType(cell.cell_type)) return;
        requireField(isMultiline(cell.source), `${path}.source`, 'must be a string or string array');
        if (cell.cell_type === 'code') {
            requireField(isExecutionCount(cell.execution_count), `${path}.execution_count`, 'must be a nonnegative integer or null');
            requireField(Array.isArray(cell.outputs), `${path}.outputs`, 'must be an array');
            cell.outputs!.forEach((output, i) => validateOutput(output, `${path}.outputs[${i}]`));
        } else if (cell.attachments !== undefined) {
            requireField(isDictionary(cell.attachments), `${path}.attachments`, 'must be an object');
            for (const [name, bundle] of Object.entries(cell.attachments)) validateMimeBundle(bundle, `${path}.attachments[${JSON.stringify(name)}]`);
        }
    });
}
