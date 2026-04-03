/**
 * @file index.tsx
 * @description Entry point for the React-based conflict resolver web client.
 */

import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { injectStyles } from './styles';
import * as logger from '../../../core/src';

// Use server-provided theme (via data-theme attribute on #root) so loading and app boot with the same palette.
const rootEl = document.getElementById('root');
const dataTheme = rootEl?.getAttribute('data-theme');
const initialTheme: 'dark' | 'light' =
    dataTheme === 'dark' || dataTheme === 'light'
        ? dataTheme
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

injectStyles(initialTheme);

// Mount the React app
if (rootEl) {
    const root = createRoot(rootEl);
    root.render(<App />);
} else {
    logger.error('[MergeNB] Root container not found');
}
