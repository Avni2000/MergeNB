declare module '*.ipynb' {
    const value: import('../../../packages/core/src/types').Notebook;
    export default value;
}
