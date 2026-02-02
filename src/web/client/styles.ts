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
    --text-primary: #d4d4d4;
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
}

/* Cell content */
.notebook-cell {
    border-radius: 4px;
    overflow: hidden;
}

.cell-content {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 13px;
    line-height: 1.5;
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
    color: var(--text-secondary);
    font-style: italic;
    font-size: 12px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    border: 1px dashed var(--border-color);
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

/* KaTeX overrides */
.katex-display {
    margin: 16px 0;
    overflow-x: auto;
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
