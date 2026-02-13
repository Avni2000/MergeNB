/**
 * @file styles.ts
 * @description Shared styles for the conflict resolver UI.
 */

export function getStyles(theme: 'dark' | 'elegant' = 'elegant'): string {
    const isDark = theme === 'dark';
    
    // Checkered background gradient for elegant theme
    const ELEGANT_GRID_GRADIENT = `linear-gradient(to right, rgba(0,0,0,0.05) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(0,0,0,0.05) 1px, transparent 1px)`;

    // Color palette based on theme
    const colors = isDark ? {
        bgPrimary: '#1e1e1e',
        bgSecondary: '#252526',
        bgTertiary: '#2d2d2d',
        borderColor: '#3c3c3c',
        textPrimary: '#f3f3f3',
        textSecondary: '#808080',
        accentBlue: '#007acc',
        accentGreen: '#4ec9b0',
        currentBg: 'rgba(64, 164, 223, 0.15)',
        currentBorder: '#40a4df',
        currentRgb: '64, 164, 223',
        incomingBg: 'rgba(78, 201, 176, 0.15)',
        incomingBorder: '#4ec9b0',
        incomingRgb: '78, 201, 176',
        baseBg: 'rgba(128, 128, 128, 0.15)',
        baseBorder: '#808080',
        diffAdd: 'rgba(78, 201, 176, 0.3)',
        diffRemove: 'rgba(244, 135, 113, 0.3)',
        diffChange: 'rgba(255, 213, 79, 0.3)',
        bodyBackground: '#1e1e1e',
        bodyBackgroundImage: 'none',
    } : {
        // Elegant theme - inspired by MergeNB logo
        bgPrimary: '#ffffff',
        bgSecondary: '#f5f2ec',
        bgTertiary: '#ebe7df',
        borderColor: 'rgba(0, 0, 0, 0.1)',
        textPrimary: '#1A202C',
        textSecondary: '#6B7280',
        accentBlue: '#569cd6',
        accentGreen: '#4ec9b0',
        currentBg: 'rgba(164, 212, 222, 0.25)',
        currentBorder: '#A4D4DE',
        currentRgb: '164, 212, 222',
        incomingBg: 'rgba(195, 201, 242, 0.25)',
        incomingBorder: '#C3C9F2',
        incomingRgb: '195, 201, 242',
        baseBg: 'rgba(128, 128, 128, 0.12)',
        baseBorder: '#999999',
        diffAdd: 'rgba(195, 201, 242, 0.4)',
        diffRemove: 'rgba(244, 135, 113, 0.35)',
        diffChange: 'rgba(255, 193, 7, 0.35)',
        bodyBackground: '#F9F7F1',
        bodyBackgroundImage: ELEGANT_GRID_GRADIENT,
    };

    const hasBackgroundImage = colors.bodyBackgroundImage !== 'none';

    return `
:root {
    --bg-primary: ${colors.bgPrimary};
    --bg-secondary: ${colors.bgSecondary};
    --bg-tertiary: ${colors.bgTertiary};
    --border-color: ${colors.borderColor};
    --text-primary: ${colors.textPrimary};
    --text-secondary: ${colors.textSecondary};
    --accent-blue: ${colors.accentBlue};
    --accent-green: ${colors.accentGreen};
    --current-bg: ${colors.currentBg};
    --current-border: ${colors.currentBorder};
    --current-rgb: ${colors.currentRgb};
    --incoming-bg: ${colors.incomingBg};
    --incoming-border: ${colors.incomingBorder};
    --incoming-rgb: ${colors.incomingRgb};
    --base-bg: ${colors.baseBg};
    --base-border: ${colors.baseBorder};
    --diff-add: ${colors.diffAdd};
    --diff-remove: ${colors.diffRemove};
    --diff-change: ${colors.diffChange};
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: ${colors.bodyBackground};
    ${hasBackgroundImage ? `background-image: ${colors.bodyBackgroundImage};` : ''}
    ${hasBackgroundImage ? 'background-size: 20px 20px;' : ''}
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

.header-group {
    display: flex;
    align-items: center;
    gap: 6px;
}

.conflict-counter {
    font-size: 12px;
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border-radius: 12px;
}

/* History panel */
.history-panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 0;
}

.history-menu {
    position: relative;
}

.history-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: 320px;
    z-index: 200;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
    opacity: 0;
    transform: translateY(-6px);
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
}

.history-dropdown.open {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
}

.history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}

.history-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-secondary);
    font-weight: 600;
}

.history-actions {
    display: flex;
    gap: 8px;
}

.history-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 120px;
    overflow-y: auto;
}

.history-item {
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.history-item:hover {
    background: #3a3a3a;
}

.history-item.current {
    border: 1px solid var(--accent-blue);
    background: rgba(0, 122, 204, 0.15);
}

.history-item.future {
    opacity: 0.55;
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
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 12px;
    position: sticky;
    top: 0;
    background: var(--bg-primary);
    padding: 8px 0;
    z-index: 50;
}

.column-labels.two-column {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
    margin-bottom: 0;
    border-radius: 6px;
    overflow: hidden;
    position: relative;
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
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: var(--border-color);
}

.cell-columns.two-column {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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

.diff-line.modified-old {
    background: var(--diff-remove);
}

.diff-line.modified-new {
    background: var(--diff-add);
}

.diff-line.diff-line-conflict {
    background: var(--diff-remove);
}

.diff-line.diff-line-current {
    background: var(--diff-add);
}

.diff-line.diff-line-incoming {
    background: rgba(86, 156, 214, 0.28);
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

.image-placeholder {
    color: var(--text-secondary);
    font-style: italic;
    padding: 8px;
    background: var(--bg-secondary);
    border: 1px dashed var(--border-color);
    border-radius: 4px;
    font-family: "SF Mono", Monaco, "Cascadia Code", "Courier New", monospace;
    white-space: pre-wrap;
    font-size: 12px;
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

.success-icon {
    font-size: 64px;
    color: #4ec9b0;
    margin-bottom: 16px;
    animation: scaleIn 0.5s ease-out;
}

.success-message {
    font-size: 18px;
    font-weight: 500;
    color: #4ec9b0;
}

.success-subtitle {
    font-size: 14px;
    color: var(--text-secondary);
    margin-top: 8px;
}

.error-icon {
    font-size: 64px;
    color: #f48771;
    margin-bottom: 16px;
    animation: scaleIn 0.5s ease-out;
}

.error-message {
    font-size: 16px;
    color: #f48771;
    text-align: center;
    max-width: 400px;
}

.retry-button {
    margin-top: 16px;
    padding: 8px 24px;
    background: var(--accent-blue);
    color: var(--text-primary);
    border: none;
    border-radius: 4px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s;
}

.retry-button:hover {
    background: #0098ff;
}

@keyframes scaleIn {
    from {
        transform: scale(0.5);
        opacity: 0;
    }
    to {
        transform: scale(1);
        opacity: 1;
    }
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

/* KaTeX styles */
.katex-display {
    margin: 16px 0;
    overflow-x: auto;
    text-align: center;
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
.row-drag-handle {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-size: 10px;
    color: var(--text-secondary);
    cursor: grab;
    user-select: none;
    z-index: 2;
}

.row-drag-handle:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
}

.row-drag-handle:active {
    cursor: grabbing;
}

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
    border-radius: 4px;
}

/* Unmatched row - yellow border for cells that couldn't be matched */
.merge-row.unmatched-row {
    background: rgba(255, 193, 7, 0.08);
    border-left: 4px solid #ffc107;
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

.virtual-row {
    padding-bottom: 16px;
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

/* Enhanced inline diff highlighting - branch-based coloring */
/* The color tells you which branch the content comes from, not whether it's added/removed */
.diff-inline-unchanged {
    color: var(--text-primary);
}

.diff-inline-conflict {
    background: var(--diff-remove);
    color: var(--text-primary);
}

.diff-inline-current {
    background: var(--diff-add);
    color: var(--text-primary);
}

.diff-inline-incoming {
    background: rgba(86, 156, 214, 0.35);
    color: var(--text-primary);
}
`;
}

export function injectStyles(theme: 'dark' | 'elegant' = 'elegant'): void {
    if (typeof document !== 'undefined') {
        const existing = document.getElementById('mergenb-styles');
        if (existing) {
            existing.textContent = getStyles(theme);
            return;
        }

        const style = document.createElement('style');
        style.id = 'mergenb-styles';
        style.textContent = getStyles(theme);
        document.head.appendChild(style);
    }
}

// Keep backward compatibility
export const styles = getStyles('elegant');
