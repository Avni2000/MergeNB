
// Mock vscode module for testing
const vscode = {
    Uri: {
        parse: (url) => ({
            toString: () => url,
            fsPath: url
        }),
        file: (f) => ({
            fsPath: f,
            scheme: 'file',
            toString: () => `file://${f}`
        }),
        joinPath: (uri, ...fragments) => ({
            fsPath: uri.fsPath + '/' + fragments.join('/'),
            toString: () => uri.toString() + '/' + fragments.join('/')
        })
    },
    env: {
        openExternal: async (url) => {
            console.log('[Mock VSCode] Opening external URL:', url);
            return true;
        }
    },
    EventEmitter: class {
        constructor() { this.listeners = []; }
        event(listener) { this.listeners.push(listener); }
        fire(data) { this.listeners.forEach(l => l(data)); }
    },
    Range: class { constructor(start, end) { } },
    Position: class { constructor(line, char) { } },
    workspace: {
        fs: {
            readFile: async () => new Uint8Array()
        }
    }
};

module.exports = vscode;
