/**
 * @file index.tsx
 * @description Entry point for the React-based conflict resolver web client.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectStyles } from './styles';

declare global {
    interface Window {
        __MERGENB_INITIAL_THEME?: 'dark' | 'light';
    }
}

// Use server-provided theme first so loading and app boot with the same palette.
const initialTheme =
    window.__MERGENB_INITIAL_THEME ??
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

injectStyles(initialTheme);

// Mount the React app
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
} else {
    console.error('[MergeNB] Root container not found');
}
