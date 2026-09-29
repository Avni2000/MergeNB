import React, { useEffect, useRef, useState } from 'react';
import { OutputModel, RenderMimeRegistry, standardRendererFactories } from '@jupyterlab/rendermime';
import { Widget } from '@lumino/widgets';
import DOMPurify from 'dompurify';
import { normalizeMimeValue, normalizeCellSource as normalizeTextValue, type CellOutput } from '../../../../core/src';
import * as logger from '../../../../core/src';
import { getCurrentSessionCredentials, createNotebookAssetResolver } from '../utils/notebookAssets';

type RenderMimeOutputValue = ConstructorParameters<typeof OutputModel>[0]['value'];

interface CellOutputsProps {
    outputs: CellOutput[];
    isTrusted?: boolean;
    isLightweight?: boolean;
}

export function CellOutputs({ outputs, isTrusted = false, isLightweight = false }: CellOutputsProps): React.ReactElement {
    if (isLightweight) {
        return (
            <div className="cell-outputs">
                {outputs.map((output, i) => (
                    <pre key={i} className="cell-output-fallback">{getOutputTextFallback(output)}</pre>
                ))}
            </div>
        );
    }
    return (
        <div className="cell-outputs">
            {outputs.map((output, i) => (
                <RenderMimeOutput key={i} output={output} isTrusted={isTrusted} />
            ))}
        </div>
    );
}

function RenderMimeOutput({ output, isTrusted }: { output: CellOutput; isTrusted: boolean }): React.ReactElement {
    const hostRef = useRef<HTMLDivElement>(null);
    const [fallback, setFallback] = useState<string | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !host.isConnected) return;
        host.replaceChildren();
        setFallback(null);

        const renderMimeRegistry = getRenderMimeRegistry();
        let disposed = false;
        let renderer: ReturnType<RenderMimeRegistry['createRenderer']> | null = null;
        let model: OutputModel | null = null;

        try {
            const normalizedOutput = normalizeOutputForRenderMime(output, isTrusted) as RenderMimeOutputValue;

            const untrustedModel = new OutputModel({
                value: normalizedOutput,
                trusted: false,
            });

            const preferredMimeType = renderMimeRegistry.preferredMimeType(untrustedModel.data, 'any');
            if (!preferredMimeType) {
                setFallback(getOutputTextFallback(output));
                untrustedModel.dispose();
                return;
            }

            const trusted = shouldTrustOutputMimeType(preferredMimeType, isTrusted);
            if (trusted) {
                // Jupyter's HTML renderer evaluates inline scripts for trusted output.
                // Outside a trusted session, only SVG is trusted (to avoid rendermime's
                // "Cannot display an untrusted SVG" fallback) - HTML and other rich
                // outputs stay untrusted so embedded scripts don't run.
                untrustedModel.dispose();
                model = new OutputModel({
                    value: normalizedOutput,
                    trusted: true,
                });
            } else {
                model = untrustedModel;
            }

            renderer = renderMimeRegistry.createRenderer(preferredMimeType);

            Widget.attach(renderer, host);

            void renderer.renderModel(model).catch((err: unknown) => {
                logger.warn('[MergeNB] Failed to render output via rendermime:', err);
                if (!disposed) {
                    disposeRenderer(renderer, host);
                    renderer = null;
                    model?.dispose();
                    model = null;
                    setFallback(getOutputTextFallback(output));
                }
            });
        } catch (err) {
            logger.warn('[MergeNB] Failed to initialize rendermime output model:', err);
            setFallback(getOutputTextFallback(output));
            disposeRenderer(renderer, host);
            model?.dispose();
            return;
        }

        return () => {
            disposed = true;
            disposeRenderer(renderer, host);
            model?.dispose();
            host.replaceChildren();
        };
    }, [output, isTrusted]);

    return (
        <div className="cell-output-item">
            <div className="cell-output-host" ref={hostRef} />
            {fallback && <pre className="cell-output-fallback">{fallback}</pre>}
        </div>
    );
}

function normalizeOutputForRenderMime(output: CellOutput, isTrusted: boolean): Record<string, unknown> {
    const normalizedOutput = { ...(output as unknown as Record<string, unknown>) };

    if (output.text !== undefined) {
        normalizedOutput.text = normalizeTextValue(output.text);
    }

    if (output.data) {
        const normalizedData: Record<string, unknown> = {};
        for (const [mimeType, value] of Object.entries(output.data)) {
            let normalizedValue = normalizeMimeValue(mimeType, value);
            // Trusted sessions skip sanitization entirely so rendermime's own trusted
            // renderer runs the SVG (and its embedded scripts, if any) as authored.
            if (mimeType === 'image/svg+xml' && typeof normalizedValue === 'string' && !isTrusted) {
                normalizedValue = DOMPurify.sanitize(normalizedValue, { USE_PROFILES: { svg: true } });
            }
            normalizedData[mimeType] = normalizedValue;
        }
        normalizedOutput.data = normalizedData;
    }

    return normalizedOutput;
}

function getOutputTextFallback(output: CellOutput): string {
    if (output.output_type === 'stream' && output.text) {
        return normalizeTextValue(output.text);
    }

    if (output.output_type === 'error') {
        if (Array.isArray(output.traceback)) {
            return output.traceback.join('\n');
        }

        const errorParts = [output.ename, output.evalue]
            .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
        return errorParts.length > 0 ? errorParts.join(': ') : 'Error';
    }

    if ((output.output_type === 'display_data' || output.output_type === 'execute_result') && output.data) {
        const plainText = output.data['text/plain'];
        if (plainText !== undefined) {
            return String(normalizeMimeValue('text/plain', plainText));
        }
    }

    return '[Unsupported output]\n' + JSON.stringify(output, null, 2);
}

function shouldTrustOutputMimeType(mimeType: string, isTrusted: boolean): boolean {
    // Untrusted sessions only trust SVG (needed for rendermime's SVG renderer to run at
    // all). Trusted sessions extend that to every mimetype, mirroring classic Jupyter's
    // per-notebook trust model - rich outputs (text/html, etc.) may run embedded scripts.
    if (isTrusted) return true;
    return mimeType === 'image/svg+xml';
}

// Session credentials come from window.location and never change within a page,
// so one registry serves the whole session.
let renderMimeRegistry: RenderMimeRegistry | null = null;

function getRenderMimeRegistry(): RenderMimeRegistry {
    if (!renderMimeRegistry) {
        const { sessionId, token } = getCurrentSessionCredentials();
        renderMimeRegistry = new RenderMimeRegistry({
            initialFactories: standardRendererFactories,
            resolver: createNotebookAssetResolver(sessionId, token),
        });
    }
    return renderMimeRegistry;
}

function disposeRenderer(
    renderer: ReturnType<RenderMimeRegistry['createRenderer']> | null,
    host: HTMLElement
): void {
    if (!renderer) return;

    try {
        if (renderer.isAttached && renderer.node.isConnected) {
            Widget.detach(renderer);
        } else if (renderer.node.parentElement === host) {
            host.removeChild(renderer.node);
        }
    } catch (err) {
        logger.warn('[MergeNB] Failed to detach rendermime renderer:', err);
        if (renderer.node.parentElement === host) {
            host.removeChild(renderer.node);
        }
    }

    try {
        renderer.dispose();
    } catch (err) {
        logger.warn('[MergeNB] Failed to dispose rendermime renderer:', err);
    }
}

