/**
 * @file styles.ts
 * @description Shared styles for the conflict resolver UI.
 */

export const styles = `
:root {
    --bg-primary: #1e1e1e;
    --bg-secondary: #252526;
    --bg-tertiary: #2d2d2d;
    --border-color: #3c3c3c;
    --text-primary: #f3f3f3;
    --text-secondary: #808080;
    --accent-blue: #007acc;
    --accent-green: #4ec9b0;
    --current-bg: rgba(64, 164, 223, 0.15);
    --current-border: #40a4df;
    --incoming-bg: rgba(78, 201, 176, 0.15);
    --incoming-border: #4ec9b0;
    --base-bg: rgba(128, 128, 128, 0.15);
    --base-border: #808080;
    --diff-add: rgba(78, 201, 176, 0.3);
    --diff-remove: rgba(244, 135, 113, 0.3);
    --diff-change: rgba(255, 213, 79, 0.3);
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.5;
}

.app-container {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
}

/* Header */
.header {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 16px;
}

.header-title {
    font-size: 14px;
    font-weight: 600;
}

.file-path {
    font-size: 12px;
    color: var(--text-secondary);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
}

.header-right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.conflict-counter {
    font-size: 12px;
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border-radius: 12px;
}

/* Buttons */
.btn {
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
}

.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn-primary {
    background: var(--accent-blue);
    color: white;
}

.btn-primary:hover:not(:disabled) {
    background: #1a8ad4;
}

.btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
}

.btn-secondary:hover:not(:disabled) {
    background: #3c3c3c;
}

/* Main content */
.main-content {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
}

/* Column labels */
.column-labels {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    padding: 8px 0;
    z-index: 50;
}

.column-label {
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 8px;
    border-radius: 4px;
}

.column-label.base { background: var(--base-bg); color: var(--base-border); }
.column-label.current { background: var(--current-bg); color: var(--current-border); }
.column-label.incoming { background: var(--incoming-bg); color: var(--incoming-border); }

/* Merge rows */
.merge-row {
    margin-bottom: 16px;
    border-radius: 6px;
    overflow: hidden;
}

.merge-row.conflict-row {
    border: 2px solid var(--border-color);
    background: var(--bg-secondary);
}

.merge-row.identical-row {
    opacity: 0.7;
}

.cell-columns {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1px;
    background: var(--border-color);
}

.cell-column {
    background: var(--bg-primary);
    padding: 12px;
    min-height: 60px;
    display: flex;
    flex-direction: column;
}

/* Cell content */
.notebook-cell {
    border-radius: 4px;
    overflow: hidden;
    flex: 1;
    display: flex;
    flex-direction: column;
}

.cell-content {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 13px;
    line-height: 1.5;
}

.cell-content {
    color: var(--text-primary);
}

/* Ensure markdown and inline/code blocks use the same primary text color */
.markdown-content,
.markdown-content *,
.cell-content pre,
.markdown-content pre,
.markdown-content code {
    color: var(--text-primary);
}

.cell-content pre {
    margin: 0;
    padding: 12px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
}

.code-cell .cell-content pre {
    border-left: 3px solid var(--accent-blue);
}

.markdown-cell .cell-content {
    padding: 12px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    border-left: 3px solid var(--accent-green);
}

/* Placeholder for empty cells */
.cell-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60px;
    color: var(--text-primary);
    font-style: italic;
    font-size: 12px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    border: 1px dashed var(--border-color);
}

.cell-placeholder.cell-deleted {
    border-color: #a86b6b;
    color: #d2a6a6;
}

.metadata-cell pre {
    margin: 0;
    padding: 12px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border-left: 3px solid var(--base-border);
}

/* Resolution bar */
.resolution-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
}

.resolution-bar .btn-resolve {
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
}

.btn-resolve.btn-base {
    background: var(--base-bg);
    border-color: var(--base-border);
    color: var(--text-primary);
}

.btn-resolve.btn-current {
    background: var(--current-bg);
    border-color: var(--current-border);
    color: var(--text-primary);
}

.btn-resolve.btn-incoming {
    background: var(--incoming-bg);
    border-color: var(--incoming-border);
    color: var(--text-primary);
}

.btn-resolve.btn-both {
    background: var(--bg-tertiary);
    border-color: var(--border-color);
    color: var(--text-primary);
}

.btn-resolve:hover {
    filter: brightness(1.2);
}

.btn-resolve.selected {
    box-shadow: 0 0 0 2px var(--accent-blue);
}

/* Diff highlighting */
.diff-line {
    display: block;
    padding: 0 4px;
    margin: 0 -4px;
}

.diff-line.added {
    background: var(--diff-add);
}

.diff-line.removed {
    background: var(--diff-remove);
}

.diff-line.changed {
    background: var(--diff-change);
}

/* Cell outputs */
.cell-outputs {
    margin-top: 8px;
    padding: 8px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    font-size: 12px;
}

.cell-outputs img {
    max-width: 100%;
    height: auto;
}

/* Auto-resolve banner */
.auto-resolve-banner {
    background: rgba(78, 201, 176, 0.1);
    border: 1px solid var(--accent-green);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
}

.auto-resolve-banner .icon {
    font-size: 20px;
}

.auto-resolve-banner .text {
    font-size: 13px;
}

/* Loading/Error states */
.loading-container,
.error-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    gap: 16px;
}

.spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border-color);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.error-container {
    color: #f48771;
}

.error-container h2 {
    font-size: 18px;
}

/* Markdown rendering */
.markdown-content {
    color: var(--text-primary);
}

.markdown-content h1, .markdown-content h2, .markdown-content h3,
.markdown-content h4, .markdown-content h5, .markdown-content h6 {
    margin-top: 16px;
    margin-bottom: 8px;
    font-weight: 600;
}

.markdown-content p {
    margin-bottom: 8px;
}

.markdown-content code {
    background: var(--bg-primary);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 0.9em;
}

.markdown-content pre code {
    display: block;
    padding: 12px;
    overflow-x: auto;
}

.markdown-content ul, .markdown-content ol {
    margin-left: 24px;
    margin-bottom: 8px;
}

.markdown-content blockquote {
    border-left: 4px solid var(--border-color);
    padding-left: 16px;
    margin: 8px 0;
    color: var(--text-secondary);
}

/* MathJax styles */
.mjx-container {
    margin: 16px 0;
    overflow-x: auto;
    display: flex;
    justify-content: center;
}

/* Custom editor for custom content */
.custom-editor {
    grid-column: 1 / -1;
    padding: 16px;
    background: var(--bg-secondary);
    border-radius: 6px;
    margin-bottom: 12px;
}

.custom-content-input {
    width: 100%;
    min-height: 200px;
    padding: 12px;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 13px;
    resize: vertical;
}

/* Resolved cell styling - green highlighting to mark as resolved */
.resolved-cell {
    margin-top: 12px;
    padding: 12px;
    background: rgba(78, 201, 176, 0.1);
    border: 2px solid var(--accent-green);
    border-radius: 6px;
}

.resolved-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(78, 201, 176, 0.3);
}

.resolved-label {
    color: var(--accent-green);
    font-weight: 600;
    font-size: 13px;
}

.resolved-base {
    font-size: 12px;
    color: var(--text-secondary);
}

.resolved-base strong {
    color: var(--text-primary);
    text-transform: capitalize;
}

.modified-badge {
    margin-left: 8px;
    padding: 2px 6px;
    background: rgba(255, 213, 79, 0.2);
    border: 1px solid rgba(255, 213, 79, 0.5);
    border-radius: 4px;
    color: #ffd54f;
    font-size: 11px;
}

.resolved-content-input {
    width: 100%;
    min-height: 120px;
    padding: 12px;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid rgba(78, 201, 176, 0.4);
    border-radius: 4px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 13px;
    resize: vertical;
    line-height: 1.5;
}

.resolved-content-input:focus {
    outline: none;
    border-color: var(--accent-green);
    box-shadow: 0 0 0 2px rgba(78, 201, 176, 0.2);
}

/* Resolved deleted cell */
.resolved-cell.resolved-deleted {
    background: rgba(244, 135, 113, 0.1);
    border-color: #f48771;
}

.resolved-deleted .resolved-label {
    color: #f48771;
}

/* Resolved row styling */
.merge-row.resolved-row {
    border-left-color: var(--accent-green);
    background: rgba(78, 201, 176, 0.03);
}

/* Warning modal for branch change */
.warning-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.warning-modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 24px;
    max-width: 400px;
    text-align: center;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.warning-icon {
    font-size: 32px;
    margin-bottom: 12px;
}

.warning-modal h3 {
    font-size: 16px;
    margin-bottom: 12px;
    color: var(--text-primary);
}

.warning-modal p {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 20px;
    line-height: 1.5;
}

.warning-actions {
    display: flex;
    gap: 12px;
    justify-content: center;
}

.warning-actions .btn-cancel {
    padding: 8px 16px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
}

.warning-actions .btn-confirm {
    padding: 8px 16px;
    background: #f48771;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
}

.warning-actions .btn-confirm:hover {
    background: #e67867;
}

.editor-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
}

.btn-save {
    padding: 8px 16px;
    background: var(--accent-blue);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
}

.btn-save:hover {
    background: #0062a3;
}

.btn-cancel {
    padding: 8px 16px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
}

.btn-cancel:hover {
    background: var(--bg-secondary);
}

/* Drag and drop styles */
.merge-row.dragging {
    opacity: 0.5;
    cursor: move;
}

.merge-row[draggable="true"] {
    cursor: grab;
}

.merge-row[draggable="true"]:active {
    cursor: grabbing;
}

/* Conflict row - red border for actual conflicts */
.merge-row.conflict-row {
    background: rgba(244, 135, 113, 0.05);
    border-left: 4px solid #f48771;
    margin: 8px 0;
    border-radius: 4px;
}

/* Unmatched row - yellow border for cells that couldn't be matched */
.merge-row.unmatched-row {
    background: rgba(255, 193, 7, 0.08);
    border-left: 4px solid #ffc107;
    margin: 8px 0;
    border-radius: 4px;
}

/* Unmatched indicator in column label */
.merge-row.unmatched-row .column-label::after {
    content: ' (unmatched)';
    font-size: 10px;
    opacity: 0.7;
    margin-left: 4px;
}

/* When a row is both conflict and unmatched, use orange */
.merge-row.conflict-row.unmatched-row {
    border-left-color: #ff9800;
    background: rgba(255, 152, 0, 0.08);
}

/* Drop zones for drag and drop */
.drop-zone {
    min-height: 40px;
    border: 2px dashed transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: 12px;
    margin: 4px 0;
}

.drop-zone.drop-target {
    border-color: var(--accent-blue);
    background: rgba(0, 122, 204, 0.15);
}

/* Cell placeholder (for deleted/not present cells) */
.cell-placeholder {
    min-height: 60px;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-style: italic;
    border: 2px dashed var(--border-color);
    border-radius: 4px;
    background: rgba(128, 128, 128, 0.05);
}

.cell-placeholder.drop-target {
    border-color: var(--accent-blue);
    border-style: solid;
    background: rgba(0, 122, 204, 0.2);
}

.cell-placeholder.drop-target .placeholder-text {
    display: none;
}

/* Make cells in unmatched rows draggable */
.merge-row.unmatched-row .notebook-cell {
    cursor: grab;
}

.merge-row.unmatched-row .notebook-cell:active {
    cursor: grabbing;
}

/* While actively dragging a cell */
.merge-row.dragging .notebook-cell {
    opacity: 0.5;
    outline: 2px dashed var(--accent-blue);
}

/* Delete button */
.btn-delete {
    background: rgba(244, 135, 113, 0.2);
    color: #f48771;
    border: 1px solid rgba(244, 135, 113, 0.5);
}

.btn-delete:hover {
    background: rgba(244, 135, 113, 0.3);
}

.btn-delete.selected {
    background: rgba(244, 135, 113, 0.4);
    border-color: #f48771;
    font-weight: 600;
}

/* Enhanced inline diff highlighting for word-level changes */
.diff-inline-unchanged {
    color: var(--text-primary);
}

.diff-inline-added {
    background: var(--diff-add);
    padding: 0 2px;
    border-radius: 2px;
}

.diff-inline-removed {
    background: var(--diff-remove);
    padding: 0 2px;
    border-radius: 2px;
    text-decoration: line-through;
}
`;

export function injectStyles(): void {
    if (typeof document !== 'undefined') {
        const existing = document.getElementById('mergenb-styles');
        if (existing) return;

        const style = document.createElement('style');
        style.id = 'mergenb-styles';
        style.textContent = styles;
        document.head.appendChild(style);
    }
}
