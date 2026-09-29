/**
 * Normalize cell source to a consistent string format.
 * Notebook sources can be string or string[].
 */
export function normalizeCellSource(source: string | string[] | undefined): string {
    if (Array.isArray(source)) {
        return source.join('');
    }
    return source ?? '';
}

/**
 * Convert cell source back to the array format expected by nbformat.
 * Avoids producing empty strings at the end when source ends with \n.
 */
export function sourceToCellFormat(source: string): string[] {
    if (!source) return [];
    const lines = source.split('\n');
    const result = lines.map((line, i) => i < lines.length - 1 ? line + '\n' : line);
    // Remove empty string at the end if source ended with \n (split produces ["a", "b", ""])
    if (result.length > 0 && result[result.length - 1] === '') {
        result.pop();
    }
    return result;
}

