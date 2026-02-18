declare module 'katex/contrib/auto-render' {
    export interface AutoRenderDelimiter {
        left: string;
        right: string;
        display: boolean;
    }

    export interface AutoRenderOptions {
        delimiters?: AutoRenderDelimiter[];
        throwOnError?: boolean;
        ignoredTags?: string[];
        ignoredClasses?: string[];
        macros?: Record<string, string>;
    }

    export default function renderMathInElement(
        element: HTMLElement,
        options?: AutoRenderOptions
    ): void;
}
