/**
 * @file index.tsx
 * @description Entry point for the React-based conflict resolver web client.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectStyles } from './styles';

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
    console.error('[MergeNB] Root container not found');
}
