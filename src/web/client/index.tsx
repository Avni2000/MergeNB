/**
 * @file index.tsx
 * @description Entry point for the React-based conflict resolver web client.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectStyles } from './styles';

// Inject styles into the document
injectStyles();

// Mount the React app
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
} else {
    console.error('[MergeNB] Root container not found');
}
