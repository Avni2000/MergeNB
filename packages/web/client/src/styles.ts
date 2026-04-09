/**
 * @file styles.ts
 * @description Shared styles for the conflict resolver UI.
 */

function getStyles(theme: 'dark' | 'light' = 'light', scope?: string): string {
    const isDark = theme === 'dark';

    // Checkered background gradients
    const DARK_GRID_GRADIENT = `linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)`;

    // Checkered background gradient for light theme
    const LIGHT_GRID_GRADIENT = `linear-gradient(to right, rgba(0,0,0,0.05) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(0,0,0,0.05) 1px, transparent 1px)`;

    // Color palette based on theme
    const colors = isDark ? {
        // VSCode-style dark theme
        bgPrimary: '#252526',
        bgSecondary: '#1e1e1e',
        bgTertiary: '#2d2d30',
        bgQuarternary: '#2d2d30',
        bgHover: '#333337',
        borderColor: 'rgba(255, 255, 255, 0.10)',
        textPrimary: '#d4d4d4',
        textSecondary: '#858585',
        accentBlue: '#569cd6',
        accentGreen: '#4ec9b0',
        currentBg: 'rgba(86, 156, 214, 0.45)',
        currentBorder: '#569cd6',
        currentRgb: '86, 156, 214',
        incomingBg: 'rgba(78, 201, 176, 0.45)',
        incomingBorder: '#4ec9b0',
        incomingRgb: '78, 201, 176',
        baseBg: 'rgba(133, 133, 133, 0.35)',
        baseBorder: '#555555',
        diffAdd: 'rgba(78, 201, 176, 0.20)',
        diffRemove: 'rgba(217, 54, 21, 0.33)',
        diffChange: 'rgba(86, 156, 214, 0.15)',
        cellSurface: 'rgba(45, 45, 48, 0.90)',
        cellSurfaceSoft: 'rgba(45, 45, 48, 0.70)',
        cellPlaceholderBg: 'rgba(45, 45, 48, 0.55)',
        outputBg: 'rgba(30, 30, 30, 0.80)',
        bodyBackground: '#1e1e1e',
        bodyBackgroundImage: DARK_GRID_GRADIENT,
        logoLeft: '#A4D4DE',
        logoRight: '#C3C9F2',
        logoBlendMode: 'normal',
    } : {
        // LIGHT theme - inspired by MergeNB logo
        bgPrimary: '#f1ece3',
        bgSecondary: '#ebe3d8',
        bgTertiary: '#e2d8ca',
        bgQuarternary: '#ebe3d8b7',
        bgHover: '#d9cfbf',
        borderColor: 'rgba(0, 0, 0, 0.1)',
        textPrimary: '#1A202C',
        textSecondary: '#6B7280',
        accentBlue: '#569cd6',
        accentGreen: '#4ec9b0',
        currentBg: 'rgba(164, 212, 222, 0.45)',
        currentBorder: '#A4D4DE',
        currentRgb: '164, 212, 222',
        incomingBg: 'rgba(159, 168, 221, 0.50)',
        incomingBorder: '#9FA8DD',
        incomingRgb: '159, 168, 221',
        baseBg: 'rgba(128, 128, 128, 0.38)',
        baseBorder: '#8b7f70',
        diffAdd: 'rgba(195, 201, 242, 0.4)',
        diffRemove: 'rgba(217, 54, 21, 0.33)',
        diffChange: 'rgba(255, 193, 7, 0.35)',
        cellSurface: 'rgba(226, 216, 202, 0.78)',
        cellSurfaceSoft: 'rgba(226, 216, 202, 0.62)',
        cellPlaceholderBg: 'rgba(226, 216, 202, 0.48)',
        outputBg: 'rgba(226, 216, 202, 0.66)',
        bodyBackground: '#EAE2D5',
        bodyBackgroundImage: LIGHT_GRID_GRADIENT,
        logoLeft: '#A4D4DE',
        logoRight: '#C3C9F2',
        logoBlendMode: 'multiply',
    };

    const hasBackgroundImage = colors.bodyBackgroundImage !== 'none';

    const rootSel = scope ?? ':root';
    const bodySel = scope ?? 'body';
    const universalSel = scope ? `${scope} *` : '*';
    const htmlBodyBlock = scope ? '' : `
html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
}`;

    return `
        /* Load Inter, Playfair Display, and JetBrains Mono from Google Fonts */
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&family=Playfair+Display:ital,wght@1,500&display=swap');

${rootSel} {
    --font-ui: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
    
    /* Code Font: Inherit VS Code's Editor font, fall back to standard monospace */
    --font-code: "JetBrains Mono", "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace;

    --bg-primary: ${colors.bgPrimary};
    --bg-secondary: ${colors.bgSecondary};
    --bg-tertiary: ${colors.bgTertiary};
    --bg-quarternary: ${colors.bgQuarternary};
    --bg-hover: ${colors.bgHover};
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
    --cell-surface: ${colors.cellSurface};
    --cell-surface-soft: ${colors.cellSurfaceSoft};
    --cell-placeholder-bg: ${colors.cellPlaceholderBg};
    --output-bg: ${colors.outputBg};
    --logo-left: ${colors.logoLeft};
    --logo-right: ${colors.logoRight};
    --logo-blend-mode: ${colors.logoBlendMode};
}

${htmlBodyBlock}

${universalSel} {
    box-sizing: border-box;
}

${bodySel} {
    margin: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-weight: 400;
    background: ${colors.bodyBackground};
    ${hasBackgroundImage ? `background-image: ${colors.bodyBackgroundImage};` : ''}
    ${hasBackgroundImage ? 'background-size: 20px 20px;' : ''}
    color: var(--text-primary);
    line-height: 1.5;
}

.app-container {
    height: 100vh;
    display: flex;
    flex-direction: column;
}

/* Header */
.header {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 100;
    user-select: none;
}

.header-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 16px;
}

/* Logo icon */
.logo-icon {
    position: relative;
    width: 60px;
    height: 40px;
    display: flex;
    justify-content: center;
    align-items: center;
}

.logo-card {
    position: absolute;
    width: 30px;
    height: 36px;
    border-radius: 6px;
    mix-blend-mode: var(--logo-blend-mode);
    opacity: 0.9;
    transform-origin: 50% 90%;
    top: 0;
}

.logo-card-left {
    background-color: var(--logo-left);
    left: 6px;
    transform: rotate(-25deg);
}

.logo-card-right {
    background-color: var(--logo-right);
    right: 6px;
    transform: rotate(25deg);
}

.header-title {
    display: flex;
    align-items: baseline;
    gap: 0;
    color: var(--text-primary);
    line-height: 1;
    letter-spacing: -0.03em;
}

.header-title-merge {
    font-family: "Playfair Display", var(--font-ui);
    font-style: italic;
    font-weight: 500;
    font-size: 24px;
    letter-spacing: -0.02em;
}

.header-title-nb {
    font-family: var(--font-ui);
    font-weight: 700;
    font-size: 24px;
}

.file-path {
    font-size: 12px;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-weight: 400;
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
    overflow-anchor: none;
}

/* Column labels (aligned with .main-content horizontal padding) */
.column-labels {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 12px;
    position: sticky;
    top: 0;
    background: transparent;
    padding: 8px 0;
    z-index: 50;
    user-select: none;
    border-top: 1px solid var(--border-color);
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

.column-label.base { background: var(--base-bg); color: var(--text-primary); }
.column-label.current { background: var(--current-bg); color: var(--text-primary); }
.column-label.incoming { background: var(--incoming-bg); color: var(--text-primary); }

/* Merge rows */
.merge-row {
    margin-bottom: 0;
    border-radius: 6px;
    overflow: clip;
    position: relative;
}

/* Conflict row - consolidated styling: subtle red background with
   a consistent 3px border on top/right/bottom and a 4px left accent */
.merge-row.conflict-row {
    background: rgba(244, 135, 113, 0.05);
    border-top: 3px solid rgba(244, 135, 113, 0.6);
    border-right: 3px solid rgba(244, 135, 113, 0.6);
    border-bottom: 3px solid rgba(244, 135, 113, 0.6);
    border-left: 4px solid rgba(244, 135, 113, 0.6);
    border-radius: 6px;
}

.merge-row.identical-row {
    /* No opacity reduction - keep text readable */
}

.cell-columns {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: transparent;
}

.cell-columns.two-column {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.cell-column {
    background: transparent;
    padding: 12px;
    min-height: 60px;
    display: flex;
    flex-direction: column;
}

/* Cell content */
.notebook-cell {
    border-radius: 4px;
    overflow: clip;
    flex: 1;
    display: flex;
    flex-direction: column;
}

.cell-header {
    display: flex;
    gap: 8px;
    padding: 4px 8px;
    font-size: 11px;
    font-family: var(--font-ui);
    font-weight: 400;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
    user-select: none;
}

.cell-header-type {
    text-transform: capitalize;
    font-weight: 600;
}

.cell-header-index,
.cell-header-exec {
    opacity: 0.7;
}

.cell-content {
    font-family: var(--font-ui);
    font-weight: 400;
    font-size: 13px;
    line-height: 1.5;
}

.cell-content {
    color: var(--text-primary);
}

/* Ensure markdown and inline/code blocks use the same primary text color */
.markdown-content,
.markdown-content p,
.markdown-content li,
.markdown-content td,
.markdown-content th,
.markdown-content blockquote,
.cell-content pre,
.markdown-content pre,
.markdown-content code {
    color: var(--text-primary);
}

.cell-content pre {
    margin: 0;
    padding: 12px;
    background: var(--cell-surface);
    border-radius: 4px;
    overflow: clip;
    white-space: pre-wrap;
    word-break: break-word;
}

.code-cell .cell-content pre {
    background: var(--bg-primary);
    border-left: 3px solid var(--accent-blue);
}

.markdown-cell:not(.has-conflict) .cell-content {
    padding: 12px;
    background: var(--cell-surface);
    border-radius: 4px;
    border-left: 3px solid var(--accent-green);
}

.markdown-cell .cell-content pre {
    font-family: var(--font-ui);
    white-space: pre-wrap;
    margin: 0;
}

/* Markdown cells in conflict mode: green border on the pre element (matches code cell pattern) */
.markdown-cell.has-conflict .cell-content pre {
    background: var(--cell-surface);
    border-left: 3px solid var(--accent-green);
}

.cell-placeholder.cell-deleted {
    border-color: #a86b6b;
    color: #d2a6a6;
}

/* Resolution bar */
.resolution-bar {
    background: var(--bg-quarternary);
    border-top: 1px solid var(--border-color);
    user-select: none;
}

.resolution-bar .cell-column {
    display: flex;
    justify-content: center;
    align-items: center;
}

.btn-resolve {
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

.btn-resolve:hover {
    filter: brightness(1.2);
}

.btn-resolve.selected {
    box-shadow: 0 0 0 2px var(--accent-blue);
}

/* Static diff line wrappers — span (not div) so selection works across lines */
.source-line {
    display: block;
}

/* Static code uses @uiw/codemirror-theme-github HighlightStyle (see CellContent.tsx) */
.cell-source-static code,
.markdown-content pre.has-syntax-highlight code {
    font-family: var(--font-code);
    font-weight: 400;
}

/* Markdown cells in conflict mode: no <code> wrapper, so style the <pre> directly with UI font */
.markdown-cell .cell-source-static {
    font-family: var(--font-ui);
}

/* Diff highlighting — applied as CodeMirror line decorations on .cm-line elements */
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
    background: var(--output-bg);
    border-radius: 4px;
    font-size: 12px;
}

.cell-output-item + .cell-output-item {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color);
}

.cell-output-host {
    color: var(--text-primary);
}

.cell-output-host .jp-RenderedText,
.cell-output-host .jp-RenderedHTMLCommon,
.cell-output-host .jp-RenderedImage,
.cell-output-host .jp-RenderedSVG,
.cell-output-host .jp-RenderedLatex {
    color: var(--text-primary);
}

.cell-output-host .jp-RenderedText pre,
.cell-output-host .jp-RenderedHTMLCommon pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.cell-output-host .jp-RenderedText[data-mime-type='application/vnd.jupyter.stderr'] {
    background: var(--diff-remove);
    border-radius: 4px;
    padding: 8px;
}

.cell-output-fallback {
    margin: 0;
    padding: 8px;
    background: var(--cell-surface-soft);
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-code);
    font-weight: 400;
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
    margin-bottom: 16px;
    overflow: hidden;
    user-select: none;
}

.auto-resolve-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px 16px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
}

.auto-resolve-summary:hover {
    background: rgba(78, 201, 176, 0.08);
}

.auto-resolve-banner .icon {
    font-size: 20px;
    flex-shrink: 0;
}

.auto-resolve-banner .text {
    font-size: 13px;
    flex: 1;
}

.auto-resolve-banner .chevron {
    font-size: 10px;
    opacity: 0.7;
    flex-shrink: 0;
}

.auto-resolve-list {
    margin: 0;
    padding: 0 16px 12px 48px;
    list-style: disc;
    font-size: 13px;
    opacity: 0.85;
    line-height: 1.8;
}

/* Loading/Error states */
.loading-container {
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

/* Markdown rendering - inherited from JupyterLab jp-RenderedMarkdown
   with minimal local overrides for container spacing and code blocks */
.markdown-content {
    color: var(--text-primary);
    word-break: break-word; /* Ensure text wraps */
}

/* Ensure consistent text colors in all Jupyter widgets */
.jp-RenderedText,
.jp-RenderedHTMLCommon,
.jp-RenderedImage,
.jp-RenderedSVG,
.jp-RenderedMarkdown,
.jp-RenderedLatex {
    color: var(--text-primary) !important;
}

/* Local overrides for JupyterLab's rendering to maintain consistent feel */
.markdown-content code {
    background: var(--bg-primary);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: var(--font-code);
    font-weight: 400;
    font-size: 0.9em;
}

.markdown-content pre code {
    display: block;
    padding: 12px;
    overflow-x: auto;
}

.markdown-content p {
    margin-bottom: 8px;
}

.markdown-content h1,
.markdown-content h2,
.markdown-content h3,
.markdown-content h4,
.markdown-content h5,
.markdown-content h6 {
    color: var(--text-primary);
    line-height: 1.25;
    margin: 16px 0 8px;
    font-weight: 650;
}

.markdown-content h1 { font-size: 1.5rem; }
.markdown-content h2 { font-size: 1.3rem; }
.markdown-content h3 { font-size: 1.15rem; }
.markdown-content h4 { font-size: 1.05rem; }
.markdown-content h5 { font-size: 0.95rem; }
.markdown-content h6 { font-size: 0.9rem; color: var(--text-secondary); }

.markdown-content a {
    color: var(--accent-blue);
    text-decoration: underline;
    text-underline-offset: 2px;
}

.markdown-content a:hover {
    text-decoration-thickness: 2px;
}

.markdown-content blockquote {
    margin: 10px 0;
    padding: 2px 0 2px 12px;
    border-left: 3px solid var(--border-color);
    color: var(--text-secondary);
}

.markdown-content hr {
    border: none;
    border-top: 1px solid var(--border-color);
    margin: 16px 0;
}

.markdown-content strong {
    font-weight: 650;
}

.markdown-content em {
    font-style: italic;
}

.markdown-content ul,
.markdown-content ol {
    margin-bottom: 8px;
    padding-left: 24px;
}

.markdown-content li {
    margin-bottom: 4px;
}

/* Markdown tables - JupyterLab-like styling */
.markdown-content table {
    border-collapse: collapse;
    margin: 16px 0;
    width: 100%;
    border-spacing: 0;
}

.markdown-content th,
.markdown-content td {
    padding: 8px 12px;
    border: 1px solid var(--border-color);
    text-align: left;
}

.markdown-content th {
    background-color: var(--bg-secondary);
    font-weight: 600;
}

.markdown-content tr:nth-child(even) {
    background-color: var(--bg-secondary);
}

.markdown-content tr:hover {
    background-color: var(--bg-hover);
}

.markdown-content img {
    max-width: 100%;
    height: auto;
}

/* KaTeX styles */
.katex-display {
    margin: 16px 0;
    overflow-x: auto;
    text-align: center;
}

/* Resolved cell styling - green highlighting to mark as resolved */
.resolved-cell {
    margin: 12px 24px;
    width: calc(100% - 48px);
    box-sizing: border-box;
    padding: 12px;
    background: var(--cell-surface);
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
    user-select: none;
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
    background: rgba(86, 156, 214, 0.15);
    border: 1px solid rgba(86, 156, 214, 0.35);
    border-radius: 4px;
    color: var(--accent-blue);
    font-size: 11px;
}

/* CodeMirror resolved editor — className="resolved-content-input" targets .cm-editor */
.resolved-content-input.cm-editor {
    width: 100%;
    border: 1px solid rgba(78, 201, 176, 0.4);
    border-radius: 4px;
    outline: none !important;
}

.resolved-cell.markdown-cell .resolved-content-input.cm-editor {
    border-left: 3px solid var(--accent-green);
}

.resolved-cell.markdown-cell .resolved-content-input .cm-content {
    font-family: var(--font-ui) !important;
}

.resolved-cell.code-cell .resolved-content-input.cm-editor {
    background: var(--bg-primary);
    border-left: 3px solid var(--accent-blue);
}

.resolved-content-input.cm-editor.cm-focused {
    border-color: var(--accent-green);
    box-shadow: 0 0 0 2px rgba(78, 201, 176, 0.2);
    outline: none !important;
}

.resolved-content-input .cm-scroller {
    min-height: 100px;
    overflow: auto;
}

.resolved-content-input .cm-content {
    padding: 10px 12px;
}

.resolved-content-input .cm-line {
    padding: 0;
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
    border-color: var(--accent-green);
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

/* Conflict row - red border for actual conflicts
   (consolidated rule moved earlier to avoid duplicate definitions) */

/* Unmatched row - subtle indicator for cells that couldn't be matched */
.merge-row.unmatched-row {
    background: transparent;
    border-radius: 4px;
}

/* When a row is both conflict and unmatched, keep conflict styling */
.merge-row.conflict-row.unmatched-row {
    background: transparent;
}

.virtual-row {
    padding-bottom: 16px;
}

/* Cell placeholder (for deleted/not present cells) */
.cell-placeholder {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 60px;
    color: var(--text-secondary);
    font-style: italic;
    font-size: 12px;
    border: 2px dashed var(--border-color);
    border-radius: 4px;
    background: var(--cell-placeholder-bg);
    user-select: none;
}

/* Delete button */
.btn-delete {
    background: rgba(255, 75, 75, 0.4);
    color: rgb(255, 255, 255);
    border: 1px solid rgba(211, 47, 47, 0.5);
}

.btn-delete:hover {
    background: rgba(211, 49, 49, 0.5);
}

.btn-delete.selected {
    background: rgba(183, 28, 28, 0.5);
    border-color: rgba(183, 28, 28, 0.5);
    font-weight: 600;
}

/* Inline diff highlighting — applied as CodeMirror mark decorations.
   No color override so syntax highlighting colours show through. */
.diff-inline-conflict {
    background: var(--diff-remove);
}

.diff-inline-current {
    background: var(--diff-add);
}

.diff-inline-incoming {
    background: rgba(86, 156, 214, 0.35);
}

/* Reordered row — subtle left border only */
.merge-row.reordered-row {
    background: transparent;
    border-radius: 4px;
}

/* Conflict Action Bar */
.conflict-action-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
    font-size: 12px;
    user-select: none;
}

.conflict-action-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

.conflict-action-right {
    display: flex;
    align-items: center;
    gap: 12px;
    /* Ensure consistent layout during opacity transitions */
    contain: style;
}

/* Reorder indicator bar */
.reorder-indicator-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
    font-size: 12px;
    user-select: none;
}

.reorder-delta {
    font-family: var(--font-ui);
    font-weight: 600;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
}

.reorder-delta.current-delta {
    background: var(--current-bg);
    color: var(--text-primary);
}

.reorder-delta.incoming-delta {
    background: var(--incoming-bg);
    color: var(--text-primary);
}

/* Unmatch/Rematch container for smooth transitions */
.unmatch-rematch-group {
    display: flex;
    align-items: center;
    gap: 8px;
    will-change: opacity;
}

.unmatch-rematch-group.unmatch-visible .btn-unmatch {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.2s ease;
}

.unmatch-rematch-group.rematch-visible .btn-unmatch {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
}

.unmatch-rematch-group.rematch-visible .rematch-label,
.unmatch-rematch-group.rematch-visible .btn-rematch {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.2s ease;
}

.unmatch-rematch-group.unmatch-visible .rematch-label,
.unmatch-rematch-group.unmatch-visible .btn-rematch {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
}

/* Unmatch button */
.btn-unmatch {
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid var(--border-color);
    cursor: pointer;
    background: var(--bg-primary);
    color: var(--text-secondary);
    will-change: opacity;
}

.btn-unmatch:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

/* User-unmatched row — subtle indicator */
.merge-row.user-unmatched-row {
    background: transparent;
    border-radius: 4px;
}

.rematch-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    will-change: opacity;
}

.btn-rematch {
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid var(--border-color);
    cursor: pointer;
    background: var(--bg-primary);
    color: var(--text-secondary);
    will-change: opacity;
}

.btn-rematch:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

/* Preview mode */
.btn-preview-active {
    background: var(--bg-tertiary) !important;
    border-color: var(--text-secondary) !important;
}

.preview-content {
    display: flex;
    justify-content: center;
}

.preview-column {
    width: 100%;
    max-width: 900px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 24px;
}

.preview-column > * {
    flex-shrink: 0;
}

.preview-cell {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    overflow: clip;
}

.preview-cell > .notebook-cell {
    flex: none;
    display: block;
}

.preview-cell-unresolved {
    background: var(--cell-placeholder-bg);
    border: 2px dashed rgba(244, 135, 113, 0.6);
}

.preview-unresolved-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60px;
    color: rgba(244, 135, 113, 0.8);
    font-style: italic;
    font-size: 12px;
    user-select: none;
}
`;
}

export function injectStyles(theme: 'dark' | 'light' = 'light', scope?: string): void {
    if (typeof document !== 'undefined') {
        const id = scope ? 'mergenb-styles-scoped' : 'mergenb-styles';
        const existing = document.getElementById(id);
        if (existing) {
            existing.textContent = getStyles(theme, scope);
            return;
        }

        const style = document.createElement('style');
        style.id = id;
        style.textContent = getStyles(theme, scope);
        document.head.appendChild(style);
    }
}
